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
- No `GDS_PAYOS_RECEIVING_ACCOUNT` is required. PayOS returns its actual
  `accountNumber` with the payment link. The backend binds its SHA-256 hash
  once, then checks signed webhooks and reconciled transfers against it.
- The account binding belongs to **one PayOS payment attempt**, not all orders
  or the merchant forever. A new topup request with a fresh idempotency key
  reserves a fresh order code/link and may legitimately bind another account.
  A repeated key refers to its existing attempt and must not issue a second
  link; the current UAT endpoint returns a conflict for an already issued QR.
  It never silently changes the beneficiary. If the recipient changes *within the
  same link*, the signed event enters manual REVIEW without automatic credit.
- AntiFake likewise creates the PayOS link using its PayOS channel credentials
  and identifies a wallet topup by the returned payment link and amount; the
  per-link beneficiary hash is an additional EduAI reconciliation safeguard.
- This binding change adds a non-destructive database migration
  `20261103010000_bind_gds_payos_receiving_account`. Apply it to Neon **TEST**
  before deploying this backend code; the existing production schema and
  runtime remain untouched.
- `NODE_ENV=development` is appropriate for an isolated UAT instance, not the
  public production backend. The runtime has development CORS defaults, returns
  more descriptive internal errors, and uses local rate limits when Redis is
  absent. Keep `NODE_ENV=production` on the VPS with real users.
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
