import { affiliateWalletPosting, affiliatePlatformCapacity } from './affiliate-wallet.rules';

describe('affiliate wallet funding and recovery', () => {
  it('reserves existing seller entitlements and never invents missing platform capacity', () => {
    expect(affiliatePlatformCapacity([{ basisAmountMinor: 1000n, platformAmountMinor: 200n, sellerAmountMinor: 800n, refundedMinor: 500n }], 1000n, 500n)).toBe(100n);
    expect(() => affiliatePlatformCapacity([], 1000n, 1000n)).toThrow('AFFILIATE_REVENUE_SNAPSHOT_INCOMPLETE');
  });
  it('recovers refunds as debt after funds have been withdrawn and repays debt before new cash', () => {
    expect(affiliateWalletPosting(-100n, 20n, 0n)).toEqual({ availableDeltaMinor: -20n, debtDeltaMinor: 80n });
    expect(affiliateWalletPosting(100n, 0n, 80n)).toEqual({ availableDeltaMinor: 20n, debtDeltaMinor: -80n });
  });
  it('does not disturb funds reserved for an in-flight withdrawal', () => {
    expect(affiliateWalletPosting(-100n, 0n, 0n)).toEqual({ availableDeltaMinor: 0n, debtDeltaMinor: 100n });
  });
});
