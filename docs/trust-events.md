# Oracle Trust Events (WebSocket)

Trust events are pushed over the oracle WebSocket (`/oracle`). Domain services
(source quarantine, feed divergence/quorum, pause, dispute) call
`TrustEventsService.publish()` (the `TrustEventBus` interface in
`src/oracle/trust-events.ts`). The event is validated with Zod, written to the
snapshot hash `refract:trust-snapshot`, and published on the Redis channel
`refract:trust-events`. Every instance broadcasts only what it receives from
Redis, so delivery is consistent across instances. Without Redis config
(`REDIS_URL` / `REDIS_HOST`) the bus delivers in-process.

## Envelope (schema version 1)

```json
{
  "id": "uuid",
  "version": 1,
  "type": "trust.pause",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "payload": { "kind": "paused", "coverageType": "StablecoinDepeg" }
}
```

Delivery is at-least-once; clients must dedupe by `id`. Breaking changes bump
`version`.

## Channels and payloads

| Channel          | Payload                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `trust.source`   | `kind` (`quarantined`/`restored`), `feedId`, `coverageType?`, `reason?`                                                  |
| `trust.feed`     | `kind` (`divergence`/`quorum_failure`/`confidence_change`), `feedId`, `coverageType?`, `confidence?` (0-1), `degraded`   |
| `trust.coverage` | `coverageType`, `degraded`, `confidence?`                                                                                |
| `trust.pause`    | `kind` (`paused`/`resumed`), `coverageType?`, `reason?`                                                                  |
| `trust.dispute`  | `kind` (`opened`/`under_review`/`upheld`/`reversed`/`withdrawn`), `coverageType?`, `disputeId`                           |

## Authentication and redaction

Unauthenticated clients receive only the public `payload` (re-validated with the
Zod schema, which strips unknown keys). Ops clients connect with
`/oracle?token=<OPS_WS_TOKEN>` and additionally receive `internal`
(`sourceId`, `detail`, `actor`).

## Client protocol

- On connect the server sends
  `{"type":"snapshot","version":1,"timestamp":...,"events":[...]}` containing the
  latest event per subject, filtered for the client.
- Subscribe: `{"action":"subscribe","channels":["trust.pause"],"coverageTypes":["StablecoinDepeg"]}`.
  Omitted/empty `channels` = all; omitted `coverageTypes` = all. The server
  replies `{"type":"subscribed","channels":[...]}`. Default after connect: all
  channels.
- Unsubscribe: `{"action":"unsubscribe","channels":[...]}`.

## Slow consumers and liveness

Each connection has a bounded queue (`WS_MAX_QUEUE`, default 100) and a socket
buffer high-water mark (`WS_HIGH_WATER_BYTES`, default 64 KiB). On overflow the
oldest queued event is dropped; once the queue drains the server sends
`{"type":"resync_required"}`, after which the client should reconnect to get a
fresh snapshot. The server pings every `WS_HEARTBEAT_MS` (default 30s) and
terminates sockets that miss a pong.
