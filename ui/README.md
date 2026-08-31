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

## Hosting

The operator UI has its own Firebase Hosting target and must never be deployed to the public Signmons marketing target.

```bash
NEXT_PUBLIC_API_URL=https://signmons-calldesk-staging-845074063310.us-east5.run.app npm run build
firebase deploy --only hosting:calldesk --project signmons
```

Production URL: `https://signmons-calldesk.web.app/app/intake-review`.

## Gates

```bash
npm run lint
npm test -- --runInBand
npm run build
```
