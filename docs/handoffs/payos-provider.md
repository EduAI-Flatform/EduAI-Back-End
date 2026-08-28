# PayOS provider boundary

The Payments module owns PayOS configuration and normalizes every provider
response before it can reach Commerce. Commerce services depend only on the
`PaymentProvider` token and must not import PayOS SDK types.

## Embedded checkout presentation

Normal course-cart and membership checkout flows use the official payOS
Embedded Checkout inside an EduAI Radix dialog. The Frontend loads the web SDK
directly from
`https://cdn.payos.vn/payos-checkout/v1/stable/payos-initialize.js`, passes
only the sanitized Backend `checkoutUrl`, and sets the SDK `RETURN_URL` to
the exact current EduAI page URL that hosts the iframe. It does not open or
navigate the browser to the hosted payOS page.

The existing Backend callback contract remains a safe fallback:

- `PAYOS_RETURN_URL=https://eduai.giaoducso.org.vn/payments/return`
- `PAYOS_CANCEL_URL=https://eduai.giaoducso.org.vn/payments/cancel`
- the Backend appends its learner-owned local `orderId` to both URLs

The SDK `onSuccess`, `onCancel`, and `onExit` callbacks are presentation
signals only. Every callback re-reads the authenticated canonical payment
request from the EduAI Backend. A success callback closes the dialog only after
that response reports `PAID`. The webhook remains the provider settlement
authority, and browser query parameters never mutate payment state.

The component exits the SDK instance and clears the embedded container on
close, route unmount, and React StrictMode replay. Closing and reopening the
dialog reuses the existing Frontend payment response and does not call the
payment-request creation API again.

Production currently sends no Frontend CSP header. If nginx or another reverse
proxy enables CSP, allow only the official payOS origins required by the SDK:

```text
script-src https://cdn.payos.vn
frame-src https://pay.payos.vn https://next.pay.payos.vn
connect-src https://payos.vn
```

Merge these origins into the existing directives rather than replacing the
site policy or adding wildcards. Verify the deployed checkout with zero CSP and
mixed-content errors.

## Runtime configuration

PayOS currently exposes only its production Merchant API; it does not provide
a sandbox or staging API. `PAYOS_ENVIRONMENT` therefore accepts only:

- `disabled` (default): no SDK client is created and every provider operation
  fails closed without a network request;
- `production`: allowed only with `NODE_ENV=production`, the official API
  origin, complete secrets, HTTPS callback URLs, and a bounded timeout.

The production secret store must provide `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`,
and `PAYOS_CHECKSUM_KEY`. Never expose, log, or place their values in evidence.
The non-secret settings are `PAYOS_API_BASE_URL`, `PAYOS_RETURN_URL`,
`PAYOS_CANCEL_URL`, `PAYOS_WEBHOOK_URL`, and `PAYOS_TIMEOUT_MS`. The API base
must remain `https://api-merchant.payos.vn`; timeout must be 1,000-60,000 ms.

The SDK is configured with logging off and automatic retries disabled. A
timeout or ambiguous network failure is returned as a sanitized retryable
provider error so the application reconciliation flow can decide the next
action using the stable local payment-attempt identity.

## Activation and rollback

Deployments remain safe with `PAYOS_ENVIRONMENT=disabled`; permanent Commerce
continues to operate but creates no PayOS request. Live activation requires a
separately approved payment release gate. Rollback restores
`PAYOS_ENVIRONMENT=disabled` and restarts the Backend with its approved
environment-loading path. It does not delete or rewrite payment, settlement,
order, audit, or reconciliation records.

The approved production activation checklist is:

1. Keep the existing `NODE_ENV=production` and configured
   `COMMERCE_IDEMPOTENCY_SECRET`. Set `PAYOS_ENVIRONMENT=production`.
2. Supply `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, and `PAYOS_CHECKSUM_KEY`
   only through the production secret store.
3. Set the non-secret callback contract exactly to
   `PAYOS_RETURN_URL=https://eduai.giaoducso.org.vn/payments/return`,
   `PAYOS_CANCEL_URL=https://eduai.giaoducso.org.vn/payments/cancel`, and
   `PAYOS_WEBHOOK_URL=https://api.eduai.giaoducso.org.vn/api/v1/payments/webhooks/payos`.
   `PAYOS_API_BASE_URL` defaults to and may only equal
   `https://api-merchant.payos.vn`; `PAYOS_TIMEOUT_MS` defaults to
   `10000` and is optional within the validated 1,000-60,000 ms range.
4. Run `npm run config:verify:production-commerce`. Sanitized output must
   report the Commerce idempotency secret configured, provider activation
   true, and provider disabled false. It never emits a value.
5. Run `npm run process:restart:production`. This loads the fixed environment,
   runs `pm2 restart eduai-backend --update-env`, then `pm2 save`.
6. Confirm readiness returns HTTP 200 before any UAT. The Frontend return and
   cancel routes are presentation only: the Backend adds the local `orderId`
   to each callback URL, and the authenticated page re-reads the learner-owned
   payment request. PayOS query fields never transition payment or cancellation
   state.

No additional PayOS variable is mandatory. The existing production database,
runtime-role, migration-role, CORS, monitoring, and application configuration
remain prerequisites but are not provider activation inputs.

After UAT, set `PAYOS_ENVIRONMENT=disabled`, rerun the same preflight and
require provider activation false plus provider disabled true, run
`npm run process:restart:production`, and confirm readiness HTTP 200. A
body-discarding malformed webhook check must again fail closed with HTTP 503.
Do not infer activation or settlement from a browser redirect.

Course and membership checkout create separate immutable orders. Production
coverage therefore requires two explicitly authorized low-value transactions:
one course order and one membership order. A mixed course-and-membership order
is not a supported checkout shape.

## Reconciliation operations

Platform administrators use the Commerce administration review queue. A run
polls at most 50 eligible attempts, in stable identifier order, and returns a
cursor when more work remains. Continue from that cursor after a process
restart; do not increase the bound or run overlapping scans. The route is
independently rate limited and each provider call completes before any database
transaction begins.

Review reasons distinguish provider outage, malformed/unknown status,
authoritative fact mismatch, and paid-but-not-fulfilled recovery. Late and
duplicate collections continue to use their settlement-backed cases. Provider
identifiers, raw responses, checkout/QR payloads, receiving accounts, and
credentials are intentionally absent from the administrator projection and
operational evidence.

An operator may acknowledge only non-collection operational evidence. A
paid-but-not-fulfilled case may close only after the idempotent fulfillment
retry commits. Duplicate and late collections require their dedicated
accept/refund workflow and cannot be acknowledged away. Resolution is
optimistically versioned, role protected, and writes lifecycle plus audit
evidence atomically; it never edits payment events or settlements.

If PayOS is disabled or unavailable, stop polling after the bounded run and
leave the safe outage cases open. Provider activation remains a separate
release decision. Alerts should use only aggregate open-case counts and safe
reason codes. Never copy response bodies or local/provider identities into
logs, tickets, or evidence.

Official references:

- https://payos.vn/docs/moi-truong-test/
- https://payos.vn/docs/api/
- https://github.com/payOSHQ/payos-lib-node
- https://payos.vn/docs/sdks/front-end/script-js/
