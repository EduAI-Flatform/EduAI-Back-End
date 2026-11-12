import { AuthSecurityService } from './auth-security.service';

describe('account password changes', () => {
  function setup() {
    const user = { id: 'owner', passwordHash: 'old-hash', firebaseUid: null, authProvider: 'local', status: 'active' };
    const tx = { user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue({ firebaseUid: 'firebase-owner', status: 'active' }) }, refreshToken: { updateMany: jest.fn() }, auditLog: { create: jest.fn() } };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) }, $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const passwords = { comparePassword: jest.fn().mockResolvedValue(true), hashPassword: jest.fn().mockResolvedValue('new-hash') };
    const firebase = { verifyIdToken: jest.fn() };
    return { service: new AuthSecurityService(prisma as any, passwords as any, firebase as any), user, tx, prisma, passwords, firebase };
  }
  it('changes the owner password and revokes refresh sessions in one transaction', async () => {
    const { service, tx } = setup();
    await expect(service.changePassword('owner', 'old-password', 'new-password')).resolves.toEqual({ changed: true, reauthenticate: true });
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: 'owner', passwordHash: 'old-hash', firebaseUid: null, authProvider: 'local', status: 'active' }, data: { passwordHash: 'new-hash' } });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'owner', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'owner', action: 'AUTH_PASSWORD_CHANGED', metadataJson: {} }) });
  });
  it('rejects incorrect credentials and concurrent credential changes', async () => {
    const first = setup(); first.passwords.comparePassword.mockResolvedValue(false);
    await expect(first.service.changePassword('owner', 'wrong', 'new-password')).rejects.toThrow();
    expect(first.prisma.$transaction).not.toHaveBeenCalled();
    const second = setup(); second.tx.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(second.service.changePassword('owner', 'old', 'new-password')).rejects.toThrow();
    expect(second.tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });
  it('does not accept a local password for an externally managed account', async () => {
    const { service, user, passwords } = setup(); Object.assign(user, { firebaseUid: 'external', authProvider: 'firebase' });
    await expect(service.changePassword('owner', 'old', 'new-password')).rejects.toThrow();
    expect(passwords.comparePassword).not.toHaveBeenCalled();
  });
  it('requires a recent matching Firebase password authentication before session revocation', async () => {
    const { service, user, firebase, tx } = setup(); Object.assign(user, { firebaseUid: 'firebase-owner', authProvider: 'firebase' });
    firebase.verifyIdToken.mockResolvedValue({ uid: 'someone-else', auth_time: Date.now() / 1000, firebase: { sign_in_provider: 'password' } });
    await expect(service.revokeFirebaseSessions('owner', 'proof')).rejects.toThrow();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    firebase.verifyIdToken.mockResolvedValue({ uid: 'firebase-owner', auth_time: Date.now() / 1000, firebase: { sign_in_provider: 'password' } });
    await expect(service.revokeFirebaseSessions('owner', 'proof')).resolves.toEqual({ reauthenticate: true });
  });
});
