import { ConflictException } from '@nestjs/common';

/** Capacity is bounded by frozen seller-first snapshots; it never reduces seller shares. */
export function affiliatePlatformCapacity(snapshots: Array<{ basisAmountMinor: bigint; platformAmountMinor: bigint; sellerAmountMinor: bigint; refundedMinor?: bigint }>, gross: bigint, net: bigint) {
  if (!snapshots.length || snapshots.reduce((sum, row) => sum + row.basisAmountMinor, 0n) !== gross
    || snapshots.some(row => row.basisAmountMinor !== row.platformAmountMinor + row.sellerAmountMinor)) {
    throw new ConflictException('AFFILIATE_REVENUE_SNAPSHOT_INCOMPLETE');
  }
  if (snapshots.reduce((sum, row) => sum + (row.refundedMinor ?? 0n), 0n) !== gross - net
    || snapshots.some(row => (row.refundedMinor ?? 0n) < 0n || (row.refundedMinor ?? 0n) > row.basisAmountMinor)) {
    throw new ConflictException('AFFILIATE_REFUND_ALLOCATION_INCOMPLETE');
  }
  // Round remaining platform capacity down per line: seller refund apportionment is unchanged.
  return snapshots.reduce((sum, row) => sum + (row.basisAmountMinor === 0n ? 0n
    : row.platformAmountMinor * (row.basisAmountMinor - (row.refundedMinor ?? 0n)) / row.basisAmountMinor), 0n);
}

export function affiliateWalletPosting(delta: bigint, available: bigint, debt: bigint) {
  const debtDeltaMinor = delta > 0n ? -(delta < debt ? delta : debt)
    : -delta - (-delta < available ? -delta : available);
  return { availableDeltaMinor: delta + debtDeltaMinor, debtDeltaMinor };
}
