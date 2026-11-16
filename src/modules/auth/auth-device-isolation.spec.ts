import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { matchesRefreshToken } from './auth-session';

describe('refresh token device isolation', () => {
  it('issues distinct exact-bound families for simultaneous logins', async () => {
    const passwords = new PasswordService();
    const jwt = new JwtService();
    const user = {
      authRevision: 0,
      id: '00000000-0000-4000-8000-000000000001', email: 'synthetic@example.test', fullName: 'Synthetic',
      passwordHash: await passwords.hashPassword('synthetic-password'), status: 'active',
      roles: [{ role: { name: 'student' } }], createdAt: new Date(), updatedAt: new Date(),
    };
    const storedHashes: string[] = [];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'active', deletedAt: null }]),
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      refreshToken: { create: jest.fn(async (input: { data: { tokenHash: string } }) => {
        storedHashes.push(input.data.tokenHash); return { id: String(storedHashes.length) };
      }) },
      $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(prisma)),
    };
    const auth = new AuthService(prisma as never, passwords, jwt,
      { jwt: { accessSecret: 'synthetic-access-secret', refreshSecret: 'synthetic-refresh-secret' } } as never,
      { record: jest.fn() } as never);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const [desktop, mobile] = await Promise.all([
        auth.login({ email: user.email, password: 'synthetic-password' }),
        auth.login({ email: user.email, password: 'synthetic-password' }),
      ]);
      expect(desktop.refreshToken).not.toBe(mobile.refreshToken);
      expect(jwt.decode(desktop.refreshToken).sid).not.toBe(jwt.decode(mobile.refreshToken).sid);
      const matches = storedHashes.map(hash => matchesRefreshToken(desktop.refreshToken, hash));
      expect(matches.filter(Boolean)).toHaveLength(1);
      expect(jwt.decode(desktop.refreshToken)).toMatchObject({ exp: 1_800_000_000 + 30 * 24 * 60 * 60 });
    } finally {
      clock.mockRestore();
    }
  });
});
