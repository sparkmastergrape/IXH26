# KYC-Gated Real-Estate Share Issuer: Spec v1

Status: Phases 0 to 4 run on testnet. Run folders are in runs/.

Latest chain, 2026-11-16 08:42 to 08:46 UTC, with the replay fix. Every step passes. Issuance `01554A56C7DD9B55C78A1B64A200DBFFE9413E5D46EEFB67`. Phase 4 ends with H1 at 0, H2 at 100, and OutstandingAmount 100100. Run folders:
- Phase 0 (rehearsal, throwaway issuance): `runs/2026-11-16T08-42-01-844Z-phase0-rehearsal`
- Phase 1: `runs/2026-11-16T08-43-09-664Z-phase1-issuance`
- Phase 1.3: `runs/2026-11-16T08-43-25-501Z-phase1-3-operational-batch`
- Phase 2 (replay check passes, reused presentation rejected): `runs/2026-11-16T08-44-15-235Z-phase2-onboarding`
- Phase 3: `runs/2026-11-16T08-44-57-401Z-phase3-transfers`
- Phase 3.4 (replay check passes, reused presentation rejected): `runs/2026-11-16T08-45-18-069Z-phase3-positive-transfer`
- Phase 4: `runs/2026-11-16T08-45-55-576Z-phase4-compliance`

This chain ran before the 2026-11-25 reset. Its ledger state will be wiped by that reset.

Run the full chain with one command: `npm run share-issuer:chain`. It runs Phases 0 to 4 in order, then a read-only ledger check (`npm run share-issuer:verify` runs that check alone on given run folders). It stops at the first failed step.

## Goal

A property owner issues fractional shares as an MPT on XRPL.
- Only KYC-approved holders can hold shares.
- The issuer can lock or claw back shares for compliance.
- A holder proves "over 18" and "allowed country" with signed selective disclosure. The identity document stays private from the verifier's view of unrevealed fields. This is not zero-knowledge. See the Threat note.

## Design rules

- **Question every requirement.** Each step cites its source or its reason. A step that fails the ledger or the docs changes.
- **Delete before adding.** Remove any part that v1 does not need. Keep the Permissioned Domain and the ZK circuit out of v1.
- **Verify before claiming.** Each fact in this spec names its source. A claim without a source is marked unverified.
- **Record failures.** A failed check stays in the run log and in the spec. A gap stays listed until a source closes it.

## Tracks covered

- **Tokenization:** MPT issuance, fractional holding, payouts.
- **Cryptography:** Signed selective disclosure for the KYC check (v1). Zero-knowledge proof is deferred. See Open items.
- **XRPL applications:** Credential record.

## Verified facts (2026-11-15 and 2026-11-16)

| Fact | Source |
|---|---|
| Credentials enabled on devnet, testnet, and mainnet | Known Amendments, live ledger check |
| MPTs enabled 2025-10-01 | Known Amendments |
| Issuer cannot hold its own MPTs. Tokens sent to the issuer burn, so supply in circulation equals MaximumAmount minus OutstandingAmount | MPT docs, Core Properties and Supply Cap |
| Flag `tfMPTCanClawback` must be set at issuance | MPTokenIssuanceCreate docs |
| Flag `tfMPTCanLock` allows lock and unlock | MPTokenIssuanceCreate docs |
| Flag `tfMPTRequireAuth` enables allow-listing | MPTokenIssuanceCreate docs |
| Holder signs own MPTokenAuthorize opt-in. With allow-listing, issuer then authorizes the holder with their own MPTokenAuthorize | Migration and send-MPT docs |
| Permissioned Domains enabled 2026-02-04 | Known Amendments |
| Credentials gate DepositPreauth, Permissioned DEX, and Payment `CredentialIDs` | Credentials and Payment docs |
| **No protocol rule lets a Credential gate MPTokenAuthorize directly** | Docs search, 2026-11-15 |
| Testnet and Devnet reset on Wednesday, 2026-11-25 | xrpl.org blog, "Upcoming Testnet and Devnet Resets," 2026-11-09 |
| Lock of one holder returns `tecLOCKED` on a payment from that holder. Observed on testnet, Phase 4 run 2026-11-16. | Ledger observation. rippled `include/xrpl/protocol/TER.h` line 369 (`tecLOCKED = 192`). xrpl.org Send an MPT tutorial, step 5 Caution, lists `tecLOCKED` for a locked sender or receiver (docs search, 2026-11-16; full page not opened). The ConfidentialMPTSend error table also lists it. Earlier note "not listed on xrpl.org" is superseded. Status of XRPLF/xrpl-dev-portal#4070 not checked. |

## Design decision: how the KYC gate works

