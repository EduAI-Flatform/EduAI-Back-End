# Facebook and Zalo OAuth Handoff

## Status

The backend and web UI are implemented and locally verified. The rollout is
Facebook-first on the current public EduAI environment: deploy with both
provider flags off, verify the deployed contract, then configure and enable
Facebook only after Meta settings and operator-owned credentials are ready.
Zalo remains disabled. No provider is enabled by this document alone.

The public production origins declared by the workspace are:

- frontend: `https://eduai.giaoducso.org.vn`
- API: `https://api.eduai.giaoducso.org.vn`

The public legal pages used for Meta configuration are:

- privacy policy: `https://eduai.giaoducso.org.vn/privacy`
- data deletion instructions: `https://eduai.giaoducso.org.vn/data-deletion`

The live production API currently reports Redis health `ok`, but the social
OAuth routes are only available after the authorized production deployment.

## Endpoints

All routes are under /api/v1:

- GET /auth/oauth/providers returns `{ google, facebook, zalo }` capability
  flags. Google is always `true` for the existing Firebase flow; Facebook and
  Zalo are `false` until their complete backend configuration is present.
- GET /auth/oauth/:provider/start validates the requested mode, role, and
  local redirect, then returns a 302 to the provider.
- GET /auth/oauth/:provider/callback consumes one-time state, exchanges the
  provider code, and redirects to /auth/callback?ticket=....
- POST /auth/oauth/exchange consumes the ticket and returns either the
  standard EduAI session or a short-lived profile-completion ticket.
- POST /auth/oauth/complete-profile completes an identity with a missing
  email and returns the standard EduAI session.

login is the default mode. Registration sends the selected student or
instructor role. Existing roles are preserved and an existing email collision
is not silently linked.

The Prisma migration is
20260903000000_add_external_oauth_identities. It is additive and preserves
existing Firebase users. Validate it with prisma validate, deploy it with the
repository migration workflow, and treat dropping oauth_accounts as a separate
data-destruction decision rather than a rollback default.

## Environment

Set these backend variables only in a secret manager or an untracked local
environment file:

~~~
OAUTH_STATE_SECRET=
OAUTH_FRONTEND_CALLBACK_URL=https://eduai.giaoducso.org.vn/auth/callback
OAUTH_STATE_TTL_SECONDS=300
OAUTH_TICKET_TTL_SECONDS=120
OAUTH_HTTP_TIMEOUT_MS=10000

FACEBOOK_OAUTH_ENABLED=false
FACEBOOK_CLIENT_ID=
FACEBOOK_CLIENT_SECRET=
FACEBOOK_REDIRECT_URI=https://api.eduai.giaoducso.org.vn/api/v1/auth/oauth/facebook/callback
FACEBOOK_GRAPH_API_VERSION=v26.0

ZALO_OAUTH_ENABLED=false
ZALO_APP_ID=
ZALO_APP_SECRET=
ZALO_REDIRECT_URI=https://api.eduai.giaoducso.org.vn/api/v1/auth/oauth/zalo/callback
ZALO_AUTH_VERSION=v4
ZALO_GRAPH_API_VERSION=v2.0
ZALO_OAUTH_SCOPES=id_name,picture
~~~

The production callback contract above is derived from the declared frontend
and API origins plus the fixed callback paths enforced by `env.validation.ts`.
It is not evidence that those values are configured in the live server yet.
`OAUTH_STATE_SECRET` must be at least 32 characters. Production requires
Redis; the state/ticket store intentionally fails closed if Redis is
unavailable. Do not copy provider secrets into frontend `VITE_*` variables.

## Exact callback contract

| Environment | Frontend auth callback | Facebook callback | Zalo callback | Status |
| --- | --- | --- | --- | --- |
| Local development | `http://localhost:5173/auth/callback` | `http://localhost:3000/api/v1/auth/oauth/facebook/callback` | `http://localhost:3000/api/v1/auth/oauth/zalo/callback` | Declared in `.env.example` |
| Current public environment | `https://eduai.giaoducso.org.vn/auth/callback` | `https://api.eduai.giaoducso.org.vn/api/v1/auth/oauth/facebook/callback` | `https://api.eduai.giaoducso.org.vn/api/v1/auth/oauth/zalo/callback` | Facebook target; Zalo disabled |

The frontend success surface is the same `/auth/callback` route, followed by
the validated `redirectTo` destination stored in the one-time transaction.

## Environment-variable contract

