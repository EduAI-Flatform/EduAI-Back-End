# Firebase Google Auth Handoff

## Endpoint

`POST /api/v1/auth/firebase`

Request:

```json
{ "idToken": "firebase-id-token", "mode": "login", "role": "student" }
```

`mode` is optional and defaults to `login`. `role` is optional and only applies
when creating a new Firebase user. Existing PostgreSQL roles are preserved.
When `mode` is `register`, an existing Firebase/email match returns
`ACCOUNT_ALREADY_EXISTS` instead of logging the user in.

The response uses the existing success envelope and login data:
`accessToken`, `refreshToken`, `tokenType`, `expiresIn`, and `user`.

## Configuration

Set these backend environment variables from the Firebase Admin service
account. Keep the private key escaped with `\\n` when stored in a single-line
environment variable:

```env
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

Never commit `.env`, service-account JSON, Firebase ID tokens, or Google access
tokens.

## Data behavior

Users are matched by `firebaseUid` first and normalized email second. Existing
non-empty `fullName` and `avatarUrl` values are preserved. The endpoint accepts
Firebase providers `google.com` and `password`.

Google users can sign in immediately. Password-provider users must have
`email_verified=true`; otherwise the endpoint returns `EMAIL_NOT_VERIFIED` and
does not issue an EduAI JWT session. New users receive the requested role (or
`student`) and never receive a password hash.

`/api/v1/auth/register` and `/api/v1/auth/login` remain legacy bcrypt endpoints
for existing local accounts. The web frontend uses Firebase registration and
login instead.

Firebase auth errors use stable codes and Vietnamese messages, including
`INVALID_FIREBASE_TOKEN`, `ACCOUNT_BLOCKED`, `ACCOUNT_LINK_CONFLICT`, and
`FIREBASE_NOT_CONFIGURED`.
