# Oracle reading provenance

Each oracle reading the relayer publishes carries a packed `u128` next to the
value, so contracts and auditors can tell how well-supported the value is
without leaving the ledger:

```
update_reading(coverage_type: u32, value: i128, provenance: u128)
```

The backend side lives in `src/oracle/oracle-encoding.ts`
(`packProvenance`, `unpackProvenance`, `provenanceFromDecision`,
`buildUpdateReadingArgs`). The contract must accept the third argument
before the relayer switches to it.

## Provenance bitmask layout

Most significant bits first:

| bits     | width | field                                     |
|----------|-------|-------------------------------------------|
| 127..124 | 4     | layout version (currently `1`)            |
| 123..120 | 4     | trust tier                                |
| 119..112 | 8     | agreeing source count                     |
| 111..104 | 8     | reserved, always `0`                      |
| 103..64  | 40    | source timestamp, Unix seconds            |
| 63..0    | 64    | consensus decision id                     |

A provenance of `0` (version 0) means "no provenance" and is never produced.

### Trust tiers

| value | tier           | meaning                                                         |
|-------|----------------|-----------------------------------------------------------------|
| 0     | `Unverified`   | no consensus — never published                                  |
| 1     | `SingleSource` | exactly one source agreed (only if policy allows one source)    |
| 2     | `Corroborated` | two or more sources agreed and the weighted quorum was met      |
| 3     | `Unanimous`    | three or more sources, all fresh, valid and in agreement        |

The encoder rejects inconsistent combinations (e.g. `Corroborated` with one
source), so consumers can rely on `tier >= 2` meaning "at least two sources".

### Source timestamp

The earliest observation time among the agreeing sources, floored to whole
seconds. Using the earliest one means the value never looks fresher than its
oldest supporting input.

### Decision id

The first 64 bits of a SHA-256 over the round's sorted inputs, the consensus
policy, the outcome and the evaluation time (`computeDecisionId` in
`src/oracle/consensus/consensus.ts`). Re-running consensus over the logged
inputs reproduces the id, which ties an on-chain value back to the exact
observations behind it.

## Evidence spool records

The spool (`src/oracle/evidence/evidence-spool.ts`) writes `EvidenceRecord`
values as NDJSON to a local write-ahead log and flushes them to Postgres via
the `EvidenceStore` interface. `EvidenceRecord` is a discriminated union of
`SequencedEvidence` (for real readings and decisions) and `EvidenceGap` (for
runs of sequence numbers that could not be made durable).

### SequencedEvidence fields

`SequencedEvidence` extends `EvidenceEntry` with a sequence number assigned
at the moment the record is accepted:

| Field | Type | Description |
|---|---|---|
| `seq` | `number` | Strictly increasing sequence number; gaps indicate lost records |
| `kind` | `"reading"` \| `"decision"` | Record kind |
| `coverageType` | `string` | PascalCase coverage type, e.g. `"StablecoinDepeg"` |
| `value` | `number` | Numeric value at the time of this record |
| `severity` | `string` | Severity level, e.g. `"low"`, `"medium"`, `"high"`, `"triggered"` |
| `source` | `string` | Primary source tag, e.g. `"coingecko"` or `"consensus"` |
| `recordedAt` | `number` | Wall-clock time the evidence was produced (ms) |
| `payload` | `unknown` | Full structured payload: the reading or decision with its observations |

### EvidenceGap fields

A gap record marks a run of sequence numbers that could not be made durable:

| Field | Type | Description |
|---|---|---|
| `seq` | `number` | Sequence number of this gap record |
| `kind` | `"gap"` | Always `"gap"` |
| `firstSeq` | `number` | First sequence number in the lost run |
| `lastSeq` | `number` | Last sequence number in the lost run |
| `lostCount` | `number` | Number of records lost (`lastSeq - firstSeq + 1`) |
| `openedAt` | `number` | Wall-clock time the gap started (ms) |
| `closedAt` | `number` | Wall-clock time the gap was closed (ms) |
| `reason` | `string` | Human-readable explanation of the loss |
| `recordedAt` | `number` | Wall-clock time the gap record itself was written (ms) |

## Decoding in a contract (Rust sketch)

```rust
let version  = (p >> 124) & 0xF;
let tier     = (p >> 120) & 0xF;
let sources  = (p >> 112) & 0xFF;
let ts_secs  = ((p >> 64) & 0xFF_FFFF_FFFF) as u64;
let decision = (p & 0xFFFF_FFFF_FFFF_FFFF) as u64;
assert!(version == 1);
```

A consumer that only wants corroborated data can require `tier >= 2`; one
that cares about freshness can compare `ts_secs` with the ledger timestamp.
