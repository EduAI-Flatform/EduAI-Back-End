export interface WeightedAmount { id: string; weight: bigint }
export interface AllocatedAmount { id: string; amountMinor: bigint }

/** Largest remainder; IDs are the stable tie breaker, never database return order. */
export function allocateMinor(amount: bigint, weights: WeightedAmount[]): AllocatedAmount[] {
  if (amount < 0n || weights.some(x => x.weight <= 0n) || new Set(weights.map(x => x.id)).size !== weights.length) throw new Error('Invalid allocation.');
  if (!weights.length) { if (amount === 0n) return []; throw new Error('Allocation recipients are required.'); }
  const total = weights.reduce((sum, x) => sum + x.weight, 0n);
  const parts = weights.map(x => ({ id: x.id, amountMinor: amount * x.weight / total, remainder: amount * x.weight % total }));
  let remaining = amount - parts.reduce((sum,x) => sum+x.amountMinor, 0n);
  const ordered = [...parts].sort((a,b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.remainder > b.remainder ? -1 : 1);
  for (const part of ordered) { if (remaining === 0n) break; part.amountMinor++; remaining--; }
  return parts.map(({ id, amountMinor }) => ({ id, amountMinor }));
}

export function splitRevenue(amount: bigint, platformFeeBps: number, weights: WeightedAmount[]) {
  if (amount < 0n || !Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10000) throw new Error('Invalid revenue basis or fee.');
  const platformAmountMinor = amount * BigInt(platformFeeBps) / 10000n;
  return { platformAmountMinor, shares: allocateMinor(amount - platformAmountMinor, weights) };
}

export function monthlyAmounts(amount: bigint, months: number): bigint[] {
  if (!Number.isSafeInteger(months) || months < 1 || months > 1200 || amount < 0n) throw new Error('Invalid membership term.');
  const base = amount / BigInt(months), remainder = amount % BigInt(months);
  return Array.from({length:months}, (_,i) => base + (BigInt(i) < remainder ? 1n : 0n));
}

/** Cumulative targets avoid rounding drift over multiple partial refunds. */
export function refundTargets(refunded: bigint, basis: bigint, originals: WeightedAmount[]) {
  if (basis < 0n || refunded < 0n || refunded > basis || originals.reduce((s,x) => s+x.weight,0n) !== basis) throw new Error('Invalid cumulative refund.');
  return allocateMinor(refunded, originals.filter(x => x.weight > 0n));
}
/** Split the whole term by month while preserving every participant's contracted term total. */
export function monthlyRevenueShares(originals: WeightedAmount[], months: number): AllocatedAmount[][] {
  const total = originals.reduce((sum,x) => sum+x.weight,0n);
  if (originals.some(x => x.weight < 0n) || new Set(originals.map(x => x.id)).size !== originals.length) throw new Error('Invalid original shares.');
  const remaining = originals.map(x => ({ ...x }));
  return monthlyAmounts(total, months).map(budget => {
    const allocated = allocateMinor(budget, remaining.filter(x => x.weight > 0n));
    for (const part of allocated) remaining.find(x => x.id === part.id)!.weight -= part.amountMinor;
    return originals.map(x => ({ id: x.id, amountMinor: allocated.find(p => p.id === x.id)?.amountMinor ?? 0n }));
  });
}