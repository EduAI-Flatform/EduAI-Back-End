# Dependency audit security follow-up

## Status

Tracked separately from the PayOS payment security release. No dependency
upgrade is included in that release.

## Evidence

On 2026-08-28, the backend runtime audit command
`npm audit --omit=dev --audit-level=high` reported 27 existing advisories:
18 moderate and 9 high. The available remediation includes breaking upgrades
and must be handled as a separate compatibility and rollout change.

The audit output was reviewed without retaining credentials, provider
payloads, or other sensitive values. The payment security fix does not change
the dependency graph and does not broaden this follow-up.

## Required follow-up

Create a dedicated dependency-upgrade change that evaluates the affected
NestJS, parser, utility, and transitive packages; updates the lockfile only
after compatibility review; reruns the full backend test/type-check/build
gates; and deploys through the normal staged workflow. Do not use
`npm audit fix --force` as an unreviewed production change.