Each variable below is a backend/runtime variable. A `YES` exposure value
means the value is non-secret metadata; the implementation still keeps the
environment variable server-side and exposes only derived capability booleans
to the browser.

| VARIABLE= | USED_BY= | SECRET=YES/NO | REQUIRED_WHEN= | SAFE_TO_EXPOSE_TO_BROWSER=YES/NO |
| --- | --- | --- | --- | --- |
| `REDIS_URL=` | `RedisConfigService`, `OAuthTransactionStore`, production rate-limit paths | YES | Required for production OAuth/state, ticket, and fail-closed shared state | NO |
| `OAUTH_STATE_SECRET=` | HMACs OAuth state/ticket storage keys | YES | Any social provider enabled; minimum 32 characters | NO |
| `OAUTH_FRONTEND_CALLBACK_URL=` | Builds success/error redirects to the frontend callback page | NO | Any social provider enabled; fixed `/auth/callback` path | YES |
| `OAUTH_STATE_TTL_SECONDS=` | State-store expiration | NO | Optional; default 300 seconds when OAuth is used | YES |
| `OAUTH_TICKET_TTL_SECONDS=` | Ticket-store expiration | NO | Optional; default 120 seconds when OAuth is used | YES |
| `OAUTH_HTTP_TIMEOUT_MS=` | Provider token/profile request abort timeout | NO | Optional; default 10,000 ms when OAuth is used | YES |
| `FACEBOOK_OAUTH_ENABLED=` | Facebook capability and route gate | NO | Always present as `false`; `true` only after complete Facebook config | YES |
| `FACEBOOK_CLIENT_ID=` | Meta authorization and token requests | NO | Facebook enabled | YES |
| `FACEBOOK_CLIENT_SECRET=` | Meta token exchange | YES | Facebook enabled | NO |
| `FACEBOOK_REDIRECT_URI=` | Meta authorization/token redirect binding | NO | Facebook enabled; exact `/api/v1/auth/oauth/facebook/callback` | YES |
| `FACEBOOK_GRAPH_API_VERSION=` | Meta authorization, token, and profile endpoints | NO | Facebook enabled; current implementation expects `v26.0`-style version | YES |
| `ZALO_OAUTH_ENABLED=` | Zalo capability and route gate | NO | Always `false` for this release; `true` only after a separate gate | YES |
| `ZALO_APP_ID=` | Zalo authorization and token requests | NO | Zalo enabled | YES |
| `ZALO_APP_SECRET=` | Zalo V4 `secret_key` token header | YES | Zalo enabled | NO |
| `ZALO_REDIRECT_URI=` | Zalo authorization redirect binding | NO | Zalo enabled; exact `/api/v1/auth/oauth/zalo/callback` | YES |
| `ZALO_AUTH_VERSION=` | Zalo authorization and token endpoints | NO | Zalo enabled; must be `v4` | YES |
| `ZALO_GRAPH_API_VERSION=` | Zalo profile endpoint | NO | Zalo enabled; current implementation uses `v2.0` | YES |
| `ZALO_OAUTH_SCOPES=` | Validation/operator record for Zalo console permissions | NO | Zalo enabled; minimum `id_name,picture`; not sent as a browser scope query | YES |

## Provider-console actions

### Facebook

In Meta for Developers:

1. Add the Facebook Login product and configure the web app domain.
2. Register the exact HTTPS callback URI from `FACEBOOK_REDIRECT_URI`.
3. Request only `public_profile,email` as implemented and complete the
   privacy policy, data deletion, and app-review requirements.
4. Keep the app in development while testing, then switch to live only after
   review and UAT. The current implementation pins the Graph API version to
   the configured `FACEBOOK_GRAPH_API_VERSION` (default/example: `v26.0`).

Use these public URLs in the Meta app configuration:

- App Domains: `eduai.giaoducso.org.vn`, `api.eduai.giaoducso.org.vn`
- Website URL: `https://eduai.giaoducso.org.vn/`
- Privacy Policy URL: `https://eduai.giaoducso.org.vn/privacy`
- Data Deletion Instructions URL: `https://eduai.giaoducso.org.vn/data-deletion`

