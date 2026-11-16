import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';

const secrets = { accessSecret: 'synthetic-v2-access', refreshSecret: 'synthetic-v2-refresh' };
function setup() {
  const user = { id: randomUUID(), email: 'v2@synthetic.invalid', fullName: 'Synthetic', passwordHash: 'synthetic-password',
    authRevision: 0, status: 'active', deletedAt: null, roles: [{ role: { name: 'student' } }], createdAt: new Date(), updatedAt: new Date() };
  const rows: any[] = [];
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (value.gt !== undefined) return row[key] > value.gt;
      if (value.some) return rows.some(item => match(item, value.some));
    }
    return row[key] === value;
  });
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ status: user.status, deletedAt: user.deletedAt }]),
    user: { findUnique: jest.fn(async () => ({ ...user, refreshTokens: rows.filter(row => !row.revokedAt && row.expiresAt > new Date()) })) },
    userMfa: { findUnique: jest.fn(async () => null) },
    refreshToken: {
      create: jest.fn(async ({ data }) => { const row = { id: randomUUID(), revokedAt: null, ...data }; rows.push(row); return row; }),
      findUnique: jest.fn(async ({ where }) => rows.find(row => match(row, where)) ?? null),
      findFirst: jest.fn(async ({ where }) => rows.find(row => match(row, where)) ?? null),
      updateMany: jest.fn(async ({ where, data }) => { const found = rows.filter(row => match(row, where)); found.forEach(row => Object.assign(row, data)); return { count: found.length }; }),
      update: jest.fn(async ({ where, data }) => { const row = rows.find(row => match(row, where)); Object.assign(row, data); return row; }),
    },
  };
  tx.$transaction = jest.fn(async (work: any) => {
    const snapshot = structuredClone(rows);
    try { return await work(tx); } catch (error) { rows.splice(0, rows.length, ...snapshot); throw error; }
  });
  const passwords = { comparePassword: jest.fn(async (token: string, hash: string) => hash === 'synthetic-password' || hash === `legacy:${token}`),
    hashPassword: jest.fn(async (token: string) => `legacy:${token}`) };
  const jwt = new JwtService();
  const auth = new AuthService(tx, passwords as any, jwt, { jwt: secrets } as any, { record: jest.fn() } as any);
  return { auth, user, rows, tx, jwt, passwords };
}
describe('V2 exact refresh identity and device families', () => {
  it('binds the whole token to its exact row and signs distinct access/refresh uses', async () => {
    const { auth, user, rows, jwt, passwords } = setup();
    const result = await auth.login({ email: user.email, password: 'password' });
    const access = jwt.verify(result.accessToken, { secret: secrets.accessSecret });
    const refresh = jwt.verify(result.refreshToken, { secret: secrets.refreshSecret });
    expect(access).toMatchObject({ tokenVersion: 2, tokenUse: 'access', sub: user.id, authRevision: 0 });
    expect(refresh).toMatchObject({ tokenVersion: 2, tokenUse: 'refresh', sub: user.id, authRevision: 0, sid: access.sid, jti: rows[0].id });
    expect(rows[0]).toMatchObject({ sessionFamilyId: access.sid, tokenHash: 'sha256:v2:' + createHash('sha256').update(result.refreshToken).digest('hex') });
    expect(refresh.exp - refresh.iat).toBe(30 * 24 * 60 * 60);
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });
  it('rotates within one family and logout with its predecessor revokes its successor only', async () => {
    const { auth, user, rows, jwt } = setup();
    const desktop = await auth.login({ email: user.email, password: 'password' });
    const mobile = await auth.login({ email: user.email, password: 'password' });
    const rotated = await auth.refresh({ refreshToken: desktop.refreshToken });
    expect(jwt.decode(rotated.refreshToken)).toMatchObject({ sid: jwt.decode(desktop.refreshToken).sid });
    await expect(auth.refresh({ refreshToken: desktop.refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.logout({ refreshToken: desktop.refreshToken })).resolves.toEqual({ loggedOut: true });
    await expect(auth.refresh({ refreshToken: rotated.refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh({ refreshToken: mobile.refreshToken })).resolves.toHaveProperty('accessToken');
    expect(rows.filter(row => row.sessionFamilyId === jwt.decode(desktop.refreshToken).sid && !row.revokedAt)).toHaveLength(0);
  });
  it('rejects a signed stale auth revision without minting a successor', async () => {
    const { auth, user, rows } = setup();
    const login = await auth.login({ email: user.email, password: 'password' });
    user.authRevision++;
    await expect(auth.refresh({ refreshToken: login.refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(rows).toHaveLength(1); expect(rows[0].revokedAt).toBeNull();
  });
  it('does not upgrade a local primary proof after revocation wins the issuance fence', async () => {
    const { auth, user, rows, passwords } = setup();
    passwords.comparePassword.mockImplementation(async () => { user.authRevision++; return true; });
    let rejected = false;
    try { await auth.login({ email: user.email, password: 'password' }); } catch (error) { rejected = error instanceof UnauthorizedException; }
    expect(rejected).toBe(true); expect(rows).toHaveLength(0);
  });
  it('does not accept a signed legacy token or fall back to bcrypt prefix matching', async () => {
    const { auth, user, rows, jwt, passwords } = setup();
    const token = jwt.sign({ sub: user.id }, { secret: secrets.refreshSecret, expiresIn: 3600 });
    rows.push({ id: randomUUID(), userId: user.id, tokenHash: `legacy:${token}`, expiresAt: new Date(Date.now() + 3600000), revokedAt: null });
    await expect(auth.refresh({ refreshToken: token })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwords.comparePassword).not.toHaveBeenCalled();
  });
  it('rejects a mismatched full digest even for an otherwise valid signed row identity', async () => {
    const { auth, user, rows } = setup();
    const login = await auth.login({ email: user.email, password: 'password' });
    rows[0].tokenHash = 'sha256:v2:' + '0'.repeat(64);
    await expect(auth.refresh({ refreshToken: login.refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(rows).toHaveLength(1);
  });
});
