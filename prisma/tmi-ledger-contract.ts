export type TmiLedgerKind = "earn" | "redeem" | "refund" | "adjustment" | "expiry";
export type TmiAdjustmentDirection = "credit" | "debit";

export type TmiLedgerEntry = {
  kind: TmiLedgerKind;
  amount: number;
  adjustmentDirection?: TmiAdjustmentDirection;
  sourceType: string;
  sourceId: string;
  actorId: string;
  occurredAt: string;
  expiresAt?: string | null;
};

export type TmiWalletSummary = {
  current: number;
  earned: number;
  spent: number;
  expired: number;
};

export type TmiRedemptionDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: "invalid_amount" | "insufficient_balance" | "replayed_request" };

export function summarizeTmiWallet(entries: TmiLedgerEntry[], now: string): TmiWalletSummary {
  let earned = 0;
  let spent = 0;
  let expired = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.amount) || entry.amount <= 0) continue;
    if (entry.kind === "earn" || entry.kind === "refund" || (entry.kind === "adjustment" && entry.adjustmentDirection === "credit")) {
      earned += entry.amount;
    } else if (entry.kind === "expiry") {
      expired += entry.amount;
      spent += entry.amount;
    } else {
      spent += entry.amount;
    }
  }
  return { current: Math.max(0, earned - spent), earned, spent, expired };
}

export function evaluateTmiRedemption(
  summary: TmiWalletSummary,
  cost: number,
  replayed: boolean,
): TmiRedemptionDecision {
  if (replayed) return { allowed: false, reason: "replayed_request" };
  if (!Number.isInteger(cost) || cost <= 0) return { allowed: false, reason: "invalid_amount" };
  if (summary.current < cost) return { allowed: false, reason: "insufficient_balance" };
  return { allowed: true, remaining: summary.current - cost };
}
