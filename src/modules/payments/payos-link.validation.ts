/** Shared bounds for authenticated PayOS SDK link facts. Preserve account bytes. */
export function isPayosAccount(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function isPayosLinkIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function isPayosQr(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192;
}
export function isPayosCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      (url.hostname === 'pay.payos.vn' || url.hostname === 'next.pay.payos.vn');
  } catch { return false; }
}
export function payosLinkIssues(value: {
  status?: unknown; receivingAccount?: unknown; providerPaymentIdentity?: unknown;
  qrPayload?: unknown; checkoutUrl?: unknown;
}): string[] {
  return [
    ...(value.status === 'PENDING' ? [] : ['status_not_pending']),
    ...(isPayosAccount(value.receivingAccount) ? [] : ['invalid_receiving_account']),
    ...(isPayosLinkIdentity(value.providerPaymentIdentity) ? [] : ['invalid_link_identity']),
    ...(isPayosQr(value.qrPayload) ? [] : ['invalid_qr_payload']),
    ...(isPayosCheckoutUrl(value.checkoutUrl) ? [] : ['untrusted_checkout_url']),
  ];
}
