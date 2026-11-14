'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function verifyAtomicMfaIssuance(db) {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CI, 'true');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { JwtService } = require('@nestjs/jwt');
  const { AuthService } = require('../dist/src/modules/auth/auth.service.js');
  const { MfaService } = require('../dist/src/modules/auth/mfa.service.js');
  const { MfaController } = require('../dist/src/modules/auth/mfa.controller.js');
  const { PasswordService } = require('../dist/src/modules/auth/password.service.js');
  const { AuditService } = require('../dist/src/common/audit/audit.service.js');
  const { createRecoveryCodes, encodeBase32, encryptMfaSecret, recoveryDigest, totpAt } = require('../dist/src/modules/auth/mfa-crypto.js');
  const jwt = new JwtService(), passwords = new PasswordService(), audit = new AuditService(db);
  const config = { jwt: { accessSecret: 'synthetic-atomic-access', refreshSecret: 'synthetic-atomic-refresh' } };
  const key = Buffer.alloc(32, 8), secret = encodeBase32(Buffer.alloc(20, 4));
  const previousKey = process.env.GDS_MFA_ENCRYPTION_KEY;
  const role = await db.role.findUniqueOrThrow({ where: { name: 'student' } });
  try {
    process.env.GDS_MFA_ENCRYPTION_KEY = key.toString('hex');
    for (const mode of ['verify-totp', 'verify-recovery', 'confirm', 'recovery']) {
      const user = await db.user.create({ data: { email: randomUUID() + '@synthetic.invalid', fullName: 'Synthetic atomic MFA',
        roles: { create: { roleId: role.id } } } });
      const recovery = createRecoveryCodes(user.id), encrypted = encryptMfaSecret(secret, key, user.id);
      await db.userMfa.create({ data: mode === 'confirm'
        ? { userId: user.id, pendingSecretEncrypted: encrypted, pendingExpiresAt: new Date(Date.now() + 600000) }
        : { userId: user.id, enabled: true, revision: 2, secretEncrypted: encrypted, enabledAt: new Date(), recoveryCodeHashes: recovery.hashes } });
      await db.refreshToken.create({ data: { userId: user.id, tokenHash: 'synthetic-prior-session-only', expiresAt: new Date(Date.now() + 86400000) } });
      const authenticated = { id: user.id, email: user.email, roles: ['student'], authTime: Math.floor(Date.now() / 1000),
        mfaRevision: mode === 'confirm' ? 0 : 2, mfaVerified: mode === 'recovery' };
      const request = controller => controller[mode.startsWith('verify') ? 'verify' : mode](authenticated,
        { code: mode === 'verify-totp' || mode === 'confirm' ? totpAt(secret, Math.floor(Date.now() / 30000)) : recovery.codes[0] });
      const snapshot = async () => ({
        factor: await db.userMfa.findUniqueOrThrow({ where: { userId: user.id } }),
        tokens: await db.refreshToken.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } }),
        audits: await db.auditLog.count({ where: { actorId: user.id } }),
      });
      const before = await snapshot();
      for (const failure of ['access', 'refresh', 'hash', 'insert']) {
        let signed = 0;
        const failingJwt = { signAsync: async (...args) => {
          signed++;
          if (failure === 'access' || (failure === 'refresh' && signed === 2)) throw new Error('SYNTHETIC_MFA_ISSUANCE_FAILED');
          return jwt.signAsync(...args);
        } };
        const failingPasswords = { hashPassword: async value => {
          if (failure === 'hash') throw new Error('SYNTHETIC_MFA_ISSUANCE_FAILED');
          return passwords.hashPassword(value);
        } };
        const failingDb = failure !== 'insert' ? db : { userMfa: db.userMfa, $transaction: work => db.$transaction(async tx => work({
          $queryRaw: tx.$queryRaw.bind(tx), user: tx.user, userMfa: tx.userMfa, auditLog: tx.auditLog,
          refreshToken: { updateMany: tx.refreshToken.updateMany.bind(tx.refreshToken), create: async input => {
            await tx.refreshToken.create(input); throw new Error('SYNTHETIC_MFA_ISSUANCE_FAILED');
          } },
        })) };
        const factor = new MfaService(failingDb), auth = new AuthService(failingDb, failingPasswords, failingJwt, config, audit, undefined, factor);
        await assert.rejects(() => request(new MfaController(factor, auth)), error => error.message === 'SYNTHETIC_MFA_ISSUANCE_FAILED');
        assert.deepEqual(await snapshot(), before, mode + ': proof/revision/revocation/audit survived failed ' + failure + ' issuance');
      }
      const factor = new MfaService(db), auth = new AuthService(db, passwords, jwt, config, audit, undefined, factor);
      const response = await request(new MfaController(factor, auth));
      const session = mode.startsWith('verify') ? response : response.session;
      const claims = await jwt.verifyAsync(session.refreshToken, { secret: config.jwt.refreshSecret });
      const state = await db.userMfa.findUniqueOrThrow({ where: { userId: user.id } });
      assert.equal(claims.mfaRevision, state.revision); assert.equal(claims.mfaVerified, true);
      assert.equal(claims.authTime, authenticated.authTime); assert.equal(session.mfaRequired, false);
      assert.equal(claims.exp - claims.iat, 30 * 86400);
      assert.equal(await db.refreshToken.count({ where: { userId: user.id, revokedAt: null } }), mode.startsWith('verify') ? 2 : 1);
      if (!mode.startsWith('verify')) {
        assert.equal(response.recoveryCodes.length, 10);
        for (const code of response.recoveryCodes) assert.ok(state.recoveryCodeHashes.includes(recoveryDigest(user.id, code)));
      }
      await assert.rejects(() => request(new MfaController(factor, auth)), error => [400, 401].includes(error.getStatus?.()));
      console.log('GDS_AUTH_MFA_ATOMIC_' + mode.toUpperCase().replaceAll('-', '_') + '=PASS; four issuance failure rollbacks, reusable proof, verified session, original auth time and replay denial');
    }
  } finally {
    if (previousKey === undefined) delete process.env.GDS_MFA_ENCRYPTION_KEY; else process.env.GDS_MFA_ENCRYPTION_KEY = previousKey;
  }
};
