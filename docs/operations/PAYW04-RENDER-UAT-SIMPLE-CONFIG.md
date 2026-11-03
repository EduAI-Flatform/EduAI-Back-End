# PAYW-04 — Simplified Render development UAT configuration

This is a source/runtime configuration guide, **not** a production wallet activation approval.

## Render build failure: `nest: not found`

The Nest CLI and TypeScript compiler are build-time development dependencies.
Render's existing dashboard build command `npm install; npm run build` does not
guarantee installing those dependencies, and `;` runs the build even when install
fails. Set **Build Command** in the existing Render service to:

```sh
npm ci --include=dev && npm run build
```

Then choose **Clear build cache & deploy**. Keep **Start Command** as
`npm run start`. Do not put Prisma migrations into an automatic build command;
apply reviewed migrations separately against the isolated Neon TEST database.

## UAT variables

```ini
NODE_ENV=development
DEPLOYMENT_CLASS=uat
GDS_WALLET=true
PAYMENT_DEFAULT_PROVIDER=payos
PAYOS_ENVIRONMENT=production
PAYOS_CLIENT_ID=<PERSONAL_CHANNEL_ID>
PAYOS_API_KEY=<PERSONAL_API_KEY>
PAYOS_CHECKSUM_KEY=<PERSONAL_CHECKSUM_KEY>
GDS_PAYOS_RECEIVING_ACCOUNT=<PERSONAL_CHANNEL_RECEIVING_ACCOUNT>
DATABASE_URL=<NEON_TEST_DATABASE_URL>
JWT_ACCESS_SECRET=<UAT_ONLY_SECRET>
JWT_REFRESH_SECRET=<UAT_ONLY_STABLE_SECRET_AT_LEAST_32_CHARACTERS>
PUBLIC_APP_URL=<VERCEL_DEV_HTTPS_ORIGIN>
CORS_ALLOWED_ORIGINS=<VERCEL_DEV_HTTPS_ORIGIN>
PAYOS_RETURN_URL=<VERCEL_DEV_HTTPS_ORIGIN>/wallet/gds
PAYOS_CANCEL_URL=<VERCEL_DEV_HTTPS_ORIGIN>/wallet/gds
PAYOS_WEBHOOK_URL=https://eduai-back-end.onrender.com/api/v1/payments/webhooks/payos
```

- The single `GDS_WALLET=true` flag maps to wallet reads, PayOS QR creation,
  and wallet checkout **for explicitly classified non-production UAT only**.
  `GDS_WALLET=false` disables all three. Existing three legacy switches still
  work when `GDS_WALLET` is absent; the new switch takes precedence when present.
- `PAYOS_ENVIRONMENT=production` is the official real PayOS API and is
  independent of `NODE_ENV`. **Personal PayOS QR can receive real funds** on UAT.
- For this *new, isolated TEST database only*, an explicit Commerce HMAC secret
  is optional when `JWT_REFRESH_SECRET` has at least 32 stable characters: the
  server derives a domain-separated HMAC key. Keep this refresh key unchanged
  throughout TEST. Never copy production keys into Render.
- **Production must retain its existing `COMMERCE_IDEMPOTENCY_SECRET`**. It is
  used for historical payment and account HMAC identifiers and must not be
  removed or rotated casually; the UAT fallback deliberately does not apply in
  a production Node runtime.
- Set `PAYOS_API_BASE_URL=https://api-merchant.payos.vn` explicitly only if
  necessary; the official URL is already the code default.
- Preserve other operational variables required by auth, Redis or integrations
  if actually enabled, but do not point them at production user data.

## Production release boundary

The one-key operator interface can be carried into `main` without enabling
the wallet. Core wallet config still rejects production `NODE_ENV` or
`DEPLOYMENT_CLASS=production` even when `GDS_WALLET=true`. A separate reviewed
production wallet release and migration are needed to change that boundary.
Never treat a green Render build or a generated QR as proof that GDS was funded.
