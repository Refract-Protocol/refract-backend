# Relayer key compromise runbook

Oracle publishes require a quorum of independent submitter signatures
(`ORACLE_QUORUM_*`, see `.env.example`). Keys live in the keystore file
(`ORACLE_RELAYER_KEYSTORE_PATH`), never in logs or plaintext env outside dev.

## 1. Contain (minutes)
1. Identify the key id and public key (the `Relayer keyring loaded:` log line lists ids and public keys only).
2. Set `"active": false` for that key in the keystore file (or delete the entry). The backend re-reads the file when it changes; no restart. In-flight decisions drop signatures from the revoked key and either re-collect from remaining keys or fail closed. Nothing partial is published.
3. If fewer active keys remain than a feed's threshold, publishes for that feed stop (fail closed). Do not lower the threshold to compensate for a compromise.
4. Remove the public key from the deployed `RefractOracle` signer set using the oracle admin account.

## 2. Rotate in a replacement
1. Generate a new Stellar keypair offline and fund it on the target network.
2. Register the new public key on `RefractOracle` (admin call).
3. Add a new entry (`id`, `secret`, `network`, `active: true`) to the keystore via your secret manager. The running process picks it up.
4. Restart one replica to confirm startup validation passes: threshold <= active keys and compatible with the on-chain `required_signers()`.

## 3. Prove the rotation
- The log shows `Relayer keyring loaded:` with the old id `revoked` and the new id `active` (public keys only).
- A fresh decision publishes; its transaction carries signatures from the new key and none from the revoked one.
- The `RefractOracle` signer set no longer contains the old public key; on testnet, a publish signed by the old key is rejected.
- Record key ids, public keys, the ledger of the on-chain removal and the confirming publish tx hash in the incident ticket.

## 4. Follow-up
Audit every oracle value published since the suspected compromise time against off-chain sources, and report per `SECURITY.md`.
