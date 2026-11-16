import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('V2 access session authority', () => {
  function setup() {
    const jwt = new JwtService(); const secret = 'synthetic-equal-key-test';
    const sid = randomUUID();
    const payload: any = { sub: 'owner', tokenVersion: 2, tokenUse: 'access', sid, authRevision: 3 };
    const user: any = { id: 'owner', email: 'owner@synthetic.invalid', authRevision: 3, status: 'active', deletedAt: null, roles: [{ role: { name: 'student' } }] };
    const db: any = { user: { findUnique: jest.fn(async () => user) }, refreshToken: { findFirst: jest.fn(async () => ({ id: randomUUID() })) } };
    const guard = new JwtAuthGuard(jwt, { jwt: { accessSecret: secret } } as any, db, { getAllAndOverride: jest.fn(() => false) } as any);
    const check = async () => { const request: any = { headers: { authorization: 'Bearer ' + jwt.sign(payload, { secret, expiresIn: 3600 }) } };
      await guard.canActivate({ getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) } as any); return request.user; };
    return { check, user, payload, db, sid };
  }
  it('attaches only a current active V2 family and checks owner/expiry at its source', async () => {
    const { check, db, sid } = setup();
    await expect(check()).resolves.toMatchObject({ id: 'owner', tokenVersion: 2, authRevision: 3, sid });
    expect(db.refreshToken.findFirst).toHaveBeenCalledWith({ where: { userId: 'owner', sessionFamilyId: sid, revokedAt: null, expiresAt: { gt: expect.any(Date) } }, select: { id: true } });
  });
  it.each(['legacy', 'stale', 'missing-family', 'refresh-purpose', 'invalid-revision'] as const)('rejects %s even with a valid signature', async kind => {
    const { check, user, payload, db } = setup();
    if (kind === 'legacy') delete payload.tokenVersion;
    if (kind === 'stale') user.authRevision++;
    if (kind === 'missing-family') db.refreshToken.findFirst.mockResolvedValue(null);
    if (kind === 'refresh-purpose') { payload.tokenUse = 'refresh'; payload.jti = randomUUID(); }
    if (kind === 'invalid-revision') payload.authRevision = '3';
    await expect(check()).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
