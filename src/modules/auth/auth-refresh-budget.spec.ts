import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { refreshTokenDigest } from './auth-session';

describe('refresh with several remembered device sessions', () => {
  it('rotates a named device without scanning or bcrypt-proving unrelated device tokens', async () => {
    let tick = 0, deadline: number | undefined;
    const checkBudget = () => { if (deadline !== undefined && tick > deadline) throw new Error('SYNTHETIC_TRANSACTION_EXPIRED'); };
    const identity = { tokenVersion: 2, tokenUse: 'refresh', authRevision: 0, sid: '00000000-0000-4000-8000-000000000001', jti: '00000000-0000-4000-8000-000000000002' };
    const user = { id: 'synthetic-user', authRevision: 0, email: 'synthetic@example.test', fullName: 'Synthetic', status: 'active', deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(), roles: [{ role: { name: 'student' } }],
      refreshTokens: [{ id: 'other-1', tokenHash: 'other-1' }, { id: 'other-2', tokenHash: 'other-2' }, { id: 'current', tokenHash: 'matching' }] };
    const tx = { $queryRaw: jest.fn(async () => { checkBudget(); return [{ status: 'active', deletedAt: null }]; }),
      user: { findUnique: jest.fn(async () => { checkBudget(); return user; }) },
      refreshToken: { updateMany: jest.fn(async () => { checkBudget(); return { count: 1 }; }),
        findUnique: jest.fn(async () => ({ id: identity.jti, userId: user.id, sessionFamilyId: identity.sid, tokenHash: refreshTokenDigest('synthetic-current-device'), expiresAt: new Date(Date.now() + 3600000), revokedAt: null })),
        create: jest.fn(async () => { checkBudget(); return { id: 'successor' }; }) } };
    const prisma = { ...tx, $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      deadline = tick + 5;
      try { return await callback(tx); } finally { deadline = undefined; }
    }) };
    const passwords = { comparePassword: jest.fn(async (_input: string, hash: string) => { tick += 2; return hash === 'matching'; }),
      hashPassword: jest.fn(async () => { tick++; return 'new-hash'; }) };
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ ...identity, sub: user.id }),
      signAsync: jest.fn().mockResolvedValueOnce('new-access').mockResolvedValueOnce('new-refresh') };
    const service = new AuthService(prisma as never, passwords as unknown as PasswordService, jwt as unknown as JwtService,
      { jwt: { accessSecret: 'synthetic-access', refreshSecret: 'synthetic-refresh' } } as never, { record: jest.fn() } as never);

    await expect(service.refresh({ refreshToken: 'synthetic-current-device' })).resolves.toMatchObject({ refreshToken: 'new-refresh' });
    expect(passwords.comparePassword).not.toHaveBeenCalled();
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    expect(tx.refreshToken.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.findUnique).toHaveBeenCalledWith({ where: { id: identity.jti } });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
  });
});
