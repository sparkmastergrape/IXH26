# IXH26: KYC-gated real-estate share issuer on XRPL

A working reference for issuing fractional property shares as an XRPL Multi-Purpose Token (MPT), where only KYC-approved holders can hold shares and the issuer can lock or claw back shares for compliance.

Testnet only. The KYC issuer is a mock account the project controls. This is not production software and does not handle real money.

## What it does

The chain runs in phases. Each phase writes a run folder with a `run.json` log and checks every step against the ledger.

| Phase | What it shows |
|---|---|
| 0 | Rehearsal on a throwaway issuance: credential, opt-in, authorization, test payment |
| 1 | Creates the real MPT with clawback, lock, and authorization flags |
| 1.3 | Sends the first share batch to an operational account |
| 2 | Holder onboarding: a passing proof gets a credential and authorization. A failing proof does not |
| 3 | Transfers: an unauthorized holder cannot receive shares. An authorized holder can |
| 3.4 | Positive transfer to a second authorized holder, with replay checks |
| 4 | Compliance: lock a holder, confirm the send fails, claw back the full balance |

The design, the verified facts, and the open items are in [docs/share-issuer-spec.md](docs/share-issuer-spec.md).

## Requirements

- Node.js 18 or later
- Internet access to the XRPL testnet WebSocket (`wss://s.altnet.rippletest.net:51233`)

## Setup

```bash
npm install
```

## Run

Run the full v1 chain in one command:

```bash
npm run share-issuer:chain
```

The chain stops at the first step that fails.

Check a finished chain with a read-only ledger query:

```bash
node src/verify-share-issuer-chain.mjs <run-dir> [<run-dir> ...]
```

View the latest chain in a local read-only dashboard, served on 127.0.0.1:

```bash
npm run share-issuer:dashboard
```

## Run folders and secrets

- Each run writes to `runs/`. The folder is gitignored.
- A run folder holds test seeds and keys (`wallets.json`, `keys.json`). Do not publish a run folder or copy its keys elsewhere.
- Testnet resets on 2026-11-25. Ledger state from earlier runs is wiped. Keep the run folders as a record, then run the chain again on the new testnet.

## Known gaps

From the threat note in the spec. These stay open in v1:

- **Attestor trust.** The attestor signs `over18: true`. The holder cannot prove it from a birthdate.
- **Linkability.** Each presentation carries the same holder address and signature.
- **Leaked shape.** The verifier learns how many claims were signed.
- **Issuer trust.** The ledger does not enforce the KYC gate in v1. The issuer must authorize holders correctly.

## Other files

`src/run-payroll.mjs` is a separate script and is not covered by this README.

## License

MIT. See [LICENSE](LICENSE).