References: [Meta Facebook Login flow](https://developers.facebook.com/docs/facebook-login/manually-build-a-login-flow/),
[Meta User Graph API](https://developers.facebook.com/docs/graph-api/reference/user/),
and [Meta data deletion callback and instructions](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/).

### Zalo

Zalo remains disabled and is not part of the current-environment enablement.
When its separate gate opens, use the current Zalo V4 flow in the developer
console:

1. Configure the web domain and register the exact HTTPS callback URI from
   `ZALO_REDIRECT_URI`.
2. Enable only the minimum profile permissions recorded by
   `ZALO_OAUTH_SCOPES` (`id_name,picture`). Zalo does not provide an email in
   this integration, so the UI must retain the profile-completion path.
3. Use `ZALO_AUTH_VERSION=v4`. The backend generates and stores a PKCE
   verifier, sends its S256 challenge, and sends the verifier plus `secret_key`
   only from the backend token exchange.
4. Complete any review or production-approval steps required by the app.

References: [Zalo Social overview](https://docs.zaloplatforms.com/docs/Social),
[Zalo V4 access-token flow](https://docs.zaloplatforms.com/docs/Social/social-api/tham-khao/user-access-token-v4),
and [Zalo profile API](https://docs.zaloplatforms.com/docs/Social/social-api/tai-lieu/thong-tin-ten-anh-dai-dien).

## Facebook-first current-environment operator checklist

The authorized operator owns the Meta app credentials and provider-console
changes. Deploy the code with both flags off first, then complete this
sequence on the current public environment:

1. Verify the exact production values for `OAUTH_FRONTEND_CALLBACK_URL` and
   `FACEBOOK_REDIRECT_URI` from the contract above.
2. Confirm production `REDIS_URL` is reachable, its transport is encrypted or
   private-network protected, and `OAUTH_STATE_SECRET` is a distinct secret
   of at least 32 characters. Record only sanitized health booleans.
3. Create/configure the Meta app in development mode with the app domains,
   website, privacy, data-deletion, and exact callback URLs listed above.
4. Set only production backend values, with `FACEBOOK_OAUTH_ENABLED=true`
   and `ZALO_OAUTH_ENABLED=false`; restart through the normal deployment
   process and verify `/api/v1/auth/oauth/providers` returns
   `{ google: true, facebook: true, zalo: false }` without secrets.
5. Run the checklist in `EduAI_Docs/docs/qa/social-oauth-qa-checklist.md`:
   login, student/instructor registration, cancel/deny, replay/tamper,
   provider failure, email collision, mobile/PWA callback, and Google/password
   regressions. Confirm no token, code, secret, or session material reaches
   browser storage or logs.
6. If credentials or Meta settings are unavailable, leave both flags false
   and record `IMPLEMENTATION_STATUS=AWAITING_FACEBOOK_OPERATOR_CONFIGURATION`.
   Do not claim Facebook UAT until the provider round trip is observed.

Zalo must remain disabled during this Facebook-first sequence.

## Account and security policy

- The provider identity is unique by (provider, provider_user_id).
- A provider email match does not merge accounts automatically.
- A missing provider email creates a time-limited pending external identity;
  the submitted email is unverified until the normal email-verification
  capability exists.
- State and tickets are HMAC-keyed, one-time, TTL-bound, and never placed in
  logs. Redis uses `eduai:auth:oauth:{state|ticket}:<sha256>` keys, `SET EX NX`
  for writes, and atomic GET+DEL consumption. The in-memory fallback is
  non-production only; production fails closed when Redis is unavailable.
- Current defaults are state TTL 300 seconds, ticket TTL 120 seconds, and
  upstream timeout 10,000 ms.
- Enable one provider at a time in a non-production environment and confirm
  the production callback, redirect allowlist, Redis, and audit events before
  any production change.

## Manual UAT checklist

For the Facebook-first current-environment gate, run on desktop Chrome, desktop
Safari/WebKit, iOS Safari, Android Chrome, and the installed/PWA surface at
the widths documented in
EduAI_Docs/docs/qa/social-oauth-qa-checklist.md:

- provider capability flags hide disabled providers and show enabled providers;
- capability response reports Google true, Facebook true, and Zalo false;
- Facebook login and registration complete with the correct mode and role;
- cancel and deny return a safe Vietnamese error without a session;
- expired, replayed, tampered, and cross-provider state/tickets fail safely;
- an existing provider identity returns the normal EduAI session;
- an existing email collision does not silently link;
- for the future Zalo gate, a no-email account completes the required email step;
- mobile back navigation, refresh, deep-link callback, and PWA launch remain
  usable;
- embedded browsers are either supported by the provider configuration or
  display the existing recovery guidance.

Zalo login/register is intentionally not a current exit criterion and must
remain disabled.
