# realtime-call-tracker

Async REST + WebSocket calling platform simulator. Calls auto-progress through states (QUEUED → RINGING → ANSWERED/UNANSWERED → COMPLETED), backed by Postgres, Redis, BullMQ, and LocalStack S3.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/installation) 10+

## Quick start

```bash
# 1. Copy the example env file and adjust values as needed
cp .env.example .env

# 2. Build images and start all services
docker compose up --build
```

## Check the API is running

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"2025-..."}
```

## Live deployment URL

_TBD_

---

> **Note:** REST endpoints, WebSocket gateway, API documentation (Swagger), and worker logic land in later PRs. This PR is the project scaffold only.
