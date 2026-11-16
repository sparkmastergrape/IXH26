// KYC-gated real-estate share issuer, Phase 3 (transfers and payouts), per docs/share-issuer-spec.md.
// Usage:
//   node src/run-share-issuer-phase3.mjs <phase1-run-dir> <phase2-run-dir>
// Testnet only. Seeds stay in runs/. Nothing is committed.
// 3.1 I sends shares to H1.
// 3.2 H1 tries to send shares to H2. H2 is not authorized, so the transfer must fail.
// 3.3 I sends a test payout to H1.

import fs from 'fs'
import path from 'path'
import { Client, Wallet, fetchMPToken } from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const EXPLORER = 'https://testnet.xrpl.org'
const MODE = 'phase3-transfers'
const SHARE_SEND = 1000n
const TRANSFER_TRY = 100n
const PAYOUT = 50n

const [p1Arg, p2Arg] = process.argv.slice(2)
if (!p1Arg || !p2Arg) {
  console.error('usage: node src/run-share-issuer-phase3.mjs <phase1-run-dir> <phase2-run-dir>')
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
const log = { mode: MODE, network: WS, mptIssuanceID: ID, steps: [], checks: [] }
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

async function balance(client, holder) {
  try {
    const tok = await fetchMPToken(client, holder, ID)
    return BigInt(tok.MPTAmount ?? 0)
  } catch {
    return null // no MPToken object
  }
}

async function main() {
  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (${MODE}), run dir ${runDir}`)

  const pre = await client.request({ command: 'ledger_entry', mpt_issuance: ID, ledger_index: 'validated' })
  check('pre: outstanding equals Phase 1.3 batch', String(pre.result.node.OutstandingAmount) === '100000', `Outstanding=${pre.result.node.OutstandingAmount}`)
  check('pre: H1 holds no shares yet', (await balance(client, H1.address)) === 0n, `H1=${await balance(client, H1.address)}`)

  // 3.1 I sends shares to H1.
  const c31 = await submitCode(client, {
    TransactionType: 'Payment', Account: I.address, Destination: H1.address,
    Amount: { mpt_issuance_id: ID, value: SHARE_SEND.toString() }
  }, I, 'Payment issuer to H1 (3.1)')
  check('3.1 payment succeeded', c31 === 'tesSUCCESS', c31)
  check('3.1 H1 balance equals send', (await balance(client, H1.address)) === SHARE_SEND, `H1=${await balance(client, H1.address)}`)

  // 3.2 H1 sends shares to H2. H2 is not authorized. Must fail.
  const c32 = await submitCode(client, {
    TransactionType: 'Payment', Account: H1.address, Destination: H2.address,
    Amount: { mpt_issuance_id: ID, value: TRANSFER_TRY.toString() }
  }, H1, 'Payment H1 to unauthorized H2 (3.2)')
  check('3.2 transfer to unauthorized H2 fails', c32 !== 'tesSUCCESS', c32)
  check('3.2 H1 balance unchanged', (await balance(client, H1.address)) === SHARE_SEND, `H1=${await balance(client, H1.address)}`)
  check('3.2 H2 has no MPToken', (await balance(client, H2.address)) === null)

  // 3.3 I sends a test payout to H1.
  const c33 = await submitCode(client, {
    TransactionType: 'Payment', Account: I.address, Destination: H1.address,
    Amount: { mpt_issuance_id: ID, value: PAYOUT.toString() }
  }, I, 'Payment issuer to H1 payout (3.3)')
  check('3.3 payout succeeded', c33 === 'tesSUCCESS', c33)
  check('3.3 H1 balance equals send plus payout', (await balance(client, H1.address)) === SHARE_SEND + PAYOUT, `H1=${await balance(client, H1.address)}`)

  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS (Phase 3). run dir: ${runDir}`)
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
