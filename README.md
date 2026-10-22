# JetonZone — server-backed private-test starter

This is a **deployment-ready starting codebase**, not a live deployed service. It includes a Node.js/Express API, SQLite order database, server-side order status, admin API, audit events, a seven-day personal-data purge, and a webhook shell. Real payments are deliberately disabled until a provider is chosen and its official signature/webhook contract is integrated.

## Requirements
- Node.js 20+
- A server/host that supports a persistent disk for SQLite (or replace SQLite with managed PostgreSQL before deploying to ephemeral/serverless hosting)
- HTTPS in production

## Local start
1. Copy `.env.example` to `.env`.
2. Set `ADMIN_KEY` and `PAYMENT_WEBHOOK_SECRET` to long random secrets (at least 32 characters).
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Important security behavior
- The site does not collect card number, CVV, PIN, or banking passwords.
- `PAYMENTS_ENABLED=false` by default. `/api/payments/start` refuses to accept payment until a real provider adapter is implemented.
- A client-side message or uploaded receipt cannot mark an order as paid.
- The generic webhook requires an HMAC signature and amount/currency match, but **must be adapted to the chosen provider's official webhook verification before production**.
- Admin endpoints require the `x-admin-key` header and an environment secret. This is a minimal starter, not a substitute for a full admin identity/access-control system.
- Service fulfillment endpoint refuses to fulfill an unpaid order. It records manual fulfillment only; it does not deliver TikTok services automatically.
- TikTok ID and contact fields are automatically purged after the configured retention period (7 days by default). Minimal transaction/status records remain. Review legal/accounting retention obligations before real commercial use.
- Never expose `.env`, database files, or admin keys publicly. Use HTTPS, backups, server access controls, and provider documentation before launch.

## Current limitations
- No real payment provider is connected.
- Some catalog services are intentionally unavailable until price/currency and fulfillment terms are defined.
- No live fulfillment provider is connected.
- No public deployment or domain has been configured.
