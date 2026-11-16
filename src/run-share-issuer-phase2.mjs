// KYC-gated real-estate share issuer, Phase 2 (holder onboarding), per docs/share-issuer-spec.md.
// Usage:
//   node src/run-share-issuer-phase2.mjs <phase1-run-dir> <phase1-3-run-dir>
// Testnet only. Seeds and keys go to runs/ only. Nothing is committed.
//
// PROOF CHOICE (decided here, not in the spec):
// Signed selective disclosure with Ed25519 (node:crypto). No circuit, no trusted setup.
// Attestor A signs salted digests of holder claims. The holder reveals only the claims the policy needs.
// The verifier P checks the signature, the holder binding, the disclosed digests, and the policy.
// This is NOT zero-knowledge. P sees the disclosed claims (over18, country). The document number stays hidden.
// Circom and snarkjs are not used in v1. The zero-knowledge path is deferred (see spec Open items).
//
// K is the mock KYC issuer from Phase 1.3. Its seed is read from that run.
// The issuer I is the Phase 1 issuer.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
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
const ALLOWED_COUNTRIES = ['IT']
const MODE = 'phase2-onboarding'

const [p1Arg, p13Arg] = process.argv.slice(2)
if (!p1Arg || !p13Arg) {
  console.error('usage: node src/run-share-issuer-phase2.mjs <phase1-run-dir> <phase1-3-run-dir>')
  process.exit(3)
}
const p1run = JSON.parse(fs.readFileSync(path.join(p1Arg, 'run.json'), 'utf8'))
const p1wallets = JSON.parse(fs.readFileSync(path.join(p1Arg, 'wallets.json'), 'utf8'))
const p13wallets = JSON.parse(fs.readFileSync(path.join(p13Arg, 'wallets.json'), 'utf8'))
const ID = p1run.mptIssuanceID
const I = Wallet.fromSeed(p1wallets.issuer)
const K = Wallet.fromSeed(p13wallets.kycIssuer)
if (I.address !== p1run.issuer) throw new Error('issuer seed does not match phase 1 run')

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, mptIssuanceID: ID, issuer: I.address, kycIssuer: K.address, steps: [], checks: [] }
const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  log.checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  save()
  if (!ok) throw new Error(`stop on FAIL: ${name}`)
}

// ---- Selective disclosure (proof P) ----
const digest = (salt, name, value) =>
  crypto.createHash('sha256').update(`${salt}|${name}|${JSON.stringify(value)}`).digest('hex')

// Attestor A signs the digests and binds them to the holder address.
function attest(attestorPriv, holder, claims) {
  const disclosures = Object.entries(claims).map(([name, value]) => ({
    name, value, salt: crypto.randomBytes(16).toString('hex')
  }))
  const payloadStr = JSON.stringify({
    sub: holder,
    alg: 'ed25519',
    digests: disclosures.map((d) => digest(d.salt, d.name, d.value)).sort()
  })
  const sig = crypto.sign(null, Buffer.from(payloadStr), attestorPriv).toString('base64')
  return { payloadStr, sig, disclosures }
}

// Holder reveals only the named claims.
function present(att, reveal) {
  // Copy each disclosure. A tampered copy must not change the attestation for later checks.
  return { payloadStr: att.payloadStr, sig: att.sig, revealed: att.disclosures.filter((d) => reveal.includes(d.name)).map((d) => ({ ...d })) }
}

// Verifier P. Returns { ok, reason }.
function verifyPresentation(attestorPub, holder, pres) {
  if (!crypto.verify(null, Buffer.from(pres.payloadStr), attestorPub, Buffer.from(pres.sig, 'base64'))) {
    return { ok: false, reason: 'bad signature' }
  }
  const payload = JSON.parse(pres.payloadStr)
  if (payload.sub !== holder) return { ok: false, reason: 'holder binding mismatch' }
  const names = pres.revealed.map((d) => d.name)
  if (new Set(names).size !== names.length) return { ok: false, reason: 'duplicate claim' }
  for (const d of pres.revealed) {
    if (!payload.digests.includes(digest(d.salt, d.name, d.value))) return { ok: false, reason: `digest not signed: ${d.name}` }
  }
  const get = (n) => pres.revealed.find((d) => d.name === n)?.value
  if (get('over18') !== true) return { ok: false, reason: 'over18 not proven' }
  if (!ALLOWED_COUNTRIES.includes(get('country'))) return { ok: false, reason: 'country not allowed' }
  return { ok: true, reason: 'pass' }
}

// ---- Replay defense (design approved 2026-11-16) ----
// Verifier P issues a nonce and an expiry. The holder signs both, with a hash of the presentation.
// P accepts each nonce once. A reused or expired challenge fails.
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const presHash = (pres) => crypto.createHash('sha256').update(pres.payloadStr + '|' + pres.sig).digest('hex')

function issueChallenge(now = Date.now()) {
  return { nonce: crypto.randomBytes(16).toString('hex'), expiry: now + CHALLENGE_TTL_MS, used: false }
}

