/** Synthetic receipt capabilities never enable bank settlement. */
export function receiptSandboxEnabled(nodeEnv: string, env: NodeJS.ProcessEnv, buyerId: string): boolean {
  const buyers = (env.BANK_RECEIPT_SYNTHETIC_BUYER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return (nodeEnv === 'development' || nodeEnv === 'test')
    && env.BANK_TRANSFER_SANDBOX_ENABLED === 'true'
    && env.BANK_RECEIPT_SANDBOX_ENABLED === 'true' && buyers.includes(buyerId);
}

export function receiptEarlyAccessEnabled(nodeEnv: string, env: NodeJS.ProcessEnv, buyerId: string): boolean {
  return receiptSandboxEnabled(nodeEnv, env, buyerId) && env.BANK_RECEIPT_EARLY_ACCESS_ENABLED === 'true';
}