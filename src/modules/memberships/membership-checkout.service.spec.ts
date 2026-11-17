import { CommerceOrderStatus, MembershipCheckoutAction, MembershipSubscriptionStatus } from '../../../generated/prisma/client';
import { MembershipCheckoutService } from './membership-checkout.service';

const now = new Date('2028-02-29T10:15:00.000Z');
const learnerId = '10000000-0000-4000-8000-000000000001';
const versionId = '20000000-0000-4000-8000-000000000001';

function harness() {
  const prisma = {
    commerceReceiptAccessEffect: { findFirst: jest.fn().mockResolvedValue(null) },
    membershipSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    membershipCheckoutIntent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const continuity = { listExpiringGrace: jest.fn().mockResolvedValue([]) };
  return { service: new MembershipCheckoutService(prisma as never, continuity as never), prisma, continuity };
}

describe('MembershipCheckoutService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('returns the latest membership with derived expiry and a pending plan change', async () => {
    const { service, prisma } = harness();
    prisma.membershipSubscription.findFirst.mockResolvedValue({
      id: 'subscription-id',
      status: MembershipSubscriptionStatus.active,
      versionId,
      startsAt: new Date('2027-02-28T10:15:00.000Z'),
      expiresAt: new Date('2028-02-28T10:15:00.000Z'),
      version: { displayName: 'EduAI Gold', plan: { id: 'plan-id', code: 'GOLD' } },
    });
    prisma.membershipCheckoutIntent.findFirst.mockResolvedValue({
      action: MembershipCheckoutAction.downgrade,
      startsAt: new Date('2028-02-28T10:15:00.000Z'),
      endsAt: new Date('2028-05-28T10:15:00.000Z'),
      activatesImmediately: false,
      version: { id: 'next-version', displayName: 'EduAI Basic', plan: { id: 'basic-plan', code: 'BASIC' } },
      order: { id: 'pending-order', orderNumber: 'EDU-M-PENDING', status: CommerceOrderStatus.pending_payment },
    });

    await expect(service.current(learnerId)).resolves.toMatchObject({
      membership: { id: 'subscription-id', status: 'EXPIRED' },
      pendingChange: { action: 'DOWNGRADE', order: { status: 'PENDING_PAYMENT' } },
    });
  });

  it('returns empty historical state and preserves learner grace disclosures', async () => {
    const { service, continuity, prisma } = harness();
    const grace = [{ courseId: 'course-id', graceEndsAt: new Date('2028-03-01') }];
    continuity.listExpiringGrace.mockResolvedValue(grace as never);
    await expect(service.current(learnerId)).resolves.toEqual({ membership: null, pendingChange: null, expiringGraceCourses: grace });
    expect(continuity.listExpiringGrace).toHaveBeenCalledWith(learnerId, now);
    expect(prisma.membershipSubscription.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: learnerId, status: 'active', startsAt: { lte: now } },
    }));
    expect(prisma.membershipCheckoutIntent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: learnerId, order: { status: 'pending_payment' } },
    }));
  });

  it('identifies receipt membership as awaiting verification without claiming payment', async () => {
    const { service, prisma } = harness();
    prisma.membershipSubscription.findFirst.mockResolvedValue({id:'early-sub',sourceOrderLineId:null,
      versionId, startsAt:now,expiresAt:new Date('2030-01-01'),version:{displayName:'Gold',plan:{id:'plan',code:'GOLD'}}} as never);
    prisma.commerceReceiptAccessEffect.findFirst.mockResolvedValue({generation:{status:'ACCESS_UNVERIFIED',orderId:'order',generation:1}} as never);
    await expect(service.current(learnerId)).resolves.toMatchObject({membership:{
      source:'UNVERIFIED_RECEIPT_ACCESS',verificationStatus:'PENDING_RECONCILIATION',financialProof:false,
    }});
  });  it('recovers pending purchase and renewal orders as well as plan changes',async()=>{
    const {service,prisma}=harness();await service.current(learnerId);
    const where=prisma.membershipCheckoutIntent.findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('action');expect(where.order).toEqual({status:'pending_payment'});
  });});