**v1 (verified path):** The issuer does the gate.
1. Holder submits KYC proof to a KYC issuer account, I_KYC.
2. I_KYC issues a Credential to the holder.
3. The issuer checks the Credential on the ledger.
4. The issuer submits MPTokenAuthorize for that holder.

The gate depends on the issuer's own process. The ledger does not enforce it.

**v2 candidate (unverified for MPTs):** Deposit authorization.
- A holder enables DepositAuth and preauthorizes the credential type.
- A Payment with `CredentialIDs` succeeds only if the holder holds that credential.
- The docs describe this for deposits. I have not confirmed that it applies to MPT payments.

Build v1 first. Test v2 only after v1 passes.

## Accounts

- **I**: Property issuer. Creates the MPT and sets the rules.
- **K**: KYC issuer. Issues Credentials. Demo uses a mock KYC account we control.
- **H1 to Hn**: Share holders.
- **P**: Proof verifier. Checks the selective-disclosure proof off-chain.

## Phase 0: Rehearsal

Done when each step passes on a throwaway issuance.

0.1. I creates a throwaway MPT with flags CanTransfer, CanClawback, CanLock, RequireAuth, and transfer fee 0. CanTransfer lets tokens move to accounts other than the issuer (MPTokenIssuanceCreate docs, tfMPTCanTransfer).
0.2. K issues a test Credential to H1.
0.3. H1 accepts the Credential.
0.4. H1 submits MPTokenAuthorize to opt in.
0.5. I checks the Credential on the ledger. I submits MPTokenAuthorize for H1.
0.6. I pays H1 a test share amount. Confirm the balance.

## Phase 1: Issuance

Done when the real MPT exists with all flags set.

1.1. I creates the MPT. Record the issuance ID.
1.2. Confirm the flags on the ledger.
1.3. I sends the first share batch to operational account O. O needs a Credential and authorization first, like any holder. The issuer cannot hold its own MPTs (MPT docs, Core Properties).

## Phase 2: Holder onboarding

Done when H1 holds shares and H2 is blocked until KYC passes.

2.1. H1 submits the selective-disclosure proof to P. P returns pass or fail.
2.2. On pass, K issues the Credential to H1.
2.3. H1 accepts the Credential and submits MPTokenAuthorize.
2.4. I checks the Credential and authorizes H1.
2.5. Repeat for H2 with a failing proof. Confirm I does not authorize H2.

## Phase 3: Transfers and payouts

Done when shares move and a payout reaches authorized holders only.

3.1. I sends shares to H1.
3.2. H1 sends shares to H2 only if H2 is authorized. Confirm the transfer fails for an unauthorized H2.
3.3. I sends a test payout to H1.
3.4. Positive case: H2 passes the proof, K issues the Credential, H2 accepts it and opts in, and I authorizes H2. Then H1 sends 100 shares to H2. Confirm the transfer succeeds. Script: src/run-share-issuer-phase3-positive.mjs.

## Phase 4: Compliance actions (stretch)

Done when the locked balance cannot move and the clawback clears it.

4.1. I locks H1.
4.2. Confirm H1 cannot send shares.
4.3. I claws back H1 for the full amount. Confirm the balance reads zero.

## Phase 5: Deposit authorization (v2, draft)

Status: draft. Nothing in this phase has run. Phase 5 starts only after v1 passes. Each field and behavior below needs a source check before it runs.

Goal: Test whether a Credential gates MPT payments through DepositAuth.

This phase answers three open questions:
- Does DepositAuth block an MPT payment that has no `CredentialIDs`?
- Does a Payment with `CredentialIDs` succeed for an MPT?
- Must the credential sit with the sender, the receiver, or both?

5.0. Pre-checks. Confirm each item before any transaction.
- Confirm the `AuthorizeCredentials` field of DepositPreauth on testnet. Source: DepositPreauth docs.
- Confirm the `CredentialIDs` field of Payment on testnet. Source: Payment docs.
- Record the source of each field in the run log.

5.1. H1 enables DepositAuth on its account.
5.2. H1 creates a DepositPreauth that names credential type T issued by K.
5.3. Control case. H2 sends a test amount of shares to H1 with no `CredentialIDs`. Record the result code. Expected result: unknown. This result answers the first open question.
5.4. Positive case. H2 sends the same amount to H1 with `CredentialIDs` that name H2's credential from K. Expected result: success.
5.5. Confirm the balances of H1 and H2 after each step.
5.6. If 5.4 fails, repeat 5.4 with the credential held by H1 instead. Record the result. This step answers the third open question.

Pass criteria:
- 5.4 succeeds and H1 receives the amount.
- The run log records the 5.3 result, whichever it is, with its source.

## Failure handling

