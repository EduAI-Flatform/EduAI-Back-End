# ADR-001: Firebase Google identity with EduAI JWT sessions

## Status

Accepted

## Context

EduAI needs Google sign-in through Firebase Authentication while PostgreSQL
remains the source of truth for application users and the existing EduAI JWT
access/refresh-token flow remains unchanged.

## Decision

The backend accepts a Firebase ID token at `POST /api/v1/auth/firebase`,
verifies it with `firebase-admin`, requires a verified email and
`firebase.sign_in_provider === "google.com"`, then finds or creates the
PostgreSQL user by `firebaseUid` or normalized email. EduAI issues its own
access and hashed refresh tokens after successful synchronization.

Google-only users have a nullable `passwordHash`, `authProvider=google`, a
unique `firebaseUid`, and `emailVerified=true`. Existing local users are
defaulted to `authProvider=local` and can be linked without overwriting a
custom name or avatar.

## Consequences

- Firebase ID tokens and Google access tokens are never stored in PostgreSQL.
- Local email/password login remains available for users with a password hash.
- Firebase configuration is optional at application boot but must be complete
  when supplied; the Firebase endpoint reports a configuration error if absent.
- Account linking is protected against conflicting Firebase UID/email matches.
