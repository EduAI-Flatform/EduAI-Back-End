'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, name, timeout = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Synthetic atomic MFA gate timed out: ' + name)), timeout);
  })]); } finally { clearTimeout(timer); }
}
const settled = promise => promise.then(result => ({ result }), error => ({ error }));

module.exports = async function verifyAtomicMfaIssuance(db) {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CI, 'true');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { JwtService } = require('@nestjs/jwt');
  const { AuthService } = require('../dist/src/modules/auth/auth.service.js');
  const { AuthSecurityService } = require('../dist/src/modules/auth/auth-security.service.js');
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
      const code = mode === 'verify-totp' || mode === 'confirm' ? totpAt(secret, Math.floor(Date.now() / 30000)) : recovery.codes[0];
      const request = controller => controller[mode.startsWith('verify') ? 'verify' : mode](authenticated, { code });
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

    const passwordHash = await passwords.hashPassword('synthetic-atomic-old-password');
    for (const mode of ['verify', 'confirm', 'recovery']) {
      const user = await db.user.create({ data: { email: randomUUID() + '@synthetic.invalid', fullName: 'Synthetic atomic MFA overlap',
        passwordHash, authProvider: 'local', roles: { create: { roleId: role.id } } } });
      const recovery = createRecoveryCodes(user.id), encrypted = encryptMfaSecret(secret, key, user.id);
      await db.userMfa.create({ data: mode === 'confirm'
        ? { userId: user.id, pendingSecretEncrypted: encrypted, pendingExpiresAt: new Date(Date.now() + 600000) }
        : { userId: user.id, enabled: true, revision: 2, secretEncrypted: encrypted, enabledAt: new Date(), recoveryCodeHashes: recovery.hashes } });
      const authenticated = { id: user.id, email: user.email, roles: ['student'], authTime: Math.floor(Date.now() / 1000),
        mfaRevision: mode === 'confirm' ? 0 : 2, mfaVerified: mode === 'recovery' };
      const code = mode === 'confirm' ? totpAt(secret, Math.floor(Date.now() / 30000)) : recovery.codes[0];
      const proofDone = gate(), resume = gate(), revokerStarted = gate(), revokerPrepared = gate(), startRevocation = gate();
      const factor = new MfaService(db), method = mode === 'recovery' ? 'regenerateRecoveryCodes' : mode;
      const original = factor[method].bind(factor);
      factor[method] = async (...input) => {
        const result = await original(...input);
        proofDone.resolve(); await bounded(resume.promise, mode + ' issuance resume'); return result;
      };
      const auth = new AuthService(db, passwords, jwt, config, audit, undefined, factor);
      const revokerDb = { user: db.user, $transaction: async work => {
        // Let both bcrypt operations finish before holding the MFA transaction
        // open. No transaction timeout is raised for the instrumentation.
        revokerPrepared.resolve(); await bounded(startRevocation.promise, mode + ' revoker start', 10000);
        return db.$transaction(async tx => {
          const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
          revokerStarted.resolve(row.pid); return work(tx);
        });
      } };
      const revoking = settled(new AuthSecurityService(revokerDb, passwords).changePassword(user.id,
        'synthetic-atomic-old-password', 'synthetic-atomic-new-password'));
      await bounded(revokerPrepared.promise, mode + ' credential prework', 10000);
      const issuing = settled(new MfaController(factor, auth)[mode](authenticated, { code }));
      let schedulingError;
      try {
        await bounded(proofDone.promise, mode + ' proof consumption');
        startRevocation.resolve();
        const pid = await bounded(revokerStarted.promise, mode + ' revoker pid'), deadline = Date.now() + 2000;
        let waiting = false;
        while (Date.now() < deadline) {
          const rows = await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
          if (rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
          await delay(10);
        }
        assert.equal(waiting, true, mode + ': revoke-all crossed the proof/issuance boundary');
      } catch (error) { schedulingError = error; } finally { startRevocation.resolve(); resume.resolve(); }
      const [issuance, revocation] = await Promise.all([issuing, revoking]);
      if (issuance.error) throw issuance.error;
      if (revocation?.error) throw revocation.error;
      if (schedulingError) throw schedulingError;
      const session = mode === 'verify' ? issuance.result : issuance.result.session;
      assert.equal(await db.refreshToken.count({ where: { userId: user.id, revokedAt: null } }), 0);
      await assert.rejects(() => auth.refresh({ refreshToken: session.refreshToken }), error => error.getStatus?.() === 401);
      console.log('GDS_AUTH_MFA_ATOMIC_REVOKE_' + mode.toUpperCase() + '=PASS; observed password-revoker lock wait and no surviving verified successor');
    }
  } finally {
    if (previousKey === undefined) delete process.env.GDS_MFA_ENCRYPTION_KEY; else process.env.GDS_MFA_ENCRYPTION_KEY = previousKey;
  }
};
