// KYC-gated real-estate share issuer, Phase 1.3 (first batch to an operational account).
// Usage:
//   node src/run-share-issuer-phase1-3.mjs <phase1-run-dir>
// Example: node src/run-share-issuer-phase1-3.mjs runs/2026-11-16T04-28-38-871Z-phase1-issuance
// Testnet only. Seeds go to runs/ only. Nothing is committed.
// The issuer cannot hold MPTs, so the batch goes to operational account O.
// O is a holder. It is onboarded through a mock KYC issuer K, same path as Phase 0.
// No proof step here. Phase 2 adds the proof. This is operator-controlled.

import fs from 'fs'
import path from 'path'
import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  convertStringToHex,
  fetchMPToken
} from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const FAUCET = 'https://faucet.altnet.rippletest.net/accounts'
const EXPLORER = 'https://testnet.xrpl.org'
const CRED_TYPE = convertStringToHex('KYCVERIFIED')
const LSF_ACCEPTED = 0x00010000
const BATCH = 100000n
const MODE = 'phase1-3-operational-batch'

const phase1Dir = process.argv[2]
if (!phase1Dir) {
  console.error('usage: node src/run-share-issuer-phase1-3.mjs <phase1-run-dir>')
  process.exit(3)
}
const p1run = JSON.parse(fs.readFileSync(path.join(phase1Dir, 'run.json'), 'utf8'))
const p1wallets = JSON.parse(fs.readFileSync(path.join(phase1Dir, 'wallets.json'), 'utf8'))
const ID = p1run.mptIssuanceID
const I = Wallet.fromSeed(p1wallets.issuer)
if (I.address !== p1run.issuer) throw new Error('issuer seed does not match phase 1 run')

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, mptIssuanceID: ID, issuer: I.address, steps: [], checks: [] }
const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  log.checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  save()
  if (!ok) throw new Error(`stop on FAIL: ${name}`)
}

async function submit(client, tx, wallet, label) {
  const res = await client.submitAndWait(tx, { wallet, autofill: true })
  const code = res.result.meta.TransactionResult
  const hash = res.result.hash
  log.steps.push({ label, result: code, hash, explorer: `${EXPLORER}/transactions/${hash}` })
  console.log(`${code === 'tesSUCCESS' ? 'ok  ' : 'ERR '} ${label} ${code} ${EXPLORER}/transactions/${hash}`)
  save()
  return { code, hash, meta: res.result.meta }
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

  // Pre-check: issuance exists, nothing outstanding.
  const pre = await client.request({ command: 'ledger_entry', mpt_issuance: ID, ledger_index: 'validated' })
  check('pre: issuance exists with RequireAuth', (pre.result.node.Flags & MPTokenIssuanceCreateFlags.tfMPTRequireAuth) !== 0, `Flags=${pre.result.node.Flags}`)
  check('pre: nothing outstanding', String(pre.result.node.OutstandingAmount ?? '0') === '0', `OutstandingAmount=${pre.result.node.OutstandingAmount ?? '0'}`)

  const O = await fundAccount(client, 'OperationalAccount')
  const K = await fundAccount(client, 'KYCIssuer')
  fs.writeFileSync(path.join(runDir, 'wallets.json'), JSON.stringify({ operational: O.seed, kycIssuer: K.seed }, null, 2))
  log.operational = O.address

  // Onboard O through the mock KYC path.
  await submit(client, { TransactionType: 'CredentialCreate', Account: K.address, Subject: O.address, CredentialType: CRED_TYPE }, K, 'CredentialCreate (K to O)')
  await submit(client, { TransactionType: 'CredentialAccept', Account: O.address, Issuer: K.address, CredentialType: CRED_TYPE }, O, 'CredentialAccept (O)')
  const cred = await client.request({ command: 'ledger_entry', credential: { subject: O.address, issuer: K.address, credential_type: CRED_TYPE }, ledger_index: 'validated' })
  check('credential on ledger and accepted', (cred.result.node?.Flags & LSF_ACCEPTED) !== 0, `Flags=${cred.result.node?.Flags}`)

  await submit(client, { TransactionType: 'MPTokenAuthorize', Account: O.address, MPTokenIssuanceID: ID }, O, 'MPTokenAuthorize O opt-in')
  await submit(client, { TransactionType: 'MPTokenAuthorize', Account: I.address, MPTokenIssuanceID: ID, Holder: O.address }, I, 'MPTokenAuthorize issuer for O')

  // Batch to O.
  const pay = await submit(client, {
    TransactionType: 'Payment', Account: I.address, Destination: O.address,
    Amount: { mpt_issuance_id: ID, value: BATCH.toString() }
  }, I, 'Payment issuer to operational account (first batch)')
  check('payment succeeded', pay.code === 'tesSUCCESS')

  const tok = await fetchMPToken(client, O.address, ID)
  check('O balance equals batch', BigInt(tok.MPTAmount ?? 0) === BATCH, `balance=${tok.MPTAmount}`)

  const post = await client.request({ command: 'ledger_entry', mpt_issuance: ID, ledger_index: 'validated' })
  check('outstanding equals batch', BigInt(post.result.node.OutstandingAmount ?? 0) === BATCH, `OutstandingAmount=${post.result.node.OutstandingAmount}`)

  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS (1.3). run dir: ${runDir}`)
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