| Failure | Effect | Fix |
|---|---|---|
| Issuer forgets to authorize a holder | Holder cannot receive shares | Check Credential first, then authorize. Script both in one step. |
| Holder authorizes before the issuer | Holder must opt in again | Holder opts in only after Credential acceptance |
| Credential expires | Authorized holder keeps shares, but a new transfer may fail | Re-check Credential expiry before each payout |
| KYC proof fails | Holder stays unauthorized | Holder sees a failure message. No partial authorization. |
| Flags wrong at issuance | Permanent. Cannot undo. | Phase 0 test on throwaway issuance |
| Testnet reset on 2026-11-25 | Wipes the issuance and all ledger state | Keep the run folders as the record. Re-run Phases 0 to 4 on the new testnet. |
| Phase 3 positive run pre-check fails: H1 holds 1050, not 950 (after Phase 4 clawback) | Run stops at pre-check. No transfer. Kept as FAIL in runs/2026-11-16T05-48-31-021Z-phase3-positive-transfer. | Re-create the pre-Phase 4 state on a fresh issuance and run the chain. Passing run: runs/2026-11-16T05-51-56-889Z-phase3-positive-transfer. |

## Network

- Build on **testnet** for v1. Testnet amendment status mirrors mainnet (xrpl.org blog 2026-11-09, Background). Credentials confirmed live on testnet. MPT status on testnet follows the mainnet status by that rule. Confirm by ledger check before Phase 1.
- Testnet and Devnet reset on Wednesday, 2026-11-25. Source: xrpl.org blog, "Upcoming Testnet and Devnet Resets," published 2026-11-09. The reset is for full-history server stability.
- Do not use devnet for v1. Devnet also resets on 2026-11-25 and tracks the develop branch (xrpl.org blog 2026-11-09, Background).

## Other tracked files (not v1)

- `src/run-payroll.mjs` and its `run` script in `package.json`. Kept by owner decision. Not part of the share issuer. Source: payroll-spec v2 (not checked in this repo).
- `docs/session-review.md`. Kept by owner decision. A review record. It does not authorize new work.
- Run folders `runs/2026-11-15T23-42-06-942Z-rehearsal`, `runs/2026-11-15T23-44-42-733Z-real`, and `runs/2026-11-16T04-14-34-856Z-rehearsal`. Kept by owner decision. Gitignored. Modes `rehearsal` and `real` predate the phase script modes.

## Open items (not verified)

- Whether DepositAuth and CredentialIDs gate MPT payments (v2 only).
- Clawback MPT `Amount` format. xrpl.org Clawback Fields (docs search, 2026-11-16) requires `Holder` for MPTs and a non-zero `value`. It does not show the MPT `Amount` shape. The Phase 4 run uses the ledger-accepted format. Confirm against the MPT clawback example page before the reset.
- Whether zero-knowledge proofs are worth their cost for v2. Deferred. Revisit before v2 starts.
- Whether verifiers may learn the holder address and the revealed claims. Assumed yes in v1.
- Who issues real KYC in production. The demo uses a mock K.

## Threat note (draft)

- Holder balances and transfers are public. Amounts are not hidden in v1. Source: none yet (unverified).
- KYC data stays off-chain. The chain records only the Credential.
- The issuer is trusted to authorize holders correctly. The ledger does not enforce the gate in v1.
- The proof verifier P is trusted to check the proof.
- A lost holder key cannot be recovered. Source: none yet (unverified).
- Signed selective disclosure has these known gaps in v1:
  - **Attestor trust.** Decision 2026-11-16: accepted as a v1 trust assumption. The attestor signs `over18: true`. The holder cannot prove it from a birthdate, and the verifier trusts the attestor's claim. Rejected for v1: the verifier sees the birthdate (leaks the exact date). Deferred: a zero-knowledge over18 proof (v2). Revisit if no regulated KYC provider signs the age claim.
  - **Replay.** Design approved 2026-11-16. The verifier issues a nonce and an expiry (5 minutes). The holder signs both, with a hash of the presentation, using a holder Ed25519 key. The verifier accepts each nonce once. Phase 2 and Phase 3.4 scripts implement it. The offline self-test passes (5 replay cases, including a reused presentation). The ledger chain ran with it on 2026-11-16 (08:42 and 08:53 chains). It must run again after the 2026-11-25 reset. Fix before any multi-verifier run.
  - **Linkability.** Decision 2026-11-16: accepted for v1. Each presentation carries the same signature and holder address. A verifier can link a holder's visits through the address. The address is already public on the ledger with its balance and transfers. Rejected for v1: fresh attestation per presentation (does not stop address linkage, needs the attestor online per use). Rejected: a pseudonymous subject per verifier (breaks the credential and MPT authorization on the holder account).
  - **Leaked shape.** Decision 2026-11-16: accepted for v1. The verifier learns the count of signed claims. Every holder signs the same three claims, so the count identifies no one. It leaks only if the claim set varies between holders. Revisit if production claim sets vary. Fix then: pad every attestation to a fixed digest count.
