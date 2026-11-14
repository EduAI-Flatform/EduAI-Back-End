import { AuthService } from './auth.service';
describe('MFA central token issuance', () => {
  const user = {
    id: 'owner', email: 'owner@example.test', fullName: 'Owner', passwordHash: 'hash',
    status: 'active', createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    roles: [{ role: { name: 'student' } }],
    refreshTokens: [{ id: 'stored', tokenHash: 'old-hash' }],
  };
  function setup() {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      userMfa: { findUnique: jest.fn().mockResolvedValue({ enabled: true, revision: 3 }) },
      refreshToken: { create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma.$transaction = jest.fn((callback: any) => callback(prisma));
    const jwt = { signAsync: jest.fn().mockResolvedValue('signed'), verifyAsync: jest.fn().mockResolvedValue({ sub: user.id, mfaRevision: 3, mfaVerified: false, authTime: 123 }) };
    const mfa = { claims: jest.fn().mockResolvedValue({ mfaRevision: 3, mfaVerified: false, mfaRequired: true, authTime: 123 }) };
    const service = new AuthService(prisma, { comparePassword: jest.fn().mockResolvedValue(true), hashPassword: jest.fn().mockResolvedValue('hash') } as any, jwt as any, { jwt: { accessSecret: 'access', refreshSecret: 'refresh' } } as any, { record: jest.fn() } as any, undefined, mfa as any);
    return { service, prisma, jwt, mfa };
  }
  it('returns a provisional session after correct primary credentials', async () => {
    const { service, jwt, mfa } = setup();
    const result = await service.login({ email: user.email, password: 'synthetic' });
    expect(result.mfaRequired).toBe(true);
    expect(mfa.claims).toHaveBeenCalledWith(user.id, undefined, expect.objectContaining({ userMfa: expect.any(Object) }));
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ sub: user.id, mfaRevision: 3, mfaVerified: false }), expect.objectContaining({ secret: 'access' }));
  });
  it('never upgrades a provisional refresh into a verified session', async () => {
    const { service, mfa } = setup();
    const result = await service.refresh({ refreshToken: 'old' });
    expect(mfa.claims).toHaveBeenCalledWith(user.id, expect.objectContaining({ mfaVerified: false, mfaRevision: 3, authTime: 123 }), expect.objectContaining({ userMfa: expect.any(Object) }));
    expect(result.mfaRequired).toBe(true);
  });
  it('preserves verified revision and original primary-authentication time through renewal', async () => {
    const { service, jwt, mfa } = setup();
    jwt.verifyAsync.mockResolvedValue({ sub: user.id, mfaRevision: 3, mfaVerified: true, authTime: 123 });
    mfa.claims.mockResolvedValue({ mfaRevision: 3, mfaVerified: true, mfaRequired: false, authTime: 123 });
    const result = await service.refresh({ refreshToken: 'old' });
    expect(mfa.claims).toHaveBeenCalledWith(user.id, expect.objectContaining({ mfaVerified: true, authTime: 123 }), expect.objectContaining({ userMfa: expect.any(Object) }));
    expect(result.mfaRequired).toBe(false);
  });
  it('does not issue a verified session if the factor changed after proof consumption', async () => {
    const { service, jwt } = setup();
    await expect(service.issueMfaSession(user.id, 2, 123)).rejects.toThrow();
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
});
