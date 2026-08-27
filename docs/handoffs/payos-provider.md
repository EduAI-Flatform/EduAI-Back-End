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
