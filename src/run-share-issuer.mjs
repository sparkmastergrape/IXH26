// KYC-gated real-estate share issuer, per docs/share-issuer-spec.md (v1).
// Usage:
//   node src/run-share-issuer.mjs --rehearsal   (Phase 0: throwaway issuance on testnet)
// Phase 0 only. Phases 1 to 4 have their own scripts (see docs/share-issuer-spec.md and src/).
// Testnet only. Seeds and keys go to runs/ (gitignored). Nothing is committed.

import fs from 'fs'
import path from 'path'
import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  convertStringToHex,
  encodeMPTokenMetadata,
  fetchMPToken
} from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const FAUCET = 'https://faucet.altnet.rippletest.net/accounts'
const EXPLORER = 'https://testnet.xrpl.org'
const TICKER = 'RHSH'
const CRED_TYPE = convertStringToHex('KYCVERIFIED')
const LSF_ACCEPTED = 0x00010000

const REHEARSAL = process.argv.includes('--rehearsal')
if (!REHEARSAL) {
  console.error('Only --rehearsal (Phase 0) is implemented. Phase 1 needs a go-ahead.')
  process.exit(3)
}
const MODE = 'phase0-rehearsal'

const TEST_AMOUNT = 10n

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, steps: [], checks: [] }
const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  log.checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  save()
  if (!ok) {
    throw new Error(`stop on FAIL: ${name}`)
  }
}

async function submit(client, tx, wallet, label) {
  const res = await client.submitAndWait(tx, { wallet, autofill: true })
  const code = res.result.meta.TransactionResult
  const hash = res.result.hash
  log.steps.push({ label, result: code, hash, explorer: `${EXPLORER}/transactions/${hash}` })
  console.log(`${code === 'tesSUCCESS' ? 'ok  ' : 'ERR '} ${label} ${code} ${EXPLORER}/transactions/${hash}`)
  save()
  return { code, hash, meta: res.result.meta, res }
}

async function fundAccount(client, label) {
  const wallet = Wallet.generate()
  const r = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destination: wallet.address })
  })
  if (!r.ok) throw new Error(`faucet failed for ${label}: HTTP ${r.status}`)
  for (let i = 0; i < 40; i++) {
    try {
      await client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' })
      console.log(`funded ${label} ${wallet.address}`)
      return wallet
    } catch {
      await sleep(2000)
    }
  }
  throw new Error(`account ${label} never validated`)
}

