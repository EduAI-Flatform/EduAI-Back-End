const { test } = require('node:test');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const { configureGdsProductionWallet } = require('./configure-gds-production-wallet.cjs');
const base = 'NODE_ENV=production\nDEPLOYMENT_CLASS=production\nDATABASE_URL=postgresql://runtime:keep-secret@production.example/eduai\nPAYOS_ENVIRONMENT=production\nPAYOS_CLIENT_ID=merchant\nPAYOS_API_KEY=api-secret\nPAYOS_CHECKSUM_KEY=checksum-secret\nPAYOS_WEBHOOK_URL=https://api.eduai.giaoducso.org.vn/api/v1/payments/webhooks/payos\nPAYOS_RETURN_URL=https://eduai.giaoducso.org.vn/payments/return\nPAYOS_CANCEL_URL=https://eduai.giaoducso.org.vn/payments/return\nPUBLIC_APP_URL=https://eduai.giaoducso.org.vn\nCOMMERCE_IDEMPOTENCY_SECRET='+ 's'.repeat(32)+'\n';
const options = { topup: 'enable', checkout: 'disable', uatFingerprint: 'a'.repeat(64) };
test('default deployment preserves the environment byte for byte', () => { assert.equal(configureGdsProductionWallet(base, {}), base); });
test('explicit activation changes only wallet controls and preserves secrets', () => {
 const result = dotenv.parse(configureGdsProductionWallet(base, options));
 assert.equal(result.GDS_WALLET_PRODUCTION_TOPUP_ENABLED, 'true');
 assert.equal(result.GDS_WALLET_PRODUCTION_CHECKOUT_ENABLED, 'false');
 assert.equal(result.PAYOS_API_KEY, 'api-secret');
 assert.equal(result.DATABASE_URL, dotenv.parse(base).DATABASE_URL);
 assert.equal(result.GDS_WALLET_UAT_DATABASE_FINGERPRINT, 'a'.repeat(64));
});
test('disables either admission capability independently without changing merchant configuration', () => {
 const active = configureGdsProductionWallet(base, { ...options, checkout: 'enable' });
 const off = dotenv.parse(configureGdsProductionWallet(active, { topup: 'disable' }));
 assert.equal(off.GDS_WALLET_PRODUCTION_TOPUP_ENABLED,'false');
 assert.equal(off.GDS_WALLET_PRODUCTION_CHECKOUT_ENABLED,'true');
});
test('rejects invalid actions, activation without isolation evidence and non-production runtimes', () => {
 for (const opts of [{ topup:'anything' },{topup:'enable'},options]) {
 const source=opts===options?base.replace('NODE_ENV=production','NODE_ENV=development'):base;
 assert.throws(()=>configureGdsProductionWallet(source,opts));
 }
});
test('cannot activate on the UAT database fingerprint', () => {
 const { createHash }=require('node:crypto');
 const fingerprint=createHash('sha256').update('production.example:5432/eduai').digest('hex');
 assert.throws(()=>configureGdsProductionWallet(base,{...options,uatFingerprint:fingerprint}));
});


test('explicit activation retires legacy VPS UAT classification without changing keys or NODE_ENV',()=>{
 const legacy=base.replace('DEPLOYMENT_CLASS=production','DEPLOYMENT_CLASS=uat')+'PAYMENT_DEFAULT_PROVIDER=vnpay\nVNPAY_ENVIRONMENT=sandbox\n';
 const active=dotenv.parse(configureGdsProductionWallet(legacy,options));
 assert.equal(active.NODE_ENV,'production');assert.equal(active.DEPLOYMENT_CLASS,'production');assert.equal(active.PAYMENT_DEFAULT_PROVIDER,'payos');assert.equal(active.PAYOS_API_KEY,'api-secret');
});
