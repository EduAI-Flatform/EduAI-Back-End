const { classifySandboxUat } = require('../../../scripts/configure-vnpay-sandbox-uat.cjs');

const sandbox = `NODE_ENV=production
PAYMENT_DEFAULT_PROVIDER=vnpay
VNPAY_ENVIRONMENT=sandbox
VNPAY_TMN_CODE=TESTTMNC
VNPAY_HASH_SECRET=test-only-secret
VNPAY_PAYMENT_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_API_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_RETURN_URL=https://eduai.giaoducso.org.vn/payments/return
VNPAY_IPN_URL=https://api.eduai.giaoducso.org.vn/api/v1/payments/webhooks/vnpay
DEPLOYMENT_CLASS=production
JWT_ACCESS_SECRET=unchanged-test-secret
`;

describe('approved VNPay Sandbox deployment classification', () => {
  it('changes only deployment class and remains idempotent', () => {
    const updated = classifySandboxUat(sandbox);
    expect(updated).toBe(sandbox.replace('DEPLOYMENT_CLASS=production\n', '') + 'DEPLOYMENT_CLASS=uat\n');
    expect(classifySandboxUat(updated)).toBe(updated);
  });
  it('does not reclassify a production payment provider', () => {
    const production = sandbox.replace('VNPAY_ENVIRONMENT=sandbox', 'VNPAY_ENVIRONMENT=production');
    expect(classifySandboxUat(production)).toBe(production);
  });
  it.each(['NODE_ENV', 'VNPAY_TMN_CODE', 'VNPAY_PAYMENT_URL', 'VNPAY_API_URL', 'VNPAY_RETURN_URL', 'VNPAY_IPN_URL'])(
    'fails closed for an unapproved %s', (name: string) => {
      expect(() => classifySandboxUat(sandbox.replace(new RegExp(`${name}=.*`), `${name}=invalid`))).toThrow();
    },
  );
});
