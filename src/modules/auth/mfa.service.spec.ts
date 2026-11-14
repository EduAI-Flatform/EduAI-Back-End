import { ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRecoveryCodes, encryptMfaSecret, encodeBase32, totpAt } from './mfa-crypto';
import { MfaService } from './mfa.service';
describe('MfaService', () => {
  const key = Buffer.alloc(32, 9);
  const userId = 'owner';
  const secret = encodeBase32(Buffer.alloc(20, 3));
  const currentTime = Date.UTC(2026, 10, 11, 10, 0, 0);
  const step = Math.floor(currentTime / 30000);
  const originalKey = process.env.GDS_MFA_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.GDS_MFA_ENCRYPTION_KEY = key.toString('hex');
    jest.spyOn(Date, 'now').mockReturnValue(currentTime);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.GDS_MFA_ENCRYPTION_KEY;
    else process.env.GDS_MFA_ENCRYPTION_KEY = originalKey;
  });
  function setup(state?: any) {
    const row = state ?? {
      userId, revision: 2, enabled: true, secretEncrypted: encryptMfaSecret(secret, key, userId),
      lastUsedStep: step - 1, recoveryCodeHashes: [], pendingExpiresAt: null, pendingSecretEncrypted: null,
    };
    const tx = {
      userMfa: { findUnique: jest.fn().mockResolvedValue(row), upsert: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      refreshToken: { updateMany: jest.fn() }, auditLog: { create: jest.fn() },
    };
    const prisma = { ...tx, $transaction: jest.fn(async (callback: any) => callback(tx)) };
    return { service: new MfaService(prisma as any), tx, row };
  }
  it('requires verification after fresh login and preserves verified revision through refresh', async () => {
    const { service } = setup();
    expect(await service.claims(userId)).toMatchObject({ mfaRequired: true, mfaVerified: false, mfaRevision: 2 });
    expect(await service.claims(userId, { mfaVerified: true, mfaRevision: 2, authTime: 123 })).toMatchObject({ mfaRequired: false, mfaVerified: true, authTime: 123 });
  });
  it.each([true, false])('rejects a superseded refresh revision when the factor is enabled=%s', async enabled => {
    const { service, row } = setup();
    row.enabled = enabled;
    await expect(service.claims(userId, { mfaVerified: true, mfaRevision: 1, authTime: 123 }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects a pre-MFA refresh token once a factor revision exists', async () => {
    const { service } = setup();
    await expect(service.claims(userId, { authTime: 123 }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('uses the supplied transaction state rather than an independent root read', async () => {
    const { service } = setup();
    const reader = { userMfa: { findUnique: jest.fn().mockResolvedValue({ enabled: false, revision: 0 }) } };
    expect(await service.claims(userId, { authTime: 123 }, reader as any))
      .toEqual({ mfaRevision: 0, mfaVerified: false, mfaRequired: false, authTime: 123 });
  });
  it('keeps setup unavailable until encryption is configured', async () => {
    delete process.env.GDS_MFA_ENCRYPTION_KEY;
    const { service } = setup();
    expect(await service.status(userId)).toMatchObject({ available: false, enabled: true });
    await expect(service.verify(userId, totpAt(secret, step), 2)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('rejects stale primary authentication before enrollment or disable', async () => {
    const { service } = setup();
    await expect(service.enroll(userId, 'owner@example.test', Math.floor(currentTime / 1000) - 301)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.disable(userId, totpAt(secret, step), 0)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('stores encrypted pending setup and never enables without a matching proof', async () => {
    const { service, tx } = setup();
    const response = await service.enroll(userId, 'owner@example.test', Math.floor(currentTime / 1000));
    expect(response.otpauthUri).toContain('issuer=GDS');
    const update = tx.userMfa.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ userId, enabled: false });
    expect(update.data.pendingSecretEncrypted).not.toContain(response.secret);
    expect(update.data).not.toHaveProperty('enabled', true);
  });
  it('atomically consumes a TOTP once and rejects a racing use', async () => {
    const { service, tx } = setup();
    expect(await service.verify(userId, totpAt(secret, step), 2)).toBe(2);
    expect(tx.userMfa.updateMany).toHaveBeenCalledWith({
      where: { userId, enabled: true, revision: 2, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    tx.userMfa.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.verify(userId, totpAt(secret, step), 2)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('removes recovery codes with an entire-list compare-and-swap to prevent resurrection', async () => {
    const recovery = createRecoveryCodes(userId);
    const { service, row, tx } = setup(); row.recoveryCodeHashes = recovery.hashes;
    await service.verify(userId, recovery.codes[0], 2);
    expect(tx.userMfa.updateMany).toHaveBeenCalledWith({
      where: { userId, enabled: true, revision: 2, recoveryCodeHashes: { equals: recovery.hashes } },
      data: { recoveryCodeHashes: recovery.hashes.slice(1) },
    });
    tx.userMfa.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.verify(userId, recovery.codes[0], 2)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects proof for a replaced factor and previously consumed steps', async () => {
    const { service, row, tx } = setup();
    await expect(service.verify(userId, totpAt(secret, step), 1)).rejects.toBeInstanceOf(UnauthorizedException);
    row.lastUsedStep = step;
    await expect(service.verify(userId, totpAt(secret, step), 2)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.userMfa.updateMany).not.toHaveBeenCalled();
  });
  it('confirms pending setup, increments revision, revokes refresh sessions and returns recovery codes once', async () => {
    const { service, tx } = setup({
      userId, revision: 0, enabled: false, lastUsedStep: null, recoveryCodeHashes: [],
      pendingSecretEncrypted: encryptMfaSecret(secret, key, userId),
      pendingExpiresAt: new Date(Date.now() + 600000),
    });
    const result = await service.confirm(userId, totpAt(secret, step), Math.floor(currentTime / 1000));
    expect(result.revision).toBe(1);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(tx.userMfa.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enabled: true, revision: 1, lastUsedStep: step, pendingSecretEncrypted: null }),
    }));
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'MFA_ENABLED', metadataJson: {} }) });
  });
  it('rejects concurrent confirmation without issuing recovery codes', async () => {
    const { service, tx } = setup({
      userId, revision: 0, enabled: false, pendingSecretEncrypted: encryptMfaSecret(secret, key, userId),
      pendingExpiresAt: new Date(Date.now() + 600000),
    });
    tx.userMfa.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.confirm(userId, totpAt(secret, step), Math.floor(currentTime / 1000))).rejects.toBeInstanceOf(ConflictException);
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });
  it('disabling consumes proof, clears secrets and invalidates all prior revisions', async () => {
    const { service, tx } = setup();
    await service.disable(userId, totpAt(secret, step), Math.floor(currentTime / 1000));
    expect(tx.userMfa.updateMany).toHaveBeenLastCalledWith({
      where: { userId, revision: 2, enabled: true },
      data: { enabled: false, revision: { increment: 1 }, secretEncrypted: null, pendingSecretEncrypted: null, pendingExpiresAt: null, lastUsedStep: null, recoveryCodeHashes: [], enabledAt: null },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
  });
});
