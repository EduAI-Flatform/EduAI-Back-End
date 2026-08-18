import { evaluateTmiRedemption, summarizeTmiWallet, type TmiLedgerEntry } from "./tmi-ledger-contract";

const entry = (kind: TmiLedgerEntry["kind"], amount: number): TmiLedgerEntry => ({
  kind, amount, sourceType: "test", sourceId: `${kind}-${amount}`, actorId: "system", occurredAt: "2026-08-18T00:00:00.000Z",
});

describe("Sprint 21 TMI immutable ledger contract", () => {
  it("derives current, earned, spent, and expiry totals from entries", () => {
    expect(summarizeTmiWallet([entry("earn", 100), entry("refund", 20), entry("redeem", 30), entry("expiry", 10)], "2026-08-18T00:00:00.000Z")).toEqual({ current: 80, earned: 120, spent: 40, expired: 10 });
  });

  it("treats debit adjustments as spending and ignores invalid amounts", () => {
    expect(summarizeTmiWallet([entry("earn", 100), { ...entry("adjustment", 25), adjustmentDirection: "debit" }, entry("earn", 0), entry("redeem", -5)], "2026-08-18T00:00:00.000Z")).toMatchObject({ current: 75, earned: 100, spent: 25 });
  });

  it.each([
    ["insufficient", 101, false, { allowed: false, reason: "insufficient_balance" }],
    ["invalid", 0, false, { allowed: false, reason: "invalid_amount" }],
    ["replayed", 10, true, { allowed: false, reason: "replayed_request" }],
  ])("rejects %s redemption", (_label, cost, replayed, expected) => {
    expect(evaluateTmiRedemption({ current: 100, earned: 100, spent: 0, expired: 0 }, cost, replayed)).toEqual(expected);
  });

  it("allows a valid redemption without making TMI money-equivalent", () => {
    expect(evaluateTmiRedemption({ current: 100, earned: 120, spent: 20, expired: 0 }, 40, false)).toEqual({ allowed: true, remaining: 60 });
  });
});
