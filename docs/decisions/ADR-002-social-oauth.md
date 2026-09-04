# ADR-002: Facebook and Zalo OAuth identities with EduAI sessions

## Status

Accepted

## Context

EduAI already authenticates Google users through Firebase and issues its own
access/refresh-token session. Facebook and Zalo need a browser OAuth
authorization-code flow without exposing provider secrets or replacing the
existing Google and local-password paths.

## Decision

- Keep the existing Firebase Google flow and local email/password endpoints
  unchanged.
- Add backend-owned Facebook and Zalo authorization-code adapters. The
  browser is redirected to the provider, while code exchange and profile
  requests happen only on the backend.
- Store OAuth state and short-lived exchange tickets as one-time values. Redis
  is required in production; a bounded in-memory fallback is available only in
  non-production environments.
- Add the additive oauth_accounts table with a unique
  (provider, provider_user_id) identity. Google Firebase UIDs are not
  backfilled into this table because Firebase UID is not the provider's raw
  Google identity ID.
- Reuse the existing EduAI JWT/refresh-token issuer after a social identity is
  resolved. Provider access tokens, authorization codes, raw state, and client
  secrets are never persisted or logged.
- Do not silently merge a social identity into an existing account based only
  on email. A collision returns SOCIAL_ACCOUNT_LINK_REQUIRED; explicit
  account-linking UX can be added later.
- Providers are disabled by default. Enabling one requires complete backend
  configuration, production HTTPS callbacks, Redis, and provider-console
  review.
- Keep every first-time external identity pending until the user explicitly
  selects a student or instructor role. If a provider does not return an
  email, collect it during the same onboarding completion. The supplied email
  is not treated as provider-verified and is never used for implicit account
  linking or recovery; email verification remains follow-up work.

## Consequences

- Facebook and Zalo can share the established EduAI session and role model
  without changing Google behavior.
- OAuth callback URLs expose only a short-lived, one-time ticket to the
  frontend; they do not contain provider access tokens.
- First-time social login has an explicit role-onboarding step; providers
  without an email have an additional profile-completion field.
- Existing users must use an explicit linking flow when their provider email
  already belongs to another EduAI account.
- Google identity normalization remains a separate migration decision and is
  intentionally out of scope for this increment.
- The Prisma migration is additive and has no automatic rollback that drops
  external identities. Roll back application code first if needed; any
  database removal must be an explicit, separately reviewed data operation
  after confirming that no social identities were created.
