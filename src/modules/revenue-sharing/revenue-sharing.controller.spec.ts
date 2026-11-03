import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { RevenueFinanceService } from './revenue-finance.service';
import { RevenueMembershipService } from './revenue-membership.service';
import { RevenueAdminController, RevenueSellerController } from './revenue-sharing.controller';
import { RevenuePageDto, RevenueRetailPolicyDto } from './revenue-finance.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { membershipEffectiveAt } from './revenue-membership.rules';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
describe('revenue API boundaries', () => {
  it('restricts administration to platform admins', () => {
    expect(Reflect.getMetadata('roles', RevenueAdminController)).toEqual([RoleName.platform_admin]);
    expect(Reflect.getMetadata('roles', RevenueSellerController)).toEqual([RoleName.instructor, RoleName.platform_admin]);
  });
  it('scopes seller reports to the authenticated actor, ignoring arbitrary seller IDs', async () => {
    const finance = { report: jest.fn().mockResolvedValue({items:[]}) };
    const controller = new RevenueSellerController(finance as unknown as RevenueFinanceService, {} as RevenueMembershipService);
    await controller.report('authenticated-seller', {page:2,pageSize:10});
    expect(finance.report).toHaveBeenCalledWith('authenticated-seller',2,10);
  });
  it('allows only the admin controller to request a cross-seller report', async () => {
    const finance = { report: jest.fn().mockResolvedValue({items:[]}) };
    const controller = new RevenueAdminController(finance as unknown as RevenueFinanceService, {} as RevenueMembershipService, {} as PrismaService);
    await controller.report({page:1,pageSize:25});
    expect(finance.report).toHaveBeenCalledWith(undefined,1,25);
  });
  it('validates and bounds pagination at the query boundary', async () => {
    await expect(pipe.transform({page:'2',pageSize:'25'}, {type:'query',metatype:RevenuePageDto})).resolves.toMatchObject({page:2,pageSize:25});
    for(const value of [{page:'0'},{pageSize:'101'},{sellerId:'another-seller'},{page:'NaN'}]) await expect(pipe.transform(value,{type:'query',metatype:RevenuePageDto})).rejects.toThrow();
  });
  it('accepts explicit zero fees and rejects missing, fractional and out-of-range basis points', async () => {
    await expect(pipe.transform({platformFeeBps:0,noticeMode:'immediate'},{type:'body',metatype:RevenueRetailPolicyDto})).resolves.toMatchObject({platformFeeBps:0});
    for(const value of [undefined,-1,10001,12.3]) await expect(pipe.transform({platformFeeBps:value,noticeMode:'immediate'},{type:'body',metatype:RevenueRetailPolicyDto})).rejects.toThrow();
  });
  it('requires notice days only for delayed activation', () => {
    const now = new Date('2026-11-03T00:00:00Z');
    expect(membershipEffectiveAt('immediate',undefined,now)).toEqual(now);
    expect(membershipEffectiveAt('delayed',7,now).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(() => membershipEffectiveAt('immediate',7,now)).toThrow();
    expect(() => membershipEffectiveAt('delayed',undefined,now)).toThrow();
  });
});