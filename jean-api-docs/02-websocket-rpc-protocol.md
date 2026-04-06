# WebSocket RPC Protocol

Jean's web RPC is a lightweight JSON protocol over `/ws`.

## Request envelope (client -> server)

```json
{
  "id": "req-uuid",
  "command": "list_projects",
  "args": {}
}
```

Notes:
- Frontend currently includes a non-required `type: "invoke"`; server ignores it.
- Request must be valid JSON text.

## Success response (server -> client)

```json
{
  "type": "response",
  "id": "req-uuid",
  "data": {}
}
```

## Error response (server -> client)

Command/runtime error:

```json
{
  "type": "error",
  "id": "req-uuid",
  "error": "..."
}
```

Parse/format error:

```json
{
  "type": "error",
  "id": "unknown",
  "error": "Invalid request: ..."
}
```

## Realtime event frame (server -> client)

```json
{
  "type": "event",
  "event": "chat:chunk",
  "payload": {}
}
```

## Connection and retry behavior (`src/lib/transport.ts`)

Token resolution order:
1. `?token=` query param
2. `localStorage['jean-http-token']`

Token URL hygiene:
- If token arrives via URL, it is persisted to localStorage then removed from the URL via `history.replaceState`.

Connection flow:
1. `GET /api/auth`
2. If auth OK -> open `ws://host/ws?token=...`

Retry behavior:
- If auth fails (`401`), token is cleared and reconnect stops until fixed.
- If network/server is unavailable, reconnect uses exponential backoff:
  - 1s, 2s, 4s, ... max 30s.

Request timeout:
- 60 seconds per invoke.

Queueing:
- Requests made while disconnected are queued and sent after reconnect.

## Backpressure / event loss considerations

Server internals:
- Broadcast channel size: 1000 events.
- Per-client forwarding queue: 256 messages.

Implication:
- Slow clients can lag and miss older events.
- Integrations should rely on periodic state refresh (`get_session`, `get_sessions`, etc.) in addition to event listening.

## Ping/Pong handling

- Ping frames receive Pong.
- Binary frames are ignored.
