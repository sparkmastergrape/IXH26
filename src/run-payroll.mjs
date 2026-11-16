// Devnet confidential payroll build, per payroll-spec v2.
// Usage:
//   node src/run-payroll.mjs --rehearsal   (Phase 0: throwaway issuance, small amounts)
//   node src/run-payroll.mjs               (Phases 1 to 3: real run)
//   add --with-clawback                    (Phase 4: lock and claw back staff 1)
// Devnet only. Seeds and keys go to runs/ (gitignored). Nothing is committed.

import fs from 'fs'
import path from 'path'
import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  convertStringToHex,
  deriveConfidentialKeypair,
  encodeMPTokenMetadata,
  fetchMPToken,
  fetchMPTokenIssuance,
  loadMptCrypto,
  prepareConfidentialConvert,
  prepareConfidentialMergeInbox,
  prepareConfidentialSend,
  prepareConfidentialClawback
} from 'xrpl'

const WS = 'wss://s.devnet.rippletest.net:51233'
const FAUCET = 'https://faucet.devnet.rippletest.net/accounts'
const EXPLORER = 'https://devnet.xrpl.org'
const TICKER = 'CTST'
const CRED_TYPE = convertStringToHex('PAYROLL')

const REHEARSAL = process.argv.includes('--rehearsal')
const WITH_CLAWBACK = process.argv.includes('--with-clawback')
const MODE = REHEARSAL ? 'rehearsal' : 'real'

// Pay schedule. Rehearsal uses small amounts.
const PAYROLL = REHEARSAL
  ? [{ name: 'Staff1', amount: 10n }, { name: 'Staff2', amount: 20n }, { name: 'Staff3', amount: 30n }]
  : [{ name: 'Staff1', amount: 1000n }, { name: 'Staff2', amount: 1500n }, { name: 'Staff3', amount: 2000n }]
const TOTAL = PAYROLL.reduce((a, p) => a + p.amount, 0n)

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, steps: [], checks: [] }
const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  log.checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  save()
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

async function readSpending(crypto, client, holder, mptIssuanceID, privateKey) {
  const token = await fetchMPToken(client, holder, mptIssuanceID)
  const issuance = await fetchMPTokenIssuance(client, mptIssuanceID)
  const supply = BigInt(issuance.ConfidentialOutstandingAmount)
  return crypto.decryptAmount(token.ConfidentialBalanceSpending, privateKey, supply)
}

async function readAuditor(crypto, client, holder, mptIssuanceID, auditorPriv) {
  const token = await fetchMPToken(client, holder, mptIssuanceID)
  const issuance = await fetchMPTokenIssuance(client, mptIssuanceID)
  const supply = BigInt(issuance.ConfidentialOutstandingAmount)
  return crypto.decryptAmount(token.AuditorEncryptedBalance, auditorPriv, supply)
}

