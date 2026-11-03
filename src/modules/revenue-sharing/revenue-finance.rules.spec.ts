import { allocateMinor, splitRevenue, monthlyAmounts, monthlyRevenueShares, refundTargets } from './revenue-finance.rules';
import { addCalendarMonths } from '../memberships/membership.rules';

describe('revenue finance rules', () => {
  it('preserves every dong and breaks remainder ties by course ID', () => {
    expect(allocateMinor(5n, [{ id: 'b', weight: 1n }, { id: 'a', weight: 1n }])).toEqual([
      { id: 'b', amountMinor: 2n }, { id: 'a', amountMinor: 3n },
    ]);
  });
  it('splits retail net proceeds and weighted membership proceeds', () => {
    expect(splitRevenue(500000n, 2000, [{ id: 'a', weight: 1n }])).toEqual({ platformAmountMinor: 100000n, shares: [{ id: 'a', amountMinor: 400000n }] });
    expect(splitRevenue(300000n, 4000, [{ id: 'a', weight: 2n }, { id: 'b', weight: 1n }, { id: 'c', weight: 1n }]).shares.map(x => x.amountMinor)).toEqual([90000n, 45000n, 45000n]);
  });
  it('rejects invalid recipients and basis instead of dropping money', () => {
    expect(() => allocateMinor(1n, [])).toThrow();
    expect(() => allocateMinor(1n, [{ id: 'a', weight: 0n }])).toThrow();
    expect(() => allocateMinor(1n, [{ id: 'a', weight: 1n }, { id: 'a', weight: 2n }])).toThrow();
    expect(() => splitRevenue(-1n, 1000, [])).toThrow();
    expect(() => splitRevenue(100n, 10001, [])).toThrow();
    expect(splitRevenue(100n, 10000, [])).toEqual({ platformAmountMinor: 100n, shares: [] });
  });
  it('spreads prepaid proceeds over usage months with deterministic remainder', () => {
    expect(monthlyAmounts(11n, 3)).toEqual([4n, 4n, 3n]);
    expect(addCalendarMonths(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addCalendarMonths(new Date('2028-01-31T10:00:00Z'), 2).toISOString()).toBe('2028-03-31T10:00:00.000Z');
  });
  it('produces cumulative partial/full refund targets bounded by original shares', () => {
    const originals = [{ id: 'platform', weight: 2n }, { id: 'a', weight: 5n }, { id: 'b', weight: 4n }];
    expect(refundTargets(11n, 11n, originals).map(x => x.amountMinor)).toEqual([2n, 5n, 4n]);
    expect(refundTargets(5n, 11n, originals).reduce((s,x) => s+x.amountMinor,0n)).toBe(5n);
    expect(() => refundTargets(12n, 11n, originals)).toThrow();
  });
  it('conserves allocations across varied amounts and weights', () => {
    for (let amount = 0; amount < 100; amount++) {
      const shares = allocateMinor(BigInt(amount), [{ id: 'a', weight: 7n }, { id: 'b', weight: 13n }, { id: 'c', weight: 29n }]);
      expect(shares.reduce((sum,x) => sum+x.amountMinor,0n)).toBe(BigInt(amount));
    }
  });
});
describe('whole-term month allocation', () => {
  it('keeps each month even and preserves each original share for tiny amounts', () => {
    const originals = [{id:'a',weight:1n},{id:'b',weight:1n},{id:'c',weight:1n}];
    const months = monthlyRevenueShares(originals,3);
    expect(months.map(parts => parts.reduce((sum,x) => sum+x.amountMinor,0n))).toEqual([1n,1n,1n]);
    for (const original of originals) expect(months.reduce((sum,parts) => sum+parts.find(x => x.id===original.id)!.amountMinor,0n)).toBe(original.weight);
  });
  it('preserves arbitrary component totals including platform and zero shares', () => {
    for (let amount=0;amount<50;amount++) {
      const shares = [{id:'platform',weight:BigInt(amount)},{id:'a',weight:11n},{id:'b',weight:3n},{id:'zero',weight:0n}];
      const months = monthlyRevenueShares(shares,12);
      expect(months.map(parts => parts.reduce((s,p) => s+p.amountMinor,0n))).toEqual(monthlyAmounts(BigInt(amount)+14n,12));
      for (const share of shares) expect(months.reduce((s,parts) => s+parts.find(p => p.id===share.id)!.amountMinor,0n)).toBe(share.weight);
    }
  });
});