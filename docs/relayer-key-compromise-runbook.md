# Relayer key compromise runbook

Oracle publishes require a quorum of independent submitter signatures
(`ORACLE_QUORUM_*`, see `.env.example`). Keys live in the keystore file
(`ORACLE_RELAYER_KEYSTORE_PATH`), never in logs or plaintext env outside dev.

## 1. Contain (minutes)
1. Identify the key id and public key (the `Relayer keyring loaded:` log line lists ids and public keys only).
2. Set `"active": false` for that key in the keystore file (or delete the entry). The backend re-reads the file when it changes; no restart. In-flight decisions drop signatures from the revoked key and either re-collect from remaining keys or fail closed. Nothing partial is published.
3. If fewer active keys remain than a feed's threshold, publishes for that feed stop (fail closed). Do not lower the threshold to compensate for a compromise.
4. Remove the public key from the deployed `RefractOracle` signer set using the oracle admin account.
5. Optional, if you want publishing for a feed halted outright while you rotate: `npx ts-node scripts/operator-cli.ts pause <feed> --reason "<incident id>: relayer key <id> compromised" --yes`. Feed names come from `operator-cli feeds`. Run it with `--dry-run` first to preview. Resume later with `resume <feed> --reason "<incident id>: rotation complete"`.

Expected output of a successful `pause` (from `scripts/operator-cli.ts`; not yet run against a sandbox):
```
applied pause_feed on <feed>
  changed: true
  before:  {...}
  after:   {...}
```
Exit code `0`. A `--dry-run` prints `[dry-run] would apply` instead of `applied` and writes nothing. Any refusal (missing `--yes`, missing `--reason`, unknown feed) prints `error: ...` to stderr and exits `1`.

## 2. Rotate in a replacement
`scripts/operator-cli.ts` has no key-rotation subcommand (`operator-cli --help` lists none). Do not rotate by editing Postgres. Rotation is the keystore change and the on-chain admin call below.

1. Generate a new Stellar keypair offline and fund it on the target network.
2. Register the new public key on `RefractOracle` (admin call).
3. Add a new entry (`id`, `secret`, `network`, `active: true`) to the keystore via your secret manager. The running process picks it up.
4. Restart one replica to confirm startup validation passes: threshold <= active keys and compatible with the on-chain `required_signers()`.

## 3. Prove the rotation
- The log shows `Relayer keyring loaded:` with the old id `revoked` and the new id `active` (public keys only).
- A fresh decision publishes; its transaction carries signatures from the new key and none from the revoked one.
- The `RefractOracle` signer set no longer contains the old public key; on testnet, a publish signed by the old key is rejected.
- If you paused a feed in step 1.5, `operator-cli audit --limit 5` shows the `pause_feed` row with your `--reason` and operator id. Exit code `0`.
- Record key ids, public keys, the ledger of the on-chain removal and the confirming publish tx hash in the incident ticket.

## 4. Follow-up
Audit every oracle value published since the suspected compromise time against off-chain sources, and report per `SECURITY.md`.

Reputation: `docs/operator-reputation.md` scores oracle operators from observations and disputes. It does not define any effect from rotating a relayer key, so do not assume a score change from rotation. Record any operator-level impact separately in the incident ticket.