async function main() {
  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (${MODE}), run dir ${runDir}`)

  const amend = await client.request({
    command: 'ledger_entry',
    index: '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4',
    ledger_index: 'validated'
  })
  check('testnet Amendments object readable', !!amend.result.node, `ledger ${amend.result.ledger_index}`)

  // Accounts: I (issuer), K (KYC issuer, mock), H1 (holder).
  const I = await fundAccount(client, 'Issuer')
  const K = await fundAccount(client, 'KYCIssuer')
  const H1 = await fundAccount(client, 'Holder1')

  // Seeds go to runs/ only. Never printed.
  fs.writeFileSync(path.join(runDir, 'wallets.json'), JSON.stringify({
    issuer: I.seed, kycIssuer: K.seed, holder1: H1.seed
  }, null, 2))

  // 0.1 Throwaway MPT. Flags: CanClawback, CanLock, RequireAuth, plus CanTransfer for holder-to-holder moves. Fee 0.
  const flags = MPTokenIssuanceCreateFlags.tfMPTCanTransfer |
    MPTokenIssuanceCreateFlags.tfMPTCanClawback |
    MPTokenIssuanceCreateFlags.tfMPTCanLock |
    MPTokenIssuanceCreateFlags.tfMPTRequireAuth
  const create = await submit(client, {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: I.address,
    AssetScale: 0,
    MaximumAmount: '1000000',
    TransferFee: 0,
    Flags: flags,
    MPTokenMetadata: encodeMPTokenMetadata({
      ticker: TICKER,
      name: 'Rehearsal share',
      desc: 'Throwaway rehearsal issuance, testnet',
      icon: 'https://example.org/rehearsal-icon.png',
      asset_class: 'rwa',
      asset_subclass: 'real_estate',
      issuer_name: 'Rehearsal issuer'
    })
  }, I, 'MPTokenIssuanceCreate')
  const id = create.meta.mpt_issuance_id
  log.mptIssuanceID = id
  check('0.1 issuance created', create.code === 'tesSUCCESS' && !!id, id)

  // Confirm flags on the ledger.
  const iss = await client.request({ command: 'ledger_entry', mpt_issuance: id, ledger_index: 'validated' })
  const ledgerFlags = iss.result.node.Flags
  check('0.1 flags set on ledger',
    (ledgerFlags & MPTokenIssuanceCreateFlags.tfMPTRequireAuth) !== 0 &&
    (ledgerFlags & MPTokenIssuanceCreateFlags.tfMPTCanClawback) !== 0 &&
    (ledgerFlags & MPTokenIssuanceCreateFlags.tfMPTCanLock) !== 0,
    `Flags=${ledgerFlags}`)
  check('0.1 transfer fee is 0', (iss.result.node.TransferFee ?? 0) === 0, `TransferFee=${iss.result.node.TransferFee ?? 0}`)

  // 0.2 K issues a test Credential to H1.
  const credCreate = await submit(client, {
    TransactionType: 'CredentialCreate', Account: K.address, Subject: H1.address, CredentialType: CRED_TYPE
  }, K, 'CredentialCreate (K to H1)')
  check('0.2 credential created', credCreate.code === 'tesSUCCESS')

  // 0.3 H1 accepts the Credential.
  const credAccept = await submit(client, {
    TransactionType: 'CredentialAccept', Account: H1.address, Issuer: K.address, CredentialType: CRED_TYPE
  }, H1, 'CredentialAccept (H1)')
  check('0.3 credential accepted', credAccept.code === 'tesSUCCESS')

  // 0.4 H1 opts in with MPTokenAuthorize (holder-signed).
  const h1Opt = await submit(client, {
    TransactionType: 'MPTokenAuthorize', Account: H1.address, MPTokenIssuanceID: id
  }, H1, 'MPTokenAuthorize H1 opt-in')
  check('0.4 holder opt-in succeeded', h1Opt.code === 'tesSUCCESS')

  // 0.5 I checks the Credential on the ledger, then authorizes H1.
  const credEntry = await client.request({
    command: 'ledger_entry',
    credential: { subject: H1.address, issuer: K.address, credential_type: CRED_TYPE },
    ledger_index: 'validated'
  })
  const credNode = credEntry.result.node
  check('0.5 credential on ledger and accepted',
    !!credNode && (credNode.Flags & LSF_ACCEPTED) !== 0,
    `Flags=${credNode?.Flags}`)

  const iAuth = await submit(client, {
    TransactionType: 'MPTokenAuthorize', Account: I.address, MPTokenIssuanceID: id, Holder: H1.address
  }, I, 'MPTokenAuthorize issuer for H1')
  check('0.5 issuer authorized H1', iAuth.code === 'tesSUCCESS')

  // 0.6 I pays H1 a test share amount. Confirm the balance.
  const pay = await submit(client, {
    TransactionType: 'Payment',
    Account: I.address,
    Destination: H1.address,
    Amount: { mpt_issuance_id: id, value: TEST_AMOUNT.toString() }
  }, I, 'Payment issuer to H1')
  check('0.6 payment succeeded', pay.code === 'tesSUCCESS')

  const tok = await fetchMPToken(client, H1.address, id)
  const bal = BigInt(tok.MPTAmount ?? 0)
  check('0.6 H1 balance equals test amount', bal === TEST_AMOUNT, `balance=${bal}`)

  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS  run dir: ${runDir}`)
  await client.disconnect()
}

main().catch(async (e) => {
  log.result = 'FAIL'
  log.error = String(e?.message ?? e)
  save()
  console.error('\nRESULT FAIL', e?.message ?? e)
  console.error(`run dir: ${runDir}`)
  process.exit(1)
})
