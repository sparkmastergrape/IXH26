// KYC-gated real-estate share issuer, Phase 4 (compliance actions, stretch), per docs/share-issuer-spec.md.
// Usage:
//   node src/run-share-issuer-phase4.mjs <phase1-run-dir> <phase2-run-dir>
// Testnet only. Seeds and keys stay in runs/. Nothing is committed.
// Pre-state is read from the ledger. Nothing is assumed.
// 4.1 I locks H1 (MPTokenIssuanceSet, Holder H1, tfMPTLock).
// 4.2 H1 tries to send shares to H2. The send must fail while H1 is locked.
// 4.3 I claws back H1 for the full balance. The balance must read zero.

import fs from 'fs'
import path from 'path'
import { Client, Wallet, fetchMPToken, MPTokenIssuanceCreateFlags } from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const EXPLORER = 'https://testnet.xrpl.org'
const MODE = 'phase4-compliance'
const TF_MPT_LOCK = 0x00000001 // MPTokenIssuanceSet tfMPTLock. Also the lsfMPTLocked bit on MPToken.
const LSF_MPT_LOCKED = 0x00000001
const SEND_TRY = 100n

const [p1Arg, p2Arg] = process.argv.slice(2)
if (!p1Arg || !p2Arg) {
  console.error('usage: node src/run-share-issuer-phase4.mjs <phase1-run-dir> <phase2-run-dir>')
  process.exit(3)
}
const p1run = JSON.parse(fs.readFileSync(path.join(p1Arg, 'run.json'), 'utf8'))
const p1wallets = JSON.parse(fs.readFileSync(path.join(p1Arg, 'wallets.json'), 'utf8'))
const p2wallets = JSON.parse(fs.readFileSync(path.join(p2Arg, 'wallets.json'), 'utf8'))
const ID = p1run.mptIssuanceID
const I = Wallet.fromSeed(p1wallets.issuer)
const H1 = Wallet.fromSeed(p2wallets.holder1)
const H2 = Wallet.fromSeed(p2wallets.holder2)
if (I.address !== p1run.issuer) throw new Error('issuer seed does not match phase 1 run')

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, mptIssuanceID: ID, holders: { H1: H1.address, H2: H2.address }, steps: [], checks: [] }
const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))

function check(name, ok, detail = '') {
  log.checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  save()
  if (!ok) throw new Error(`stop on FAIL: ${name}`)
}

// Returns the transaction result code. Handles both success and tec results.
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

async function mptoken(client, holder) {
  try {
    return await fetchMPToken(client, holder, ID)
  } catch {
    return null // no MPToken object
  }
}

async function balance(client, holder) {
  const tok = await mptoken(client, holder)
  return tok === null ? null : BigInt(tok.MPTAmount ?? 0)
}

async function issuance(client) {
  const r = await client.request({ command: 'ledger_entry', mpt_issuance: ID, ledger_index: 'validated' })
  return r.result.node
}

async function main() {
  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (${MODE}), run dir ${runDir}`)

  // Pre-state from the ledger.
  const iss0 = await issuance(client)
  check('pre: issuance has CanLock and CanClawback', (iss0.Flags & MPTokenIssuanceCreateFlags.tfMPTCanLock) !== 0 && (iss0.Flags & MPTokenIssuanceCreateFlags.tfMPTCanClawback) !== 0, `Flags=${iss0.Flags}`)
  const h1Bal0 = await balance(client, H1.address)
  check('pre: H1 holds 950 from Phase 3 positive', h1Bal0 === 950n, `H1=${h1Bal0}`)
  const h2Bal0 = await balance(client, H2.address)
  check('pre: H2 holds 100 from Phase 3 positive', h2Bal0 === 100n, `H2=${h2Bal0}`)
  const tok0 = await mptoken(client, H1.address)
  check('pre: H1 is not locked', tok0 !== null && ((tok0.Flags ?? 0) & LSF_MPT_LOCKED) === 0, `H1 MPToken Flags=${tok0?.Flags}`)
  const out0 = BigInt(iss0.OutstandingAmount ?? 0)
  check('pre: outstanding equals O batch plus H1 plus H2', out0 === 100000n + h1Bal0 + h2Bal0, `Outstanding=${out0}`)

  // 4.1 I locks H1.
  const c41 = await submitCode(client, {
    TransactionType: 'MPTokenIssuanceSet', Account: I.address,
    MPTokenIssuanceID: ID, Holder: H1.address, Flags: TF_MPT_LOCK
  }, I, 'MPTokenIssuanceSet lock H1 (4.1)')
  check('4.1 lock succeeded', c41 === 'tesSUCCESS', c41)
  const tok1 = await mptoken(client, H1.address)
  check('4.1 H1 MPToken carries lock flag on ledger', tok1 !== null && ((tok1.Flags ?? 0) & LSF_MPT_LOCKED) !== 0, `H1 MPToken Flags=${tok1?.Flags}`)

  // 4.2 H1 tries to send shares to H2 while locked. Must fail.
  const c42 = await submitCode(client, {
    TransactionType: 'Payment', Account: H1.address, Destination: H2.address,
    Amount: { mpt_issuance_id: ID, value: SEND_TRY.toString() }
  }, H1, 'Payment H1 to H2 while H1 locked (4.2)')
  check('4.2 send from locked H1 fails', c42 !== 'tesSUCCESS', c42)
  check('4.2 H1 balance unchanged after failed send', (await balance(client, H1.address)) === h1Bal0, `H1=${await balance(client, H1.address)}`)
  check('4.2 H2 balance unchanged after failed send', (await balance(client, H2.address)) === h2Bal0, `H2=${await balance(client, H2.address)}`)

  // 4.3 I claws back H1 for the full balance.
  const c43 = await submitCode(client, {
    TransactionType: 'Clawback', Account: I.address, Holder: H1.address,
    Amount: { mpt_issuance_id: ID, value: h1Bal0.toString() }
  }, I, 'Clawback H1 full balance (4.3)')
  check('4.3 clawback succeeded', c43 === 'tesSUCCESS', c43)
  const h1Bal1 = await balance(client, H1.address)
  check('4.3 H1 balance reads zero (no object or 0)', h1Bal1 === null || h1Bal1 === 0n, `H1=${h1Bal1}`)
  const iss1 = await issuance(client)
  const out1 = BigInt(iss1.OutstandingAmount ?? 0)
  check('4.3 outstanding fell by clawed amount', out1 === out0 - h1Bal0, `Outstanding=${out1} expected=${out0 - h1Bal0}`)
  check('4.3 H2 balance unchanged by clawback', (await balance(client, H2.address)) === h2Bal0, `H2=${await balance(client, H2.address)}`)

  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS (Phase 4). run dir: ${runDir}`)
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