async function main() {
  const crypto = await loadMptCrypto()
  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (${MODE}), run dir ${runDir}`)

  // Phase 1 setup: accounts.
  const I = await fundAccount(client, 'Issuer')
  const E = await fundAccount(client, 'Employer')
  const C = await fundAccount(client, 'CredentialIssuer')
  const S = []
  for (const p of PAYROLL) S.push({ name: p.name, amount: p.amount, wallet: await fundAccount(client, p.name) })

  // Keys. P4 decision: auditor yes.
  const keys = {
    issuer: deriveConfidentialKeypair(),
    auditor: deriveConfidentialKeypair(),
    employer: deriveConfidentialKeypair(),
    staff: S.map((s) => ({ name: s.name, keys: deriveConfidentialKeypair() }))
  }
  fs.writeFileSync(path.join(runDir, 'keys.json'), JSON.stringify(keys, null, 2))
  fs.writeFileSync(path.join(runDir, 'wallets.json'), JSON.stringify({
    issuer: I.seed,
    employer: E.seed,
    credentialIssuer: C.seed,
    staff: S.map((s) => ({ name: s.name, seed: s.wallet.seed }))
  }, null, 2))

  // Phase 1.1 create MPT issuance with the spec flags, fee 0.
  const create = await submit(client, {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: I.address,
    AssetScale: 0,
    MaximumAmount: '1000000000',
    TransferFee: 0,
    Flags: MPTokenIssuanceCreateFlags.tfMPTCanHoldConfidentialBalance | MPTokenIssuanceCreateFlags.tfMPTCanTransfer | MPTokenIssuanceCreateFlags.tfMPTCanClawback | MPTokenIssuanceCreateFlags.tfMPTCanLock,
    MPTokenMetadata: encodeMPTokenMetadata({
      ticker: TICKER,
      name: `Payroll ${MODE}`,
      desc: 'Devnet confidential payroll test token',
      icon: 'https://example.org/payroll-icon.png',
      asset_class: 'rwa',
      issuer_name: 'Devnet test issuer'
    })
  }, I, 'MPTokenIssuanceCreate')
  const id = create.meta.mpt_issuance_id
  log.mptIssuanceID = id
  check('issuance created', create.code === 'tesSUCCESS' && !!id, id)

  // Phase 1.2 register issuer and auditor keys in one transaction.
  const setKeys = await submit(client, {
    TransactionType: 'MPTokenIssuanceSet',
    Account: I.address,
    MPTokenIssuanceID: id,
    IssuerEncryptionKey: keys.issuer.publicKey,
    AuditorEncryptionKey: keys.auditor.publicKey
  }, I, 'MPTokenIssuanceSet keys')
  check('issuer and auditor keys registered', setKeys.code === 'tesSUCCESS')

  // Public authorization and funding. Employer first, then issuer pays public MPT.
  const auth = (wallet, label) => submit(client, { TransactionType: 'MPTokenAuthorize', Account: wallet.address, MPTokenIssuanceID: id }, wallet, `MPTokenAuthorize ${label}`)
  await auth(E, 'Employer')
  const fund = await submit(client, { TransactionType: 'Payment', Account: I.address, Destination: E.address, Amount: { mpt_issuance_id: id, value: TOTAL.toString() } }, I, 'Payment issuer to employer (public)')
  check('employer funded with public MPT', fund.code === 'tesSUCCESS')

  // Phase 1.4 employer converts the payroll total. Phase 1.5 merges the inbox.
  const conv = await submit(client, await prepareConfidentialConvert(client, { account: E.address, mptIssuanceID: id, amount: TOTAL, holderKeypair: keys.employer }), E, 'ConfidentialMPTConvert employer')
  check('employer convert succeeded', conv.code === 'tesSUCCESS')
  const mergeE = await submit(client, await prepareConfidentialMergeInbox(client, { account: E.address, mptIssuanceID: id }), E, 'ConfidentialMPTMergeInbox employer')
  check('employer inbox merged', mergeE.code === 'tesSUCCESS')

  // Phase 1.6 each staff member authorizes and registers a key with a zero convert.
  for (let i = 0; i < S.length; i++) {
    await auth(S[i].wallet, S[i].name)
    const z = await submit(client, await prepareConfidentialConvert(client, { account: S[i].wallet.address, mptIssuanceID: id, amount: 0n, holderKeypair: keys.staff[i].keys }), S[i].wallet, `ConfidentialMPTConvert zero ${S[i].name}`)
    check(`${S[i].name} key registered`, z.code === 'tesSUCCESS')
  }

  // Phase 2.1 credential from C to E. E accepts.
  const credCreate = await submit(client, { TransactionType: 'CredentialCreate', Account: C.address, Subject: E.address, CredentialType: CRED_TYPE }, C, 'CredentialCreate')
  const credAccept = await submit(client, { TransactionType: 'CredentialAccept', Account: E.address, Issuer: C.address, CredentialType: CRED_TYPE }, E, 'CredentialAccept')
  check('credential issued and accepted', credCreate.code === 'tesSUCCESS' && credAccept.code === 'tesSUCCESS')
  const credEntry = await client.request({ command: 'ledger_entry', credential: { subject: E.address, issuer: C.address, credential_type: CRED_TYPE } })
  const credID = credEntry.result.index
  log.credentialID = credID

  // Phase 2.2 payroll sends in sequence. One retry per send.
  for (let i = 0; i < S.length; i++) {
    const build = () => prepareConfidentialSend(client, {
      account: E.address,
      destination: S[i].wallet.address,
      mptIssuanceID: id,
      amount: S[i].amount,
      senderKeypair: keys.employer,
      credentialIDs: [credID]
    })
    let sent = await submit(client, await build(), E, `ConfidentialMPTSend ${S[i].name}`)
    if (sent.code !== 'tesSUCCESS') {
      console.log(`retry ${S[i].name} after ${sent.code}`)
      sent = await submit(client, await build(), E, `ConfidentialMPTSend ${S[i].name} retry`)
    }
    check(`send to ${S[i].name}`, sent.code === 'tesSUCCESS')
    if (i === 0 && sent.code === 'tesSUCCESS') {
      const tx = JSON.stringify(sent.res.result.tx_json ?? sent.res.result)
      check('public tx has no plaintext Amount field', !/"Amount"/.test(tx))
    }
    if (sent.code !== 'tesSUCCESS') break
  }

  // Phase 2.3 staff merge inbox.
  for (let i = 0; i < S.length; i++) {
    const m = await submit(client, await prepareConfidentialMergeInbox(client, { account: S[i].wallet.address, mptIssuanceID: id }), S[i].wallet, `ConfidentialMPTMergeInbox ${S[i].name}`)
    check(`${S[i].name} inbox merged`, m.code === 'tesSUCCESS')
  }

  // Phase 3 reading results. Each staff member reads own pay. Auditor reads each pay.
  let auditorTotal = 0n
  for (let i = 0; i < S.length; i++) {
    const own = await readSpending(crypto, client, S[i].wallet.address, id, keys.staff[i].keys.privateKey)
    check(`${S[i].name} reads own pay`, own === S[i].amount, `expected ${S[i].amount} got ${own}`)
    const aud = await readAuditor(crypto, client, S[i].wallet.address, id, keys.auditor.privateKey)
    check(`auditor reads ${S[i].name}`, aud === S[i].amount, `expected ${S[i].amount} got ${aud}`)
    auditorTotal += aud
  }
  const employerLeft = await readSpending(crypto, client, E.address, id, keys.employer.privateKey)
  check('employer balance after run is zero', employerLeft === 0n, `left ${employerLeft}`)
  check('auditor total equals payroll total', auditorTotal === TOTAL, `total ${auditorTotal}`)

  // Phase 4 optional clawback of staff 1.
  if (WITH_CLAWBACK) {
    await submit(client, { TransactionType: 'MPTokenIssuanceSet', Account: I.address, MPTokenIssuanceID: id, Holder: S[0].wallet.address, Flags: MPTokenIssuanceSetFlags.tfMPTLock }, I, 'Lock staff1')
    const cb = await submit(client, await prepareConfidentialClawback(client, { account: I.address, holder: S[0].wallet.address, mptIssuanceID: id, issuerKeypair: keys.issuer }), I, 'ConfidentialMPTClawback staff1')
    check('clawback succeeded', cb.code === 'tesSUCCESS')
    const after = await readSpending(crypto, client, S[0].wallet.address, id, keys.staff[0].keys.privateKey)
    check('staff1 reads zero after clawback', after === 0n, `got ${after}`)
  }

  const ok = log.checks.every((c) => c.ok)
  log.result = ok ? 'PASS' : 'FAIL'
  save()
  console.log(`\nRESULT ${log.result}  run dir: ${runDir}`)
  await client.disconnect()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  log.error = String(e?.stack ?? e)
  save()
  console.error('ERROR', e?.message ?? e)
  process.exit(2)
})