// Holder signs the challenge and the presentation with the holder's own Ed25519 key.
function holderRespond(holderPriv, ch, pres) {
  const msg = JSON.stringify({ nonce: ch.nonce, expiry: ch.expiry, presentation: presHash(pres) })
  return { msg, sig: crypto.sign(null, Buffer.from(msg), holderPriv).toString('base64') }
}

// Verifier P. Consumes the nonce on every attempt, pass or fail.
function verifyFresh(attestorPub, holderPub, holder, ch, pres, response, now = Date.now()) {
  if (ch.used) return { ok: false, reason: 'replay: nonce already used' }
  ch.used = true
  if (now > ch.expiry) return { ok: false, reason: 'challenge expired' }
  const expected = JSON.stringify({ nonce: ch.nonce, expiry: ch.expiry, presentation: presHash(pres) })
  if (response.msg !== expected) return { ok: false, reason: 'holder response does not match challenge' }
  if (!crypto.verify(null, Buffer.from(response.msg), holderPub, Buffer.from(response.sig, 'base64'))) {
    return { ok: false, reason: 'bad holder signature' }
  }
  return verifyPresentation(attestorPub, holder, pres)
}

// Throwaway input self-test (offline). Must pass before any ledger step.
function selfTest(attestorPriv, attestorPub) {
  const h = 'rSelfTestHolder'
  const att = attest(attestorPriv, h, { over18: true, country: 'IT', docNumber: 'XX000001' })
  const cases = [
    ['valid presentation passes', verifyPresentation(attestorPub, h, present(att, ['over18', 'country'])).ok === true],
    ['hidden claim is not revealed', present(att, ['over18']).revealed.every((d) => d.name !== 'docNumber')],
    ['wrong holder fails', verifyPresentation(attestorPub, 'rOther', present(att, ['over18', 'country'])).ok === false],
    ['tampered country fails', (() => { const p = present(att, ['over18', 'country']); p.revealed[1].value = 'FR'; return verifyPresentation(attestorPub, h, p).ok === false })()],
    ['tampered payload fails', (() => { const p = present(att, ['over18', 'country']); p.payloadStr = p.payloadStr + ' '; return verifyPresentation(attestorPub, h, p).ok === false })()],
    ['over18 false fails', (() => { const a2 = attest(attestorPriv, h, { over18: false, country: 'IT' }); return verifyPresentation(attestorPub, h, present(a2, ['over18', 'country'])).ok === false })()]
  ]
  for (const [name, ok] of cases) check(`selftest: ${name}`, ok)

  // Replay cases. Holder key is a throwaway key for this self-test only.
  const hk = crypto.generateKeyPairSync('ed25519')
  const otherKey = crypto.generateKeyPairSync('ed25519')
  const pres = present(att, ['over18', 'country'])
  const ch1 = issueChallenge()
  const resp1 = holderRespond(hk.privateKey, ch1, pres)
  const first = verifyFresh(attestorPub, hk.publicKey, h, ch1, pres, resp1)
  const second = verifyFresh(attestorPub, hk.publicKey, h, ch1, pres, resp1)
  const ch2 = issueChallenge()
  const crossNonce = verifyFresh(attestorPub, hk.publicKey, h, ch2, pres, resp1)
  const ch3 = issueChallenge(Date.now() - 2 * CHALLENGE_TTL_MS)
  const expired = verifyFresh(attestorPub, hk.publicKey, h, ch3, pres, holderRespond(hk.privateKey, ch3, pres))
  const ch4 = issueChallenge()
  const badKey = verifyFresh(attestorPub, hk.publicKey, h, ch4, pres, holderRespond(otherKey.privateKey, ch4, pres))
  const replayCases = [
    ['fresh challenge passes', first.ok === true],
    ['reused presentation fails (replay)', second.ok === false && second.reason.startsWith('replay')],
    ['old presentation with new nonce fails', crossNonce.ok === false],
    ['expired challenge fails', expired.ok === false && expired.reason === 'challenge expired'],
    ['wrong holder key fails', badKey.ok === false]
  ]
  for (const [name, ok] of replayCases) check(`selftest: replay: ${name}`, ok)
}

// ---- Ledger helpers ----
async function submit(client, tx, wallet, label) {
  const res = await client.submitAndWait(tx, { wallet, autofill: true })
  const code = res.result.meta.TransactionResult
  const hash = res.result.hash
  log.steps.push({ label, result: code, hash, explorer: `${EXPLORER}/transactions/${hash}` })
  console.log(`${code === 'tesSUCCESS' ? 'ok  ' : 'ERR '} ${label} ${code} ${EXPLORER}/transactions/${hash}`)
  save()
  return { code, hash }
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

async function exists(fn) {
  try { await fn(); return true } catch { return false }
}

async function main() {
  // Offline self-test first. No ledger writes before it passes.
  const attestorKeys = crypto.generateKeyPairSync('ed25519')
  const attestorPriv = attestorKeys.privateKey
  const attestorPub = attestorKeys.publicKey
  selfTest(attestorPriv, attestorPub)
  // Holder keys sign replay challenges. Stored in keys.json only.
  const hk1 = crypto.generateKeyPairSync('ed25519')
  const hk2 = crypto.generateKeyPairSync('ed25519')

  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (${MODE}), run dir ${runDir}`)

  const pre = await client.request({ command: 'ledger_entry', mpt_issuance: ID, ledger_index: 'validated' })
  check('pre: issuance exists', pre.result.node.MaximumAmount !== undefined, `Max=${pre.result.node.MaximumAmount}`)

  const H1 = await fundAccount(client, 'Holder1')
  const H2 = await fundAccount(client, 'Holder2')
  fs.writeFileSync(path.join(runDir, 'wallets.json'), JSON.stringify({ holder1: H1.seed, holder2: H2.seed }, null, 2))
  fs.writeFileSync(path.join(runDir, 'keys.json'), JSON.stringify({
    attestorPrivatePem: attestorPriv.export({ type: 'pkcs8', format: 'pem' }),
    attestorPublicPem: attestorPub.export({ type: 'spki', format: 'pem' }),
    holder1PrivatePem: hk1.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    holder2PrivatePem: hk2.privateKey.export({ type: 'pkcs8', format: 'pem' })
  }, null, 2))
  log.holders = { H1: H1.address, H2: H2.address }

  // Attestor issues claims. H1 passes. H2 fails (over18 false). Document number is never revealed.
  const attH1 = attest(attestorPriv, H1.address, { over18: true, country: 'IT', docNumber: 'XX111111' })
  const attH2 = attest(attestorPriv, H2.address, { over18: false, country: 'IT', docNumber: 'XX222222' })

  // 2.1 P issues a nonce and expiry per holder. Each holder signs the challenge with the holder key.
  const ch1 = issueChallenge()
  const ch2 = issueChallenge()
  const pres1 = present(attH1, ['over18', 'country'])
  const pres2 = present(attH2, ['over18', 'country'])
  const r1 = verifyFresh(attestorPub, hk1.publicKey, H1.address, ch1, pres1, holderRespond(hk1.privateKey, ch1, pres1))
  const r2 = verifyFresh(attestorPub, hk2.publicKey, H2.address, ch2, pres2, holderRespond(hk2.privateKey, ch2, pres2))
  const reuse1 = verifyFresh(attestorPub, hk1.publicKey, H1.address, ch1, pres1, holderRespond(hk1.privateKey, ch1, pres1))
  check('2.1 P passes H1', r1.ok === true, r1.reason)
  check('2.1 P fails H2', r2.ok === false, r2.reason)
  check('2.1 P rejects reused H1 presentation', reuse1.ok === false, reuse1.reason)
  log.proofResults = { H1: r1, H2: r2, H1Reuse: reuse1 }

  // 2.2 H1 passes. K issues the Credential.
  await submit(client, { TransactionType: 'CredentialCreate', Account: K.address, Subject: H1.address, CredentialType: CRED_TYPE }, K, 'CredentialCreate (K to H1)')
  // 2.3 H1 accepts the Credential, then opts in.
  await submit(client, { TransactionType: 'CredentialAccept', Account: H1.address, Issuer: K.address, CredentialType: CRED_TYPE }, H1, 'CredentialAccept (H1)')
  const cred = await client.request({ command: 'ledger_entry', credential: { subject: H1.address, issuer: K.address, credential_type: CRED_TYPE }, ledger_index: 'validated' })
  check('2.3 credential accepted on ledger', (cred.result.node?.Flags & LSF_ACCEPTED) !== 0, `Flags=${cred.result.node?.Flags}`)
  await submit(client, { TransactionType: 'MPTokenAuthorize', Account: H1.address, MPTokenIssuanceID: ID }, H1, 'MPTokenAuthorize H1 opt-in')

  // 2.4 I checks the Credential, then authorizes H1.
  const credCheck = await client.request({ command: 'ledger_entry', credential: { subject: H1.address, issuer: K.address, credential_type: CRED_TYPE }, ledger_index: 'validated' })
  check('2.4 issuer sees accepted credential for H1', (credCheck.result.node?.Flags & LSF_ACCEPTED) !== 0)
  await submit(client, { TransactionType: 'MPTokenAuthorize', Account: I.address, MPTokenIssuanceID: ID, Holder: H1.address }, I, 'MPTokenAuthorize issuer for H1')
  const tok1 = await fetchMPToken(client, H1.address, ID)
  check('2.4 H1 holds an MPToken for the issuance', !!tok1, `MPTAmount=${tok1.MPTAmount ?? 0}`)

  // 2.5 H2 fails. K does not issue. I does not authorize.
  const h2Cred = await exists(() => client.request({ command: 'ledger_entry', credential: { subject: H2.address, issuer: K.address, credential_type: CRED_TYPE }, ledger_index: 'validated' }))
  check('2.5 no credential for H2', h2Cred === false)
  const h2Tok = await exists(() => fetchMPToken(client, H2.address, ID))
  check('2.5 no MPToken for H2 (issuer did not authorize)', h2Tok === false)

  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS (Phase 2). run dir: ${runDir}`)
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
