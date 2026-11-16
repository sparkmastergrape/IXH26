// KYC-gated real-estate share issuer. Runs the whole v1 chain on testnet in one command.
// Usage:
//   node src/run-share-issuer-chain.mjs
// Order: Phase 0 (rehearsal), 1, 1.3, 2, 3, 3.4, 4. Then the read-only ledger check.
// Stops at the first step that exits non-zero or whose run.json is not PASS.
// Testnet only. Seeds and keys stay in runs/. Nothing is committed.

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// dirs: earlier step names whose run folders this step needs, in argument order.
const STEPS = [
  { name: 'phase0', script: 'src/run-share-issuer.mjs', args: ['--rehearsal'], dirs: [] },
  { name: 'phase1', script: 'src/run-share-issuer-phase1.mjs', dirs: [] },
  { name: 'phase1-3', script: 'src/run-share-issuer-phase1-3.mjs', dirs: ['phase1'] },
  { name: 'phase2', script: 'src/run-share-issuer-phase2.mjs', dirs: ['phase1', 'phase1-3'] },
  { name: 'phase3', script: 'src/run-share-issuer-phase3.mjs', dirs: ['phase1', 'phase2'] },
  { name: 'phase3-positive', script: 'src/run-share-issuer-phase3-positive.mjs', dirs: ['phase1', 'phase2', 'phase1-3'] },
  { name: 'phase4', script: 'src/run-share-issuer-phase4.mjs', dirs: ['phase1', 'phase2'] }
]

const runDirs = {}

function stop(message) {
  console.error(`\nSTOP: ${message}`)
  process.exit(1)
}

for (const step of STEPS) {
  const args = [step.script, ...(step.args ?? []), ...step.dirs.map((d) => path.join(ROOT, runDirs[d]))]
  console.log(`\n=== ${step.name} ===`)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  process.stdout.write(r.stdout ?? '')
  process.stderr.write(r.stderr ?? '')
  if (r.status !== 0) stop(`${step.name} exited with ${r.status}`)

  const m = (r.stdout ?? '').match(/connected to .*? run dir (\S+)/)
  if (!m) stop(`${step.name} printed no run dir`)
  runDirs[step.name] = m[1]

  const log = JSON.parse(fs.readFileSync(path.join(ROOT, m[1], 'run.json'), 'utf8'))
  if (log.result !== 'PASS') stop(`${step.name} run.json result is ${log.result}`)
}

console.log('\n=== independent ledger check ===')
const v = spawnSync(process.execPath, [
  'src/verify-share-issuer-chain.mjs',
  ...Object.values(runDirs).map((d) => path.join(ROOT, d))
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
process.stdout.write(v.stdout ?? '')
process.stderr.write(v.stderr ?? '')
if (v.status !== 0) stop(`ledger check exited with ${v.status}`)

console.log('\nCHAIN PASS')
for (const [name, dir] of Object.entries(runDirs)) console.log(`  ${name.padEnd(16)} ${dir}`)
