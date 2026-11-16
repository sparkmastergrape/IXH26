// KYC-gated real-estate share issuer, Phase 3 positive test (transfer after H2 is authorized).
// Usage:
//   node src/run-share-issuer-phase3-positive.mjs <phase1-run-dir> <phase2-run-dir>
// Testnet only. Seeds and keys stay in runs/. Nothing is committed.
//
// Phase 2 refused H2 with a failing proof. This run is a second attestation for H2 with a passing claim.
// H2 then goes through the full path: proof, K credential, credential accept, opt-in, issuer authorization.
// Only then does H1 send shares to H2. The earlier Phase 2 refusal stays on record.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Client, Wallet, MPTokenIssuanceCreateFlags, convertStringToHex, fetchMPToken } from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const FAUCET = 'https://faucet.altnet.rippletest.net/accounts'
const EXPLORER = 'https://testnet.xrpl.org'
const CRED_TYPE = convertStringToHex('KYCVERIFIED')
const LSF_ACCEPTED = 0x00010000
const ALLOWED_COUNTRIES = ['IT']
const SEND = 100n
const MODE = 'phase3-positive-transfer'

const [p1Arg, p2Arg] = process.argv.slice(2)
if (!p1Arg || !p2Arg) {
  console.error('usage: node src/run-share-issuer-phase3-positive.mjs <phase1-run-dir> <phase2-run-dir>')
  process.exit(3)
}
const p1run = JSON.parse(fs.readFileSync(path.join(p1Arg, 'run.json'), 'utf8'))
const p1wallets = JSON.parse(fs.readFileSync(path.join(p1Arg, 'wallets.json'), 'utf8'))
const p2wallets = JSON.parse(fs.readFileSync(path.join(p2Arg, 'wallets.json'), 'utf8'))
const p2keys = JSON.parse(fs.readFileSync(path.join(p2Arg, 'keys.json'), 'utf8'))
const p13wallets = JSON.parse(fs.readFileSync(path.join('runs', '2026-11-16T04-51-19-986Z-phase1-3-operational-batch', 'wallets.json'), 'utf8'))
const ID = p1run.mptIssuanceID
const I = Wallet.fromSeed(p1wallets.issuer)
const K = Wallet.fromSeed(p13wallets.kycIssuer)
const H1 = Wallet.fromSeed(p2wallets.holder1)
const H2 = Wallet.fromSeed(p2wallets.holder2)
const attestorPriv = crypto.createPrivateKey(p2keys.attestorPrivatePem)
const attestorPub = crypto.createPublicKey(p2keys.attestorPublicPem)

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, mptIssuanceID: ID, holders: { H1: H1.address, H2: H2.address }, steps: [], checks: [] }
const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  log.checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  save()
  if (!ok) throw new Error(`stop on FAIL: ${name}`)
}

// ---- Selective disclosure (same scheme as Phase 2) ----
const digest = (salt, name, value) =>
  crypto.createHash('sha256').update(`${salt}|${name}|${JSON.stringify(value)}`).digest('hex')

function attest(holder, claims) {
  const disclosures = Object.entries(claims).map(([name, value]) => ({ name, value, salt: crypto.randomBytes(16).toString('hex') }))
  const payloadStr = JSON.stringify({ sub: holder, alg: 'ed25519', digests: disclosures.map((d) => digest(d.salt, d.name, d.value)).sort() })
  const sig = crypto.sign(null, Buffer.from(payloadStr), attestorPriv).toString('base64')
  return { payloadStr, sig, disclosures }
}

function present(att, reveal) {
  return { payloadStr: att.payloadStr, sig: att.sig, revealed: att.disclosures.filter((d) => reveal.includes(d.name)) }
}

function verifyPresentation(holder, pres) {
  if (!crypto.verify(null, Buffer.from(pres.payloadStr), attestorPub, Buffer.from(pres.sig, 'base64'))) return { ok: false, reason: 'bad signature' }
  const payload = JSON.parse(pres.payloadStr)
  if (payload.sub !== holder) return { ok: false, reason: 'holder binding mismatch' }
  for (const d of pres.revealed) {
    if (!payload.digests.includes(digest(d.salt, d.name, d.value))) return { ok: false, reason: `digest not signed: ${d.name}` }
  }
  const get = (n) => pres.revealed.find((d) => d.name === n)?.value
  if (get('over18') !== true) return { ok: false, reason: 'over18 not proven' }
  if (!ALLOWED_COUNTRIES.includes(get('country'))) return { ok: false, reason: 'country not allowed' }
  return { ok: true, reason: 'pass' }
}

