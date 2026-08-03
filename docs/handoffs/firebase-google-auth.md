# Firebase Google Auth Handoff

## Endpoint

`POST /api/v1/auth/firebase`

Request:

```json
{ "idToken": "firebase-id-token" }
```

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
non-empty `fullName` and `avatarUrl` values are preserved. New Google users
receive the default `student` role and do not receive a password hash.
