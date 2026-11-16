# KYC-Gated Real-Estate Share Issuer: Spec v1

Status: Phases 0 to 4 run on testnet. Run folders are in runs/.

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
| Flag `tfMPTCanClawback` must be set at issuance | MPTokenIssuanceCreate docs |
| Flag `tfMPTCanLock` allows lock and unlock | MPTokenIssuanceCreate docs |
| Flag `tfMPTRequireAuth` enables allow-listing | MPTokenIssuanceCreate docs |
| Holder signs own MPTokenAuthorize opt-in. With allow-listing, issuer then authorizes the holder with their own MPTokenAuthorize | Migration and send-MPT docs |
| Permissioned Domains enabled 2026-02-04 | Known Amendments |
| Credentials gate DepositPreauth, Permissioned DEX, and Payment `CredentialIDs` | Credentials and Payment docs |
| **No protocol rule lets a Credential gate MPTokenAuthorize directly** | Docs search, 2026-11-15 |
| Testnet and Devnet reset on Wednesday, 2026-11-25 | xrpl.org blog, "Upcoming Testnet and Devnet Resets," 2026-11-09 |
| Lock of one holder returns `tecLOCKED` on a payment from that holder. Observed on testnet, Phase 4 run 2026-11-16. | Ledger observation. rippled `include/xrpl/protocol/TER.h` line 369 (`tecLOCKED = 192`). Not listed on xrpl.org (issue XRPLF/xrpl-dev-portal#4070). |

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
1.3. I sends the first share batch to operational account O. O needs a Credential and authorization first, like any holder. The issuer cannot hold its own MPTs.

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

## Phase 4: Compliance actions (stretch)

Done when the locked balance cannot move and the clawback clears it.

4.1. I locks H1.
4.2. Confirm H1 cannot send shares.
4.3. I claws back H1 for the full amount. Confirm the balance reads zero.

## Failure handling

| Failure | Effect | Fix |
|---|---|---|
| Issuer forgets to authorize a holder | Holder cannot receive shares | Check Credential first, then authorize. Script both in one step. |
| Holder authorizes before the issuer | Holder must opt in again | Holder opts in only after Credential acceptance |
| Credential expires | Authorized holder keeps shares, but a new transfer may fail | Re-check Credential expiry before each payout |
| KYC proof fails | Holder stays unauthorized | Holder sees a failure message. No partial authorization. |
| Flags wrong at issuance | Permanent. Cannot undo. | Phase 0 test on throwaway issuance |
| Testnet reset on 2026-11-25 | Wipes the issuance and all ledger state | Keep the run folders as the record. Re-run Phases 0 to 4 on the new testnet. |

## Network

- Build on **testnet** for v1. Testnet amendment status mirrors mainnet (docs). Credentials confirmed live on testnet. MPT status on testnet follows the mainnet status by that rule. Confirm by ledger check before Phase 1.
- Testnet and Devnet reset on Wednesday, 2026-11-25. Source: xrpl.org blog, "Upcoming Testnet and Devnet Resets," published 2026-11-09. The reset is for full-history server stability.
- Do not use devnet for v1. Devnet also resets on 2026-11-25 and tracks the develop branch.

## Open items (not verified)

- Whether DepositAuth and CredentialIDs gate MPT payments (v2 only).
- Whether zero-knowledge proofs are worth their cost for v2. Deferred. Revisit before v2 starts.
- Whether verifiers may learn the holder address and the revealed claims. Assumed yes in v1.
- Who issues real KYC in production. The demo uses a mock K.

## Threat note (draft)

- Holder balances and transfers are public. Amounts are not hidden in v1.
- KYC data stays off-chain. The chain records only the Credential.
- The issuer is trusted to authorize holders correctly. The ledger does not enforce the gate in v1.
- The proof verifier P is trusted to check the proof.
- A lost holder key cannot be recovered.
- Signed selective disclosure has these known gaps in v1:
  - **Attestor trust.** The attestor signs `over18: true`. The holder cannot prove it from a birthdate.
  - **Replay.** The verifier checks no nonce, challenge, or expiry. A captured presentation can be reused. Fix before any multi-verifier run.
  - **Linkability.** Each presentation carries the same signature and holder address. A verifier can link a holder's visits.
  - **Leaked shape.** The verifier learns the count of signed claims.
