# Signmons CallDesk Operator UI

Private Next.js operator workspace for Signmons CallDesk.

## Local setup

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

The default API URL is `http://localhost:3000`.

## Routes

- `/` — tenant onboarding and AI triage sandbox.
- `/app/intake-review` — APP-006 booking-readiness queue and request detail.

The intake screen accepts a verified Firebase operator ID token in production. Local development may use `NEXT_PUBLIC_DEV_AUTH_SECRET`, `NEXT_PUBLIC_DEV_AUTH_ROLE`, `NEXT_PUBLIC_DEV_AUTH_USER_ID`, and `NEXT_PUBLIC_TENANT_ID`; development headers are rejected by the backend in production.

## Gates

```bash
npm run lint
npm test -- --runInBand
npm run build
```
