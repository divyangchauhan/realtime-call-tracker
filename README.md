# realtime-call-tracker

An async **REST + WebSocket calling-platform simulator** built with NestJS. Calls are
created over HTTP and then auto-progress through a lifecycle on background timers
(`QUEUED → RINGING → ANSWERED | UNANSWERED → COMPLETED`). Every state transition is
broadcast to subscribed WebSocket clients, each completed call gets a "recording"
uploaded to S3 by a separate worker, and per-API-key rate limits are enforced
atomically in Redis.

The project demonstrates a **split-durability** design: Redis holds the hot, live
call state while Postgres is the durable system of record, reconciled by a mix of
synchronous write-through and periodic write-behind flushing.

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Quick start (Docker Compose)](#quick-start-docker-compose)
- [Local development](#local-development)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [WebSocket streaming](#websocket-streaming)
- [Authentication](#authentication)
- [Rate limiting](#rate-limiting)
- [Data model & durability](#data-model--durability)
- [Recording worker](#recording-worker)
- [Testing](#testing)
- [Project layout](#project-layout)

---

## Architecture

```
                           ┌──────────────────────────────────────┐
   HTTP / WS clients  ───►  │  API process  (node dist/main)        │
                           │  ┌────────────────────────────────┐   │
                           │  │ ApiKeyAuthGuard (Bearer, hashed)│   │
                           │  │ RateLimiter (atomic Lua script) │   │
                           │  │ CallsController / CallsService  │   │
                           │  │ CallProgressionService (timers) │   │
                           │  │ CallFlushService (write-behind) │   │
                           │  │ CallsGateway (WS fan-out)        │   │
                           │  │ MetricsController                │   │
                           │  └────────────────────────────────┘   │
                           └───────┬───────────────┬───────────────┘
                                   │               │  BullMQ "recording" queue
              ┌────────────────────┘               └──────────────────────┐
              ▼                    ▼                                       ▼
        ┌──────────┐        ┌──────────┐                          ┌─────────────────┐
        │  Redis    │        │ Postgres │                          │ Worker process   │
        │ live state│        │ durable  │                          │ (node dist/worker)│
        │ pub/sub   │◄──────►│ + TypeORM│◄────────────────────────►│ S3 upload → URL   │
        │ rate-limit│        │ migration│                          │ write-back        │
        └──────────┘        └──────────┘                          └────────┬─────────┘
                                                                            ▼
                                                                   ┌─────────────────┐
                                                                   │ LocalStack S3    │
                                                                   │ call-recordings  │
                                                                   └─────────────────┘
```

- **API process** serves REST + WebSocket, runs the progression state machine, and
  publishes transitions to Redis pub/sub.
- **Worker process** consumes the BullMQ `recording` queue, uploads the mock
  recording to S3, and writes the resulting URL back to Postgres + Redis.
- The two processes scale and deploy independently; only the worker runs the
  `@Processor` consumer, and only the API runs the HTTP/WS server and timers.

### Call lifecycle

```
QUEUED ──[PROGRESSION_QUEUED_TO_RINGING_MS]──► RINGING
RINGING ──[PROGRESSION_RINGING_MS]──► ANSWERED   (probability PROGRESSION_ANSWER_PROBABILITY)
                                   └► UNANSWERED  (probability 1 - p)
ANSWERED ──[PROGRESSION_ANSWERED_TO_COMPLETED_MS]──► COMPLETED
UNANSWERED ──[PROGRESSION_UNANSWERED_TO_COMPLETED_MS]──► COMPLETED
```

On `COMPLETED` the call is written through to Postgres (`status`, `completed_at`),
the concurrency slot is released, and a recording job is dispatched to the worker.

---

## Tech stack

| Concern            | Choice                                                            |
| ------------------ | ----------------------------------------------------------------- |
| Framework          | NestJS 11 (TypeScript)                                             |
| Durable store      | Postgres 16 + TypeORM (migrations, `synchronize: false`)          |
| Live state / pub-sub / rate-limit | Redis 7 via **ioredis** (separate command, subscriber, and BullMQ connections) |
| Job queue          | BullMQ (`recording` queue)                                        |
| Object storage     | LocalStack S3 (path-style, `us-east-1`)                           |
| WebSockets         | `@nestjs/platform-ws` (raw `ws`, no socket.io)                    |
| Orchestration      | Docker Compose (5 services: `api`, `worker`, `postgres`, `redis`, `localstack`) |
| Package manager    | pnpm 10                                                           |

---

## Quick start (Docker Compose)

Prerequisites: Docker + Docker Compose v2. (Node 22+ and pnpm 10+ are only needed
to run the seed and the test suite from your host.)

```bash
# 1. Copy the example env file (defaults work out of the box for Compose)
cp .env.example .env

# 2. Build the image and start all five services
docker compose up --build
```

The `api` service runs database migrations automatically on boot
(`DB_RUN_MIGRATIONS=true`); the `worker` does not, to avoid migration races.

```bash
# 3. Seed the dev API key (run from the host against the published Postgres port).
#    The seed uses ts-node, so install dependencies first.
pnpm install
POSTGRES_HOST=localhost pnpm seed
# → prints:  Authorization: Bearer dev-secret-key
```

Verify the API is up:

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"2026-..."}
```

Create a call and watch it progress:

```bash
curl -X POST http://localhost:3000/calls \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"from":"+15551230001","to":"+15559990002","metadata":{"campaign":"demo"}}'
# → {"call_id":"<uuid>","websocket_url":"ws://localhost:3000/ws?callId=<uuid>"}
```

> **Note on LocalStack:** the Compose file pins `localstack/localstack:3.5`
> (Community). The `latest` tag now resolves to a Pro-by-default image that exits
> on startup unless a `LOCALSTACK_AUTH_TOKEN` is provided; the 3.x Community image
> provides the S3 emulation this project needs, license-free.

---

## Local development

Run the app processes on your host while the infrastructure runs in Docker:

```bash
pnpm install

# Start only the backing services
docker compose up -d postgres redis localstack

# Point the app at the published ports
export POSTGRES_HOST=localhost REDIS_HOST=localhost S3_ENDPOINT=http://localhost:4566

pnpm migration:run        # apply the schema
pnpm seed                 # create the dev API key (prints the Bearer token)

pnpm start                # API on http://localhost:3000  (use start:dev for watch mode)
pnpm start:worker         # recording worker (separate terminal)
```

### Useful scripts

| Script                      | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `pnpm build`                | Compile to `dist/` via `nest build`                 |
| `pnpm start` / `start:dev`  | Run the API (optionally in watch mode)              |
| `pnpm start:worker`         | Run the recording worker (`node dist/worker`)       |
| `pnpm test`                 | Run the Jest unit/integration suite                 |
| `pnpm lint`                 | ESLint over `src`                                   |
| `pnpm migration:run`        | Apply pending TypeORM migrations                    |
| `pnpm migration:generate`   | Generate a migration from entity changes            |
| `pnpm migration:revert`     | Revert the last migration                           |
| `pnpm seed`                 | Idempotently upsert the dev API key                 |

---

## Configuration

All configuration is via environment variables (see [.env.example](.env.example)),
validated at boot by `class-validator`. The table below lists the values shipped in
`.env.example` - i.e. the Compose-ready defaults you get from `cp .env.example .env`.
A few host names there target the Docker network (`POSTGRES_HOST=postgres`,
`REDIS_HOST=redis`, `S3_ENDPOINT=http://localstack:4566`); when a variable is unset
entirely, the application's built-in fallback is localhost-friendly instead
(e.g. `POSTGRES_HOST` falls back to `localhost`).

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Node environment |
| `PORT` | `3000` | HTTP/WS listen port (API) |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `postgres` / `5432` | Postgres connection |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `calluser` / `callpass` / `calltracker` | Postgres credentials |
| `DB_RUN_MIGRATIONS` | `true` | Run migrations on boot (set `false` for the worker) |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | Redis connection |
| `AWS_REGION` | `us-east-1` | S3 region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | S3 credentials (LocalStack) |
| `S3_ENDPOINT` | `http://localstack:4566` | S3 endpoint (path-style) |
| `S3_BUCKET` | `call-recordings` | Bucket for recordings |
| `MOCK_RECORDING_PATH` | `assets/mock_recording.mp3` | Mock file uploaded per completed call |
| `SEED_API_KEY` | `dev-secret-key` | Raw key created by `pnpm seed` |
| `CALL_STATE_TTL_SECONDS` | `3600` | TTL on the Redis `call:{id}` hash |
| `WS_PUBLIC_URL` | `ws://localhost:3000/ws` | Base WS URL advertised by `POST /calls` |
| `PROGRESSION_QUEUED_TO_RINGING_MS` | `1000` | QUEUED → RINGING delay |
| `PROGRESSION_RINGING_MS` | `2000` | RINGING duration before the answer roll |
| `PROGRESSION_ANSWERED_TO_COMPLETED_MS` | `3000` | ANSWERED → COMPLETED delay |
| `PROGRESSION_UNANSWERED_TO_COMPLETED_MS` | `500` | UNANSWERED → COMPLETED delay |
| `PROGRESSION_ANSWER_PROBABILITY` | `0.7` | Probability a ringing call is answered (0-1) |
| `FLUSH_INTERVAL_MS` | `5000` | Period of the write-behind reconciliation flush |

---

## API reference

All `/calls` and `/metrics` routes require a Bearer API key (see
[Authentication](#authentication)). `/health` is public. Responses are JSON; call
bodies use **snake_case**.

### `POST /calls`

Create a new call. The call is persisted as `QUEUED`, the progression state machine
starts, and a WebSocket URL for live tracking is returned.

Request body:

```json
{ "from": "+15551230001", "to": "+15559990002", "metadata": { "campaign": "demo" } }
```

`from` and `to` are required non-empty strings; `metadata` is an optional object.
Unknown properties are stripped by the global validation pipe.

`201 Created`:

```json
{ "call_id": "f1e2...", "websocket_url": "ws://localhost:3000/ws?callId=f1e2..." }
```

Returns `429 Too Many Requests` when a rate limit is exceeded, `401` without a valid
key, and `400` for a malformed body.

### `GET /calls/:id`

Fetch the current state of a call. Served from Redis (fast path) and falls back to
Postgres if the Redis hash has expired.

`200 OK`:

```json
{
  "id": "f1e2...",
  "from": "+15551230001",
  "to": "+15559990002",
  "status": "COMPLETED",
  "metadata": { "campaign": "demo" },
  "recording_url": "http://localstack:4566/call-recordings/recordings/f1e2....mp3",
  "created_at": "2026-06-24T05:26:56.168Z",
  "updated_at": "2026-06-24T05:26:56.838Z"
}
```

`recording_url` is `null` until the worker finishes the upload. Returns `404` if the
call does not exist **or belongs to a different API key** (no cross-tenant reads), and
`400` for a malformed UUID.

### `GET /metrics`

A per-API-key operational snapshot. Authenticated and scoped to the calling key - it
never aggregates across tenants.

`200 OK`:

```json
{
  "api_key_id": "d21b...",
  "calls": {
    "total": 2,
    "by_status": { "QUEUED": 0, "RINGING": 0, "ANSWERED": 0, "UNANSWERED": 0, "COMPLETED": 2 },
    "with_recording": 1
  },
  "live": { "active_calls": 0 },
  "limits": { "max_concurrent": 3, "max_cps": 2 },
  "generated_at": "2026-06-24T05:57:44.191Z"
}
```

- `calls.*` come from Postgres (counts filtered by the caller's key).
- `live.active_calls` is the live concurrency from the rate limiter's Redis SET
  (best-effort: degrades to `0` with a warning if Redis is unreachable).
- `limits` are the key's configured `max_concurrent` / `max_cps`.

### `GET /health`

Public liveness probe: `{ "status": "ok", "timestamp": "..." }`.

---

## WebSocket streaming

Connect to the `websocket_url` returned by `POST /calls`:

```
ws://localhost:3000/ws?callId=<uuid>
```

On connect the gateway sends an immediate snapshot of the current state, then pushes
one message per transition. Each message is the same snake_case shape as
`GET /calls/:id`. The final message for a completed call carries the populated
`recording_url`.

Authentication is by capability: the `callId` is an unguessable UUID handed back from
an authenticated `POST /calls`, and a client only ever receives events for the
`callId` it connected with. A connection without a `callId` is closed with code `1008`.

> **Ordering contract:** because the on-connect snapshot is read asynchronously, a
> live transition can arrive before the snapshot. Clients should treat `updated_at`
> as the ordering key (statuses are also strictly forward-only) and ignore any
> message that is not newer than the latest already applied.

Quick test with [`wscat`](https://github.com/websockets/wscat):

```bash
wscat -c "ws://localhost:3000/ws?callId=<uuid>"
```

---

## Authentication

Every `/calls` and `/metrics` request must carry a Bearer token:

```
Authorization: Bearer dev-secret-key
```

A global `ApiKeyAuthGuard` hashes the presented key with SHA-256 and looks it up in
the `api_keys` table. On success it attaches `{ id, name, maxConcurrent, maxCps }` to
the request (used by the rate limiter and `/metrics` without an extra DB round-trip).
Only `@Public()` routes (currently `/health`) skip the guard.

`pnpm seed` idempotently creates a key named `dev` with the raw value `dev-secret-key`
(override via `SEED_API_KEY`) and limits `max_concurrent=3`, `max_cps=2`.

---

## Rate limiting

Two per-key limits are enforced **atomically in a single Redis Lua script**
(registered once via `defineCommand`, invoked via `EVALSHA`), so a request is either
admitted against both limits or rejected with `429`:

- **Concurrency** - a SET `active_calls:{apiKeyId}` capped at `max_concurrent`. The
  slot is released on the terminal `COMPLETED` transition (with a safety TTL as a
  backstop).
- **Calls-per-second (CPS)** - a sliding 1-second window in a ZSET `cps:{apiKeyId}`
  capped at `max_cps`.

The limiter **fails open**: if Redis is unavailable the request is admitted rather
than blocked, trading strict enforcement for availability.

---

## Data model & durability

### Schema

`api_keys`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | PK |
| `name` | varchar | |
| `key_hash` | varchar | unique, SHA-256 of the raw key |
| `max_concurrent` | int | concurrency limit |
| `max_cps` | int | calls-per-second limit |
| `is_active` | bool | |
| `created_at` / `updated_at` | timestamptz | |

`calls`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | PK |
| `api_key_id` | uuid | FK → `api_keys` (`ON DELETE RESTRICT`), indexed |
| `from_number` / `to_number` | varchar | |
| `status` | enum | `QUEUED`/`RINGING`/`ANSWERED`/`UNANSWERED`/`COMPLETED`, default `QUEUED`, indexed |
| `metadata` | jsonb | nullable |
| `recording_url` | varchar | nullable, set by the worker |
| `completed_at` | timestamptz | nullable |
| `created_at` / `updated_at` | timestamptz | indexed on `created_at` |

The schema is managed by TypeORM migrations (`synchronize: false`). The initial
migration lives at
[src/database/migrations/1750000000000-InitialSchema.ts](src/database/migrations/1750000000000-InitialSchema.ts).

### Split durability

Redis holds the live `call:{id}` hash (with a TTL) for sub-millisecond reads and
pub/sub fan-out; Postgres is the durable record. The two are reconciled with a
deliberate mix:

- **Write-through (synchronous)** on **create** (`QUEUED`) and on **`COMPLETED`**
  (`status`, `completed_at`) - the moments that must be durable immediately.
- **Write-behind** for the in-flight intermediate transitions
  (`RINGING`/`ANSWERED`/`UNANSWERED`): these update only the Redis hash and mark the
  call ID in a `calls:dirty` Redis SET, keeping the hot timer path to a single Redis
  round-trip.
- **Periodic flush** (`CallFlushService`, every `FLUSH_INTERVAL_MS`, API process only)
  drains the dirty set and writes each call's latest status through to Postgres,
  guarded by `status != COMPLETED` so a durably-completed row is never regressed by a
  stale intermediate.

---

## Recording worker

The worker (`node dist/worker`) is a lean NestJS application context - no HTTP server,
no WebSocket gateway - that consumes the BullMQ `recording` queue. When a call reaches
`COMPLETED`, the API enqueues a job (`jobId = callId`, so at most one in flight per
call). For each job the worker:

1. reads the mock MP3 from `MOCK_RECORDING_PATH`;
2. uploads it to S3 at the deterministic key `recordings/{callId}.mp3`
   (idempotent - retries overwrite the same bytes);
3. writes `recording_url` to Postgres (**throw-to-retry**: the durable write);
4. updates the Redis cache and publishes a final WebSocket event (**best-effort**:
   Postgres is the source of truth, so cache/publish failures are logged, not retried).

---

## Testing

```bash
pnpm test          # full Jest suite (unit + in-process integration specs)
pnpm test:cov      # with coverage
```

Tests mock Redis/Postgres/S3 at the boundary and cover the auth guard, rate-limiter
Lua semantics, the progression state machine, the WebSocket fan-out, the completion
write-through + dispatch, the recording processor, the write-behind flush, and the
metrics service.

---

## Project layout

```
src/
  auth/         Bearer API-key guard, @Public() decorator, current-key decorator
  calls/        Controller, service, progression engine, completion, write-behind flush,
                Redis call-state store, DTOs
  rate-limit/   Atomic Lua rate limiter (concurrency SET + CPS ZSET)
  recording/    BullMQ dispatch (producer) + worker processor, S3 storage service
  websocket/    CallsGateway (Redis pub/sub → per-callId WS fan-out)
  metrics/      GET /metrics controller + service
  redis/        ioredis connection providers (command / subscriber)
  database/     TypeORM entities, data source, migrations, seed
  config/       Typed configuration + env validation
  health/       Liveness endpoint
  main.ts       API entrypoint        worker.ts / worker.module.ts  Worker entrypoint
assets/
  mock_recording.mp3   Mock audio uploaded to S3 for each completed call
```
