import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

describe('refresh with several remembered device sessions', () => {
  it('rotates a valid later device without exhausting the database transaction on unrelated token proofs', async () => {
    let tick = 0, deadline: number | undefined;
    const checkBudget = () => { if (deadline !== undefined && tick > deadline) throw new Error('SYNTHETIC_TRANSACTION_EXPIRED'); };
    const user = { id: 'synthetic-user', email: 'synthetic@example.test', fullName: 'Synthetic', status: 'active', deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(), roles: [{ role: { name: 'student' } }],
      refreshTokens: [{ id: 'other-1', tokenHash: 'other-1' }, { id: 'other-2', tokenHash: 'other-2' }, { id: 'current', tokenHash: 'matching' }] };
    const tx = { user: { findUnique: jest.fn(async () => { checkBudget(); return user; }) },
      refreshToken: { updateMany: jest.fn(async () => { checkBudget(); return { count: 1 }; }),
        create: jest.fn(async () => { checkBudget(); return { id: 'successor' }; }) } };
    const prisma = { ...tx, $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      deadline = tick + 5;
      try { return await callback(tx); } finally { deadline = undefined; }
    }) };
    const passwords = { comparePassword: jest.fn(async (_input: string, hash: string) => { tick += 2; return hash === 'matching'; }),
      hashPassword: jest.fn(async () => { tick++; return 'new-hash'; }) };
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: user.id }),
      signAsync: jest.fn().mockResolvedValueOnce('new-access').mockResolvedValueOnce('new-refresh') };
    const service = new AuthService(prisma as never, passwords as unknown as PasswordService, jwt as unknown as JwtService,
      { jwt: { accessSecret: 'synthetic-access', refreshSecret: 'synthetic-refresh' } } as never, { record: jest.fn() } as never);

    await expect(service.refresh({ refreshToken: 'synthetic-current-device' })).resolves.toMatchObject({ refreshToken: 'new-refresh' });
    expect(passwords.comparePassword).toHaveBeenCalledTimes(3);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
  });
});
