// KYC-gated real-estate share issuer. Independent ledger check for one chain.
// Usage:
//   node src/verify-share-issuer-chain.mjs <run-dir> [<run-dir> ...]
// Pass the run folders of one chain, in any order. Each folder is classified by its run.json mode.
// Read-only. Makes no ledger writes. Writes runs/<stamp>-verify/verify.json.
// Exit 0 only when every check passes.

import fs from 'fs'
import path from 'path'
import { Client, convertStringToHex, fetchMPToken } from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const CRED_TYPE = convertStringToHex('KYCVERIFIED')
const LSF_ACCEPTED = 0x00010000
const ISSUANCE_FLAGS = 102 // RequireAuth 4, CanClawback 64, CanLock 2, CanTransfer 32
// Expected end state of the v1 chain. Amounts come from the scripted steps:
// Phase 1.3 batch 100000. Phase 3 sends 1000 and pays out 50 to H1. Phase 3.4 sends 100 from H1 to H2.
// Phase 4 claws back H1 in full (950 at that point).
const EXPECTED = { operational: 100000n, H1: 0n, H2: 100n, outstanding: 100100n, maximum: 1000000n, fee: 0 }

const dirs = process.argv.slice(2).map((d) => path.resolve(d))
if (dirs.length === 0) {
  console.error('usage: node src/verify-share-issuer-chain.mjs <run-dir> [<run-dir> ...]')
  process.exit(3)
}

const runs = dirs.map((dir) => ({ dir, log: JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) }))
const byMode = (mode) => runs.find((r) => r.log.mode === mode)?.log

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true, detail: String(detail) })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
}

async function balanceOf(client, account, issuanceId) {
  try {
    const tok = await fetchMPToken(client, account, issuanceId)
    return BigInt(tok.MPTAmount ?? 0)
  } catch (e) {
    // No MPToken object means no balance. Any other error is a real failure.
    if (e?.data?.error === 'entryNotFound') return 0n
    throw e
  }
}

async function main() {
  const p0 = byMode('phase0-rehearsal')
  const p1 = byMode('phase1-issuance')
  const p13 = byMode('phase1-3-operational-batch')
  const p2 = byMode('phase2-onboarding')
  const p3 = byMode('phase3-transfers')
  const p3p = byMode('phase3-positive-transfer')
  const p4 = byMode('phase4-compliance')

  check('chain: phase 1 folder present', !!p1)
  check('chain: phase 1.3 folder present', !!p13)
  check('chain: phase 2 folder present', !!p2)
  check('chain: phase 3 folder present', !!p3)
  check('chain: phase 3.4 folder present', !!p3p)
  check('chain: phase 4 folder present', !!p4)
  if (!p1 || !p13 || !p2) {
    finish()
    return
  }

  for (const r of runs) check(`run result PASS: ${r.log.mode}`, r.log.result === 'PASS', r.log.result)

  const ID = p1.mptIssuanceID
  const issuer = p1.issuer
  const O = p13.operational
  const { H1, H2 } = p2.holders
  const K = p2.kycIssuer

  const client = new Client(WS)
  await client.connect()
  console.log(`connected to ${WS} (read-only)`)

  // Every recorded transaction must exist on the ledger with the same result.
  for (const r of runs) {
    for (const s of r.log.steps) {
      if (!s.hash) {
        check(`tx has hash: ${r.log.mode} ${s.label}`, false, 'no hash recorded, cannot look up')
        continue
      }
      try {
        const tx = await client.request({ command: 'tx', transaction: s.hash })
        const code = tx.result.meta.TransactionResult
        check(`tx on ledger: ${s.label}`, code === s.result && tx.result.validated === true, `ledger=${code} log=${s.result}`)
      } catch (e) {
        check(`tx on ledger: ${s.label}`, false, String(e?.message ?? e))
      }
    }
  }

  // Issuance state.
  const iss = (await client.request({ command: 'ledger_entry', mpt_issuance: ID, ledger_index: 'validated' })).result.node
  check('issuance flags are 102', (iss.Flags & ISSUANCE_FLAGS) === ISSUANCE_FLAGS && iss.Flags === ISSUANCE_FLAGS, `Flags=${iss.Flags}`)
  check('issuance transfer fee is 0', Number(iss.TransferFee ?? 0) === EXPECTED.fee, `TransferFee=${iss.TransferFee ?? 0}`)
  check('issuance maximum is 1000000', BigInt(iss.MaximumAmount) === EXPECTED.maximum, `MaximumAmount=${iss.MaximumAmount}`)
  check('issuance outstanding is 100100', BigInt(iss.OutstandingAmount) === EXPECTED.outstanding, `OutstandingAmount=${iss.OutstandingAmount}`)

  // Balances, read from the ledger.
  const bO = await balanceOf(client, O, ID)
  const bH1 = await balanceOf(client, H1, ID)
  const bH2 = await balanceOf(client, H2, ID)
  check('balance operational O is 100000', bO === EXPECTED.operational, `O=${bO}`)
  check('balance H1 is 0 after clawback', bH1 === EXPECTED.H1, `H1=${bH1}`)
  check('balance H2 is 100 after transfer', bH2 === EXPECTED.H2, `H2=${bH2}`)
  check('balances sum to outstanding', bO + bH1 + bH2 === BigInt(iss.OutstandingAmount), `sum=${bO + bH1 + bH2} outstanding=${iss.OutstandingAmount}`)

  // Credentials. Each holder with a balance must hold an accepted credential from K.
  for (const [label, addr] of [['O', O], ['H1', H1], ['H2', H2]]) {
    try {
      const c = (await client.request({ command: 'ledger_entry', credential: { subject: addr, issuer: K, credential_type: CRED_TYPE }, ledger_index: 'validated' })).result.node
      check(`credential accepted for ${label}`, (c.Flags & LSF_ACCEPTED) !== 0, `Flags=${c.Flags}`)
    } catch (e) {
      check(`credential accepted for ${label}`, false, String(e?.data?.error ?? e?.message ?? e))
    }
  }

  // The issuer holds no MPTs. Burned tokens never sit on the issuer account.
  const bIssuer = await balanceOf(client, issuer, ID)
  check('issuer holds no MPTs', bIssuer === 0n, `issuer=${bIssuer}`)

  await client.disconnect()
  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join('runs', `${stamp}-verify`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'verify.json'), JSON.stringify({ network: WS, runs: dirs, results, result: failed.length === 0 ? 'PASS' : 'FAIL' }, null, 2))
  console.log(`\n${failed.length === 0 ? 'RESULT PASS' : `RESULT FAIL (${failed.length} checks)`}  verify dir: ${outDir}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('verify crashed:', e?.message ?? e)
  process.exit(1)
})
