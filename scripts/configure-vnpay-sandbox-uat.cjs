const fs = require('node:fs');
const dotenv = require('dotenv');

function classifySandboxUat(source) {
  const env = dotenv.parse(source);
  if (env.PAYMENT_DEFAULT_PROVIDER !== 'vnpay' || env.VNPAY_ENVIRONMENT !== 'sandbox') return source;
  for (const [name, expected] of [
    ['VNPAY_PAYMENT_URL', 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'],
    ['VNPAY_API_URL', 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction'],
    ['VNPAY_RETURN_URL', 'https://eduai.giaoducso.org.vn/payments/return'],
    ['VNPAY_IPN_URL', 'https://api.eduai.giaoducso.org.vn/api/v1/payments/webhooks/vnpay'],
  ]) {
    if (env[name] !== expected) throw new Error('Sandbox UAT configuration does not match the approved target');
  }
  if (env.NODE_ENV !== 'production' || !/^[A-Za-z0-9]{8}$/.test(env.VNPAY_TMN_CODE || '') || !env.VNPAY_HASH_SECRET) {
    throw new Error('Sandbox UAT configuration is incomplete');
  }
  // Keep all technical production controls and credentials unchanged.
  return source.replace(/^\s*(?:export\s+)?DEPLOYMENT_CLASS\s*=.*(?:\r?\n|$)/gm, '')
    .replace(/\s*$/, '') + '\nDEPLOYMENT_CLASS=uat\n';
}

if (require.main === module) {
  try {
    const source = fs.readFileSync('.env', 'utf8');
    const updated = classifySandboxUat(source);
    if (source !== updated) fs.writeFileSync('.env', updated, { mode: 0o600 });
    console.log(`vnpaySandboxUatClassification: ${dotenv.parse(updated).DEPLOYMENT_CLASS === 'uat' ? 'uat' : 'unchanged'}`);
  } catch {
    console.error('Sandbox UAT configuration verification failed');
    process.exitCode = 1;
  }
}

module.exports = { classifySandboxUat };
