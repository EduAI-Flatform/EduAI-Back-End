import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('authoritative account state at session issuance', () => {
  function setup() {
    const original = { id: 'owner', email: 'owner@example.test', fullName: 'Owner', passwordHash: 'old-hash',
      status: 'active', deletedAt: null, createdAt: new Date(), updatedAt: new Date(), roles: [{ role: { name: 'student' } }] };
    const latest = { ...original };
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ status: 'active', deletedAt: null }]),
      user: { findUnique: jest.fn(async () => latest) },
      refreshToken: { create: jest.fn() }, userMfa: { findUnique: jest.fn().mockResolvedValue(null) } };
    const prisma = { user: { findUnique: jest.fn(async () => original) },
      $transaction: jest.fn(async (work: any) => work(tx)) };
    const passwords = { comparePassword: jest.fn(async () => true), hashPassword: jest.fn(async () => 'refresh-hash') };
    const jwt = { signAsync: jest.fn(async () => 'signed') };
    const auth = new AuthService(prisma as any, passwords as any, jwt as any,
      { jwt: { accessSecret: 'synthetic-access', refreshSecret: 'synthetic-refresh' } } as any, { record: jest.fn() } as any);
    return { auth, original, latest, tx, passwords, jwt };
  }
  it('rejects an old password proven before a concurrent password change committed', async () => {
    const { auth, latest, passwords, jwt, tx } = setup();
    passwords.comparePassword.mockImplementation(async () => { latest.passwordHash = 'replacement-hash'; return true; });
    await expect(auth.login({ email: latest.email, password: 'old-password' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled(); expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });
  it.each(['suspended', 'deleted'])('rejects a stale caller snapshot after the account becomes %s', async change => {
    const { auth, original, latest, tx, jwt } = setup();
    if (change === 'deleted') latest.deletedAt = new Date() as any; else latest.status = change;
    await expect(auth.issueSessionForUser(original as any, tx as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
  it('issues current roles rather than a pre-revocation caller snapshot', async () => {
    const { auth, original, latest, tx, jwt } = setup();
    latest.roles = [{ role: { name: 'instructor' } }];
    const response = await auth.issueSessionForUser(original as any, tx as any);
    expect(response.user.roles).toEqual(['instructor']);
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ roles: ['instructor'] }), expect.any(Object));
  });
  it.each([{ rows: [] }, { rows: [{ status: 'suspended', deletedAt: null }] }, { rows: [{ status: 'active', deletedAt: new Date() }] }])(
    'rejects an unavailable subject observed when acquiring its fence %#', async ({ rows }) => {
      const { auth, original, tx, jwt } = setup();
      tx.$queryRaw.mockResolvedValue(rows as any);
      await expect(auth.issueSessionForUser(original as any, tx as any)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });
});
