# Production GDS wallet release

## Behavior

Production requires NODE_ENV=production and DEPLOYMENT_CLASS=production. Reads and verified transfer recovery continue with both new admission flags off. GDS_WALLET_PRODUCTION_TOPUP_ENABLED and GDS_WALLET_PRODUCTION_CHECKOUT_ENABLED default false and independently admit new QR topups and checkout. Legacy UAT switches never enable production. Production APIs add mode=production and READY_PRODUCTION; sandbox clients remain supported. The frontend trusts server capabilities rather than a Vite UAT flag.

Topups use the existing website merchant channel, 2,000?10,000,000 VND per request. Signed webhook plus independent PayOS reconciliation are both required before one immutable credit. Checkout atomically captures GDS and settles/fulfills Commerce. No withdrawal, transfer or wallet refund is implemented; wallet settlements remain excluded from the external refund workflow. Never import UAT balances or copy UAT secrets.

## Database and runtime

Migration 20261103040000_harden_gds_runtime_projection changes only the canonical projection trigger function to SECURITY DEFINER with fixed search_path and validates its trigger relation. No models, tables, balances or historical entries change. Runtime cannot update funds/holds directly, create funded wallets, rewrite history or attach the privileged function to another trigger. The migration runner pins its checksum, reapplies bounded grants, and verifies GDS effective privileges. Expect 77 current migrations. Do not revert the SQL hardening or reset financial data when reverting application code.

## Rollout

1. Merge verified source through dev; deploy backend and frontend with admission flags false.
2. Confirm full migration postflight, runtimeRoleLeastPrivilegeReady, gdsRuntimeLeastPrivilegeReady and health. Inspect signed-in wallet: production state, topups and checkout paused, history readable.
3. Confirm isolated UAT database fingerprint (SHA256 of lowercase host:port/database, excluding credentials), production PayOS channel/webhook, HTTPS origin and unchanged Commerce secret. The activation helper rejects a matching database fingerprint.
4. Use manual Deploy Backend Production workflow inputs gds_wallet_topup=enable, gds_wallet_checkout=disable and gds_wallet_uat_database_fingerprint. Source pushes preserve settings. Do not change NODE_ENV or deployment classification to bypass checks.
5. Account owner creates and pays a 2,000 VND topup. Record topup ID and confirm signed inbox, independent provider proof, exactly one journal credit and balance. No agent transfers funds or marks payments paid manually.
6. Enable checkout with the manual workflow; account owner chooses a real order and confirms purchase. Verify one capture, canonical settlement, learning access and replay without another debit. Open general use only after these evidence gates pass.

## Pause/recovery

Set either workflow action to disable to stop that kind of new transaction. Keep the other setting preserve. Existing webhook processing, retries, cancellation of unpaid intents and wallet reads continue. Do not disable the worker or change merchant/HMAC credentials while pending transfers exist. Review mismatches without inventing payment proof. Recovery records and financial history remain append-only.

## Verification

Unit suites, full migrated PostgreSQL invariants, actual Prisma production/UAT course and membership checkout, browser fixtures at mobile/desktop, and explicit restricted-runtime/temp-trigger tests are CI release gates. External PayOS remains mocked in automated tests; the owner-run live topup/purchase is a separate required completion gate.
