# Signmons CallDesk Backend

NestJS backend powering the Signmons CallDesk AI dispatcher. It provides authenticated tenant triage, a server-to-server website integration, deterministic life-safety interception, and tenant-scoped persistence.

## Getting Started

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Copy `.env.example` to `.env` and fill values.
3. Run in development mode:
   ```bash
   npm run start:dev
   ```
4. Create a tenant (admin token required):
   ```bash
   curl -X POST http://localhost:3000/tenants \
     -H "Content-Type: application/json" \
     -H "x-admin-token: development-only-admin-token" \
     -d '{
       "name": "demo_hvac",
       "displayName": "Demo HVAC",
       "instructions": "Handle calls and collect details."
     }'
   ```
5. Hit the AI triage endpoint (tenantId is taken from auth headers, not body):
   ```bash
   curl -X POST http://localhost:3000/ai/triage \
     -H "Content-Type: application/json" \
     -H "x-dev-auth: dev-auth-secret" \
     -H "x-dev-user-id: dev-admin" \
     -H "x-dev-role: admin" \
     -H "x-dev-tenant-id: <TENANT_ID>" \
     -d '{
       "sessionId": "caller-1",
       "message": "Hi, my furnace stopped blowing warm air."
     }'
   ```

## Website webchat integration

The public browser must call a website-owned server-side proxy. Never expose the integration credential in browser JavaScript. The proxy calls:

```text
POST /api/integrations/webchat/triage
Authorization: Bearer <server-held-secret>
Content-Type: application/json

{"sessionId":"opaque-session-id","message":"customer message"}
```

Configure `WEBCHAT_INTEGRATIONS_JSON` with the SHA-256 hash of each random credential. The backend derives the tenant from the credential; it rejects tenant identifiers supplied by the caller. Gas, carbon-monoxide, fire, smoke, arcing, and similar life-safety messages bypass the AI provider and receive deterministic evacuation and emergency-contact instructions.

No website should send customer messages to this service until its privacy disclosure covers AI-assisted processing and retention.

## Frontend sandbox

A lightweight Next.js client lives under `ui/` so you can test the triage workflow without crafting curl commands.

1. Copy `ui/.env.local.example` to `ui/.env.local` and set `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:3000`).
2. From the repo root run:
   ```bash
   cd ui
   npm install
   npm run dev
   ```
3. The UI exposes two panels:
   - **Onboard Tenant** – submits to `/tenants`. Enter your `ADMIN_API_TOKEN` in the form; it is never stored.
   - **AI Triage** – posts messages with `sessionId` to `/ai/triage`. Tenant identity comes from auth headers (dev or JWT).

Keep using admin tokens sparingly and rotate them if you share access.

## Environment Variables

- `OPENAI_API_KEY` – required.
- `OPENAI_MODEL` – deployed OpenAI model id; defaults to `gpt-4o-mini`.
- `NODE_ENV` – defaults to `development`.
- `ENABLE_GPT5_1_CODEX` – optional preview flag for new OpenAI model.
- `FRONTEND_ORIGINS` – comma-separated list of allowed UI origins for CORS (defaults to `http://localhost:3101`).
- `DEV_AUTH_ENABLED` / `DEV_AUTH_SECRET` – allow dev headers for local auth only.
- `IDENTITY_ISSUER` / `IDENTITY_AUDIENCE` – expected JWT issuer/audience in production.
- `FIREBASE_PROJECT_ID` – Firebase project id for Admin SDK token verification.
- `WEBCHAT_INTEGRATIONS_JSON` – JSON array of `{name, tenantId, keyHash}` entries for server-held website credentials.

## Tenant Identity Rules (T-01)

- `tenantId` is authoritative from verified auth claims in production.
- Request body/query params are never trusted for tenant identity.
- Dev mode uses `x-dev-tenant-id` only when `DEV_AUTH_ENABLED=true`.

## Scripts

- `npm run start:dev` – watch mode via Nest CLI.
- `npm run build` – compile TypeScript into `dist`.
- `npm run start:prod` – run compiled build.
- `npm run emulator:token` – mint a local Firebase Auth emulator ID token.
- `npm run verify:token` – verify a Firebase ID token and print key claims.
- `npm run prisma:generate` – generate and link the Prisma client.
- `npm run arch:check` – enforce the controller, safety, migration, and prompt boundaries required by BE-003.

## Production readiness

Production startup requires a non-local PostgreSQL URL, a 24+ character admin token, an OpenAI key, Firebase project configuration, and development authentication disabled. Apply migrations with `npx prisma migrate deploy` before starting the service. The canonical reconciliation migration preserves the earlier prototype tables in the `legacy_2025` schema.
