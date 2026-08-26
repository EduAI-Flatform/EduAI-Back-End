# PayOS provider boundary

The Payments module owns PayOS configuration and normalizes every provider
response before it can reach Commerce. Commerce services depend only on the
`PaymentProvider` token and must not import PayOS SDK types.

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

Official references:

- https://payos.vn/docs/moi-truong-test/
- https://payos.vn/docs/api/
- https://github.com/payOSHQ/payos-lib-node
