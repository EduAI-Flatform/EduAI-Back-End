import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MembershipAdminController } from './membership-admin.controller';
import { GoneException } from '@nestjs/common';

describe('MembershipAdminController authorization', () => {
  it.each(['createPlan', 'createVersion', 'publishVersion', 'configurePlanEntitlement', 'configureIncludedCourse'] as const)(
    'retires %s without calling package authoring or touching historical records', method => {
      const service = new Proxy({}, { get: () => jest.fn(() => { throw new Error('Unexpected legacy mutation'); }) });
      const controller = new MembershipAdminController(service as never, {} as never);
      let failure: unknown;
      try { (controller[method] as (...args: unknown[]) => unknown)('actor', 'version', {}); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(GoneException);
      expect((failure as GoneException).getStatus()).toBe(410);
      expect((failure as GoneException).getResponse()).toMatchObject({ error: 'MEMBERSHIP_SALES_RETIRED' });
    },
  );

  it('retains historical reads, archival, reusable service definitions and emergency access handling', () => {
    const service = { listPlans: jest.fn(), archivePlan: jest.fn(), archiveVersion: jest.fn(),
      createEntitlementDefinition: jest.fn(), listEntitlementDefinitions: jest.fn() };
    const continuity = { emergencyRevoke: jest.fn() };
    const controller = new MembershipAdminController(service as never, continuity as never);
    controller.listPlans({} as never); controller.archivePlan('actor', 'plan'); controller.archiveVersion('actor', 'version');
    controller.createEntitlementDefinition('actor', {} as never); controller.listEntitlementDefinitions({} as never);
    controller.emergencyRevokeCourseAccess('actor', {} as never);
    for (const handler of Object.values(service)) expect(handler).toHaveBeenCalledTimes(1);
    expect(continuity.emergencyRevoke).toHaveBeenCalledWith('actor', {});
  });
  it('protects the complete membership administration boundary with platform-admin RBAC', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MembershipAdminController)).toEqual([
      RoleName.platform_admin,
    ]);
  });
});