// ---- Ledger helpers ----
async function submit(client, tx, wallet, label) {
  const res = await client.submitAndWait(tx, { wallet, autofill: true })
  const code = res.result.meta.TransactionResult
  const hash = res.result.hash
  log.steps.push({ label, result: code, hash, explorer: `${EXPLORER}/transactions/${hash}` })
  console.log(`${code === 'tesSUCCESS' ? 'ok  ' : 'ERR '} ${label} ${code} ${EXPLORER}/transactions/${hash}`)
  save()
  return code
}

async function submitCode(client, tx, wallet, label) {
  let code, hash
  try {
    const res = await client.submitAndWait(tx, { wallet, autofill: true })
    code = res.result.meta.TransactionResult
    hash = res.result.hash
  } catch (e) {
    code = e?.data?.meta?.TransactionResult ?? e?.data?.error ?? `ERR:${e?.message}`
    hash = e?.data?.hash ?? null
  }
  log.steps.push({ label, result: code, hash, explorer: hash ? `${EXPLORER}/transactions/${hash}` : null })
  console.log(`${code === 'tesSUCCESS' ? 'ok  ' : 'res '} ${label} ${code}${hash ? ` ${EXPLORER}/transactions/${hash}` : ''}`)
  save()
  return code
}

async function fundAccount(client, label) {
  const wallet = Wallet.generate()
  const r = await fetch(FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: wallet.address }) })
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

async function balance(client, holder) {
  try {
    const tok = await fetchMPToken(client, holder, ID)
    return BigInt(tok.MPTAmount ?? 0)
  } catch {
    return null
  }
}

async function main() {
  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (${MODE}), run dir ${runDir}`)

  // Pre-state from Phase 3: H1 holds 1050. H2 has no MPToken.
  check('pre: H1 holds 1050 from Phase 3', (await balance(client, H1.address)) === 1050n, `H1=${await balance(client, H1.address)}`)
  check('pre: H2 has no MPToken', (await balance(client, H2.address)) === null)

  // New attestation for H2 with a passing claim. Verified before any ledger write.
  const att = attest(H2.address, { over18: true, country: 'IT', docNumber: 'XX333333' })
  const r = verifyPresentation(H2.address, present(att, ['over18', 'country']))
  check('proof: P passes H2 on the new attestation', r.ok === true, r.reason)

  // Full H2 path.
  await submit(client, { TransactionType: 'CredentialCreate', Account: K.address, Subject: H2.address, CredentialType: CRED_TYPE }, K, 'CredentialCreate (K to H2)')
  await submit(client, { TransactionType: 'CredentialAccept', Account: H2.address, Issuer: K.address, CredentialType: CRED_TYPE }, H2, 'CredentialAccept (H2)')
  const cred = await client.request({ command: 'ledger_entry', credential: { subject: H2.address, issuer: K.address, credential_type: CRED_TYPE }, ledger_index: 'validated' })
  check('H2 credential accepted on ledger', (cred.result.node?.Flags & LSF_ACCEPTED) !== 0, `Flags=${cred.result.node?.Flags}`)
  await submit(client, { TransactionType: 'MPTokenAuthorize', Account: H2.address, MPTokenIssuanceID: ID }, H2, 'MPTokenAuthorize H2 opt-in')
  await submit(client, { TransactionType: 'MPTokenAuthorize', Account: I.address, MPTokenIssuanceID: ID, Holder: H2.address }, I, 'MPTokenAuthorize issuer for H2')
  check('H2 holds an MPToken after authorization', (await balance(client, H2.address)) === 0n)

  // Positive transfer: H1 to H2.
  const c = await submitCode(client, { TransactionType: 'Payment', Account: H1.address, Destination: H2.address, Amount: { mpt_issuance_id: ID, value: SEND.toString() } }, H1, 'Payment H1 to authorized H2')
  check('transfer to authorized H2 succeeds', c === 'tesSUCCESS', c)
  check('H1 balance reduced by send', (await balance(client, H1.address)) === 1050n - SEND, `H1=${await balance(client, H1.address)}`)
  check('H2 balance equals send', (await balance(client, H2.address)) === SEND, `H2=${await balance(client, H2.address)}`)

  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS (Phase 3 positive). run dir: ${runDir}`)
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
