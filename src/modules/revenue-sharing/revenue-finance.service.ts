import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { addCalendarMonths } from '../memberships/membership.rules';
import { requireBankTransferProof } from '../payments/bank-transfer-proof';
import { allocateMinor, monthlyRevenueShares, refundTargets, splitRevenue } from './revenue-finance.rules';
import { membershipEffectiveAt } from './revenue-membership.rules';

interface Participant { courseId: string; sellerId: string; weight: number; amountMinor: string }
const lock = (tx: Prisma.TransactionClient) => tx.$queryRaw(Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(73410201)`);
const snapshotInclude = { periods: { include: { entries: true } } } satisfies Prisma.RevenueOrderSnapshotInclude;
const paymentInclude = { confirmedSettlement: { include: { paymentAttempt: true, paymentEvent: true } }, membershipCheckoutIntent: { include: { durationOption: true } } } satisfies Prisma.CommerceOrderInclude;
type PaymentOrder = Prisma.CommerceOrderGetPayload<{ include: typeof paymentInclude }>;

@Injectable()
export class RevenueFinanceService {
  private readonly logger = new Logger(RevenueFinanceService.name);
  private cursor: string | undefined;
  constructor(private readonly prisma: PrismaService) {}

  /** Acquire before any cart/user/version locks to maintain consistent lock ordering. */
  async lockCheckout(tx: Prisma.TransactionClient) { await lock(tx); }

  /** Affiliate credits use the same canonical bank/provider/capture proof as seller earnings. */
  async verifyAffiliateOrder(tx: Prisma.TransactionClient, orderId: string) {
    const order = await tx.commerceOrder.findUnique({ where: { id: orderId }, include: paymentInclude });
    return !!order && await this.isVerified(tx, order);
  }

  /** Wallet caller holds the same finance lock; refresh refund facts before cash-out. */
  async reconcileWalletPeriod(tx: Prisma.TransactionClient, periodId: string) {
    const period = await tx.revenueEarningPeriod.findUniqueOrThrow({ where: { id: periodId }, select: { snapshotId: true } });
    await this.processSnapshot(tx, period.snapshotId, new Date());
    const snapshot = await tx.revenueOrderSnapshot.findUniqueOrThrow({ where: { id: period.snapshotId }, select: { orderId: true } });
    const order = await tx.commerceOrder.findUnique({ where: { id: snapshot.orderId }, include: paymentInclude });
    return !!order && await this.isVerified(tx, order);
  }

  async captureOrder(tx: Prisma.TransactionClient, orderId: string) {
    await lock(tx);
    await this.activateRetailDue(tx);
    const lines = await tx.commerceOrderLine.findMany({ where: { orderId } });
    for (const line of lines) {
      if (await tx.revenueOrderSnapshot.findUnique({ where: { id: line.id } })) continue;
      let policyId: string, fee: number, participants: Omit<Participant, 'amountMinor'>[];
      if (line.productType === 'course') {
        const policy = await tx.revenueRetailPolicy.findFirst({ where: { status: 'active' }, orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }] });
        if (!policy) continue; // Explicit opt-in, never backfill legacy orders.
        policyId = policy.id; fee = policy.platformFeeBps;
        participants = [{ courseId: line.productReferenceId, sellerId: line.sellerId, weight: 1 }];
      } else {
        const version = await tx.membershipPlanVersion.findUnique({ where: { id: line.productReferenceId }, include: { includedCourses: { include: { course: { select: { instructorId: true, status: true, moderationStatus: true, deletedAt: true } } } } } });
        if (!version?.revenuePolicyId) continue;
        const policy = await tx.revenuePlanPolicy.findUnique({ where: { id: version.revenuePolicyId } });
        if (!policy || policy.planId !== version.planId) throw new ConflictException('MEMBERSHIP_REVENUE_POLICY_MISSING');
        policyId = policy.id; fee = policy.platformFeeBps;
        const participations = await tx.revenueParticipation.findMany({ where: { courseId: { in: version.includedCourses.map(x => x.courseId) }, leftAt: null } });
        if (version.includedCourses.some(x => x.course.deletedAt || x.course.status !== 'published' || x.course.moderationStatus !== 'clear' || !participations.some(p => p.courseId === x.courseId && p.sellerId === x.course.instructorId))) throw new ConflictException('MEMBERSHIP_CATALOG_REFRESH_REQUIRED');
        participants = version.includedCourses.map(x => ({ courseId: x.courseId, sellerId: x.course.instructorId, weight: x.revenueWeight }));
        if (!participants.length && fee < 10000) throw new ConflictException('MEMBERSHIP_REVENUE_RECIPIENTS_REQUIRED');
      }
      const split = splitRevenue(line.finalAmountMinor, fee, participants.map(p => ({ id: p.courseId, weight: BigInt(p.weight) })));
      const snapshot = participants.map(p => ({ ...p, amountMinor: split.shares.find(s => s.id === p.courseId)!.amountMinor.toString() }));
      await tx.revenueOrderSnapshot.create({ data: { id: line.id, orderId, productType: line.productType, policyId, platformFeeBps: fee, basisAmountMinor: line.finalAmountMinor, platformAmountMinor: split.platformAmountMinor, sellerAmountMinor: line.finalAmountMinor - split.platformAmountMinor, participants: snapshot } });
    }
  }

  listRetailPolicies() { return this.prisma.revenueRetailPolicy.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }); }

  scheduleRetail(actorId: string, input: { platformFeeBps: number; noticeMode: string; noticeDays?: number }) {
    if (!Number.isInteger(input.platformFeeBps) || input.platformFeeBps < 0 || input.platformFeeBps > 10000) throw new BadRequestException('Invalid platform fee.');
    const effectiveAt = membershipEffectiveAt(input.noticeMode, input.noticeDays, new Date());
    return this.serializable(async tx => {
      await this.activateRetailDue(tx);
      if (await tx.revenueRetailPolicy.findFirst({ where: { status: 'scheduled' } })) throw new ConflictException('A retail fee change is already scheduled.');
      const policy = await tx.revenueRetailPolicy.create({ data: { ...input, actorId, effectiveAt } });
      const sellers = await tx.commerceProduct.findMany({ where: { type: 'course' }, distinct: ['sellerId'], select: { sellerId: true } });
      for (const { sellerId } of sellers) await tx.notification.upsert({ where: { userId_eventKey: { userId: sellerId, eventKey: `revenue:retail:${policy.id}` } }, create: { userId: sellerId, eventKey: `revenue:retail:${policy.id}`, type: 'REVENUE_POLICY_CHANGED', title: 'Thay đổi tỷ lệ nền tảng', body: `Tỷ lệ nền tảng ${input.platformFeeBps / 100}%, có hiệu lực ${effectiveAt.toISOString()}. Chỉ áp dụng cho đơn mới.`, link: '/instructor/dashboard/revenue-sharing' }, update: {} });
      await tx.auditLog.create({ data: { actorId, action: 'revenue.retail.policy.scheduled', targetType: 'revenue_retail_policy', targetId: policy.id, metadataJson: { platformFeeBps: input.platformFeeBps, effectiveAt: effectiveAt.toISOString() } } });
      await this.activateRetailDue(tx);
      return tx.revenueRetailPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    });
  }

  cancelRetail(actorId: string, id: string) {
    return this.serializable(async tx => {
      const policy = await tx.revenueRetailPolicy.findUnique({ where: { id } });
      if (!policy || policy.status !== 'scheduled' || policy.effectiveAt <= new Date()) throw new ConflictException('Only a future retail fee change can be cancelled.');
      const result = await tx.revenueRetailPolicy.update({ where: { id }, data: { status: 'cancelled' } });
      await tx.auditLog.create({ data: { actorId, action: 'revenue.retail.policy.cancelled', targetType: 'revenue_retail_policy', targetId: id } });
      return result;
    });
  }

  private async activateRetailDue(tx: Prisma.TransactionClient) {
    const due = await tx.revenueRetailPolicy.findMany({ where: { status: 'scheduled', effectiveAt: { lte: new Date() } }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }] });
    for (const policy of due) {
      await tx.revenueRetailPolicy.updateMany({ where: { status: 'active' }, data: { status: 'superseded' } });
      await tx.revenueRetailPolicy.update({ where: { id: policy.id }, data: { status: 'active' } });
    }
  }

  /** Recoverable projection; no calls to payment providers and no alteration of settlement facts. */
  async runBatch(now = new Date()) {
    await this.serializable(tx => this.activateRetailDue(tx));
    const snapshots = await this.prisma.revenueOrderSnapshot.findMany({ where: this.cursor ? { id: { gt: this.cursor } } : {}, orderBy: { id: 'asc' }, take: 100, select: { id: true } });
    let failed = 0;
    for (const snapshot of snapshots) {
      try { await this.serializable(tx => this.processSnapshot(tx, snapshot.id, now)); }
      catch { failed++; this.logger.warn(`Revenue snapshot ${snapshot.id} requires retry.`); }
    }
    this.cursor = snapshots.length === 100 ? snapshots[snapshots.length - 1].id : undefined;
    return { checked: snapshots.length, failed };
  }

  private async processSnapshot(tx: Prisma.TransactionClient, id: string, now: Date) {
    const snapshot = await tx.revenueOrderSnapshot.findUniqueOrThrow({ where: { id }, include: snapshotInclude });
    const order = await tx.commerceOrder.findUnique({ where: { id: snapshot.orderId }, include: paymentInclude });
    if (!order || !await this.isVerified(tx, order)) return;
    const participants = snapshot.participants as unknown as Participant[];
    if (!snapshot.periods.length && participants.length) {
      let months = 1, startsAt = order.confirmedAt ?? order.createdAt;
      let expiresAt: Date | undefined;
      if (snapshot.productType === 'membership') {
        const subscription = await tx.membershipSubscription.findUnique({ where: { sourceOrderLineId: id } });
        if (!subscription || !order.membershipCheckoutIntent) return; // Wait for real fulfillment, including future renewals.
        months = order.membershipCheckoutIntent.durationOption.months;
        startsAt = subscription.startsAt; expiresAt = subscription.expiresAt;
      }
      const monthly = monthlyRevenueShares([{ id: 'platform', weight: snapshot.platformAmountMinor }, ...participants.map(p => ({ id: p.courseId, weight: BigInt(p.amountMinor) }))], months);
      for (const participant of participants) {
        const values = monthly.map(parts => parts.find(p => p.id === participant.courseId)!.amountMinor);
        for (let index = 0; index < months; index++) await tx.revenueEarningPeriod.create({ data: {
          snapshotId: id, sellerId: participant.sellerId, courseId: participant.courseId, periodIndex: index,
          amountMinor: values[index], dueAt: expiresAt ? (index === months - 1 ? expiresAt : addCalendarMonths(startsAt, index + 1)) : startsAt,
        } });
      }
    }
    const periods = await tx.revenueEarningPeriod.findMany({ where: { snapshotId: id }, include: { entries: true } });
    const refunds = await tx.commerceRefundAllocation.findMany({ where: { orderLineId: id, refund: { status: 'recorded', settlementId: order.confirmedSettlementId! } }, orderBy: [{ refund: { recordedAt: 'asc' } }, { id: 'asc' }] });
    const cumulative = refunds.reduce((sum,x) => sum+x.amountMinor,0n);
    if (cumulative > snapshot.basisAmountMinor) throw new ConflictException('REVENUE_REFUND_EXCEEDS_BASIS');
    if (cumulative > 0n) {
      const targets = refundTargets(cumulative, snapshot.basisAmountMinor, [{ id: 'platform', weight: snapshot.platformAmountMinor }, ...participants.map(x => ({ id: x.courseId, weight: BigInt(x.amountMinor) }))]);
      for (const participant of participants) {
        const group = periods.filter(x => x.courseId === participant.courseId);
        const amount = targets.find(x => x.id === participant.courseId)?.amountMinor ?? 0n;
        const periodTargets = allocateMinor(amount, group.filter(x => x.amountMinor > 0n).map(x => ({ id: x.id, weight: x.amountMinor })));
        for (const period of group) {
          const target = periodTargets.find(x => x.id === period.id)?.amountMinor ?? 0n;
          const reversed = -period.entries.filter(e => e.kind.startsWith('refund_')).reduce((sum,e) => sum+e.amountMinor,0n);
          const delta = target - reversed;
          if (delta !== 0n) await tx.revenueLedgerEntry.create({ data: { periodId: period.id, sourceKey: `refund:${period.id}:${cumulative}`, sourceRefundId: refunds[refunds.length - 1].refundId, kind: period.entries.some(e => e.kind === 'recognized') ? 'refund_recognized' : 'refund_pending', amountMinor: -delta } });
        }
      }
    }
    // Re-read after refund entries: recognize the remaining obligation, not the original gross share.
    for (const period of await tx.revenueEarningPeriod.findMany({ where: { snapshotId: id, dueAt: { lte: now } }, include: { entries: true } })) {
      if (period.entries.some(e => e.kind === 'recognized')) continue;
      const amount = period.amountMinor + period.entries.filter(e => e.kind === 'refund_pending').reduce((sum,e) => sum+e.amountMinor,0n);
      if (amount < 0n) throw new ConflictException('NEGATIVE_REVENUE_RECOGNITION');
      await tx.revenueLedgerEntry.create({ data: { periodId: period.id, sourceKey: `recognize:${period.id}`, kind: 'recognized', amountMinor: amount } });
    }
  }

  private async isVerified(tx: Prisma.TransactionClient, order: PaymentOrder): Promise<boolean> {
    const s = order.confirmedSettlement;
    if (order.status !== 'confirmed' || !s || s.orderId !== order.id || s.amountMinor !== order.payableAmountMinor || s.currency !== 'VND' || order.currency !== 'VND') return false;
    if (s.kind === 'no_payment_required') return order.payableAmountMinor === 0n && s.disposition === 'internal';
    if (s.provider === 'bank_transfer') { await requireBankTransferProof(tx, order.id, s.id); return true; }
    if (s.kind === 'wallet_capture' && s.provider === 'gds' && s.disposition === 'internal') {
      const hold = await tx.gdsInternalHold.findUnique({ where: { orderRef: order.id } });
      const journal = await tx.gdsInternalJournal.findUnique({ where: { eventKey: `gds:capture:${order.id}` } });
      const wallet = hold ? await tx.gdsInternalWallet.findUnique({ where: { id: hold.walletId } }) : null;
      return !!hold && hold.status === 'CAPTURED' && hold.amountMinor === s.amountMinor && wallet?.buyerId === order.buyerId && journal?.kind === 'CAPTURE' && journal.walletId === hold.walletId && journal.amountMinor === s.amountMinor && s.providerSettlementReference === `gds:order:${order.id}` && s.paymentAttemptId === null && s.paymentEventId === null;
    }
    const e = s.paymentEvent, a = s.paymentAttempt;
    return s.kind === 'provider_collection' && s.disposition === 'matched' && ['payos','vnpay'].includes(s.provider ?? '') && !!s.providerSettlementReference && !!e && !!a &&
      e.id === s.paymentEventId && a.id === s.paymentAttemptId && a.orderId === order.id && e.paymentAttemptId === a.id &&
      a.provider === s.provider && e.provider === s.provider && !!a.providerPaymentIdentity && a.providerOrderCode !== null && e.providerPaymentIdentity === a.providerPaymentIdentity &&
      e.providerSettlementReference === s.providerSettlementReference && e.nextStatus === 'paid' && a.status === 'paid' &&
      e.amountMinor === s.amountMinor && a.amountMinor === s.amountMinor && a.currency === s.currency && e.currency === s.currency && e.providerOccurredAt?.getTime() === s.settledAt.getTime();
  }

  async report(sellerId: string | undefined, page: number, pageSize: number) {
    const where = sellerId ? { sellerId } : {};
    const [total, rows, sums] = await this.prisma.$transaction([
      this.prisma.revenueEarningPeriod.count({ where }),
      this.prisma.revenueEarningPeriod.findMany({ where, orderBy: [{ dueAt: 'desc' }, { id: 'asc' }], skip: (page-1)*pageSize, take: pageSize, include: { snapshot: { select: { orderId: true } }, entries: true } }),
      this.prisma.$queryRaw<{ pending: bigint; recognized: bigint; refunded: bigint }[]>(Prisma.sql`
        SELECT COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM revenue_ledger_entries e WHERE e.period_id=p.id AND e.kind='recognized') THEN p.amount_minor + COALESCE((SELECT SUM(e.amount_minor) FROM revenue_ledger_entries e WHERE e.period_id=p.id AND e.kind='refund_pending'),0) ELSE 0 END),0)::bigint AS pending,
        COALESCE(SUM(COALESCE((SELECT SUM(e.amount_minor) FROM revenue_ledger_entries e WHERE e.period_id=p.id AND e.kind IN ('recognized','refund_recognized')),0)),0)::bigint AS recognized,
        COALESCE(SUM(COALESCE((SELECT SUM(e.amount_minor) FROM revenue_ledger_entries e WHERE e.period_id=p.id AND e.kind IN ('refund_pending','refund_recognized')),0)),0)::bigint AS refunded
        FROM revenue_earning_periods p ${sellerId ? Prisma.sql`WHERE p.seller_id=${sellerId}::uuid` : Prisma.empty}`),
    ]);
    return { items: rows.map(p => {
      const recognized = p.entries.some(e => e.kind === 'recognized');
      return { id: p.id, orderLineId: p.snapshotId, orderId: p.snapshot.orderId, sellerId: p.sellerId, courseId: p.courseId, amountMinor: p.amountMinor.toString(), dueAt: p.dueAt.toISOString(),
        recognizedAmountMinor: p.entries.filter(e => e.kind !== 'refund_pending').reduce((sum,e) => sum+e.amountMinor,0n).toString(),
        refundAdjustmentAmountMinor: p.entries.filter(e => e.kind.startsWith('refund_')).reduce((sum,e) => sum+e.amountMinor,0n).toString(),
        pendingAmountMinor: (recognized ? 0n : p.amountMinor+p.entries.reduce((sum,e) => sum+e.amountMinor,0n)).toString() };
    }), totals: { pendingAmountMinor: sums[0].pending.toString(), recognizedAmountMinor: sums[0].recognized.toString(), refundAdjustmentAmountMinor: sums[0].refunded.toString() }, page, pageSize, total, totalPages: Math.ceil(total/pageSize) };
  }

  private async serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt=0; ; attempt++) {
      try { return await this.prisma.$transaction(async tx => { await lock(tx); return fn(tx); }, { isolationLevel: 'Serializable', timeout: 30000 }); }
      catch(error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) continue; throw error; }
    }
  }
}
