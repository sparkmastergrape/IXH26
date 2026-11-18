// KYC-gated real-estate share issuer, Phase 1 (issuance), per docs/share-issuer-spec.md.
// Usage:
//   node src/run-share-issuer-phase1.mjs
// Testnet only. Seeds go to runs/ only. Nothing is committed.
// Runs 1.1 (create MPT) and 1.2 (confirm flags on the ledger).
// Step 1.3 is not in this script. It runs in src/run-share-issuer-phase1-3.mjs, to operational account O.
// An issuer cannot hold its own MPTs (xrpl.org MPT docs, Core Properties). A Payment to the issuer burns the tokens.
// OutstandingAmount is the supply in circulation. MaximumAmount caps it (xrpl.org, Migrating from Trust Line Tokens to MPTs, Amounts and fees).

import fs from 'fs'
import path from 'path'
import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  encodeMPTokenMetadata
} from 'xrpl'

const WS = 'wss://s.altnet.rippletest.net:51233'
const FAUCET = 'https://faucet.altnet.rippletest.net/accounts'
const EXPLORER = 'https://testnet.xrpl.org'
const TICKER = 'RHSH'
const MAX_AMOUNT = '1000000'
const MODE = 'phase1-issuance'

const runDir = path.join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`)
fs.mkdirSync(runDir, { recursive: true })
const log = { mode: MODE, network: WS, steps: [], checks: [] }
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

  const I = await fundAccount(client, 'Issuer')
  fs.writeFileSync(path.join(runDir, 'wallets.json'), JSON.stringify({ issuer: I.seed }, null, 2))
  log.issuer = I.address

  // 1.1 Create the real MPT. Same flags as Phase 0. Fee 0.
  const flags = MPTokenIssuanceCreateFlags.tfMPTCanTransfer |
    MPTokenIssuanceCreateFlags.tfMPTCanClawback |
    MPTokenIssuanceCreateFlags.tfMPTCanLock |
    MPTokenIssuanceCreateFlags.tfMPTRequireAuth
  const create = await submit(client, {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: I.address,
    AssetScale: 0,
    MaximumAmount: MAX_AMOUNT,
    TransferFee: 0,
    Flags: flags,
    MPTokenMetadata: encodeMPTokenMetadata({
      ticker: TICKER,
      name: 'Real estate share v1 testnet',
      desc: 'KYC-gated fractional property shares, testnet v1',
      icon: 'https://example.org/share-icon.png',
      asset_class: 'rwa',
      asset_subclass: 'real_estate',
      issuer_name: 'Testnet share issuer'
    })
  }, I, 'MPTokenIssuanceCreate (1.1)')
  const id = create.meta.mpt_issuance_id
  log.mptIssuanceID = id
  check('1.1 issuance created', create.code === 'tesSUCCESS' && !!id, id)

  // 1.2 Confirm flags and fee on the ledger.
  const iss = await client.request({ command: 'ledger_entry', mpt_issuance: id, ledger_index: 'validated' })
  const node = iss.result.node
  const f = node.Flags
  check('1.2 RequireAuth set', (f & MPTokenIssuanceCreateFlags.tfMPTRequireAuth) !== 0, `Flags=${f}`)
  check('1.2 CanClawback set', (f & MPTokenIssuanceCreateFlags.tfMPTCanClawback) !== 0)
  check('1.2 CanLock set', (f & MPTokenIssuanceCreateFlags.tfMPTCanLock) !== 0)
  check('1.2 CanTransfer set', (f & MPTokenIssuanceCreateFlags.tfMPTCanTransfer) !== 0)
  check('1.2 transfer fee is 0', (node.TransferFee ?? 0) === 0, `TransferFee=${node.TransferFee ?? 0}`)
  check('1.2 max amount as set', String(node.MaximumAmount) === MAX_AMOUNT, `MaximumAmount=${node.MaximumAmount}`)
  check('1.2 nothing outstanding yet', String(node.OutstandingAmount ?? '0') === '0', `OutstandingAmount=${node.OutstandingAmount ?? '0'}`)

  // 1.3 is not in this script. See header.
  log.step13 = 'not in this script: step 1.3 runs in src/run-share-issuer-phase1-3.mjs, to operational account O.'
  log.result = 'PASS'
  save()
  console.log(`\nRESULT PASS (1.1 and 1.2). 1.3 runs in src/run-share-issuer-phase1-3.mjs. run dir: ${runDir}`)
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
