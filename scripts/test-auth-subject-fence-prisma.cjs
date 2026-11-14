'use strict';
// Called only from the guarded, disposable full-schema checkout replay.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const settled = promise => promise.then(result => ({ result }), error => ({ error }));
async function bounded(promise, name) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic gate timed out: ' + name)), 2500);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitForLock(db, pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.wait_event_type === 'Lock') return;
    await delay(10);
  }
  throw new Error('Expected actual PostgreSQL lock wait was not observed');
}
function observedTransactions(db, started) {
  return { user: db.user, userMfa: db.userMfa, $transaction: (work, options) => db.$transaction(async tx => {
    const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
    started.resolve(row.pid);
    return work(tx);
  }, options) };
}

module.exports = async function verifyAuthSubjectFence(db, actorId) {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CI, 'true');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { JwtService } = require('@nestjs/jwt');
  const { AuthService } = require('../dist/src/modules/auth/auth.service.js');
  const { AuthSecurityService } = require('../dist/src/modules/auth/auth-security.service.js');
  const { MfaService } = require('../dist/src/modules/auth/mfa.service.js');
  const { AdminUserService } = require('../dist/src/modules/admin/admin-user.service.js');
  const { AuditService } = require('../dist/src/common/audit/audit.service.js');
  const { PasswordService } = require('../dist/src/modules/auth/password.service.js');
  const { createRecoveryCodes, encodeBase32, encryptMfaSecret, totpAt } = require('../dist/src/modules/auth/mfa-crypto.js');
  const jwt = new JwtService(), passwords = new PasswordService(), audit = new AuditService(db);
  const config = { jwt: { accessSecret: 'synthetic-fence-access', refreshSecret: 'synthetic-fence-refresh' } };
  const mfaKey = Buffer.alloc(32, 9), secret = encodeBase32(Buffer.alloc(20, 3));
  const oldKey = process.env.GDS_MFA_ENCRYPTION_KEY;
  const makeAuth = prisma => new AuthService(prisma, passwords, jwt, config, audit, undefined, new MfaService(db));
  const student = await db.role.findUniqueOrThrow({ where: { name: 'student' } });
  await db.role.upsert({ where: { name: 'instructor' }, create: { name: 'instructor' }, update: {} });
  const originalHash = await passwords.hashPassword('synthetic-old-password');
  async function fixture() {
    const user = await db.user.create({ data: { email: randomUUID() + '@synthetic.invalid', fullName: 'Synthetic auth subject fence',
      passwordHash: originalHash, authProvider: 'local', roles: { create: { roleId: student.id } } } });
    return user.id;
  }
  async function seedSession(userId) {
    const factor = await db.userMfa.findUnique({ where: { userId } });
    const token = await jwt.signAsync({ jti: randomUUID(), sub: userId, mfaRevision: factor?.revision ?? 0,
      mfaVerified: Boolean(factor?.enabled), authTime: Math.floor(Date.now() / 1000) }, { secret: config.jwt.refreshSecret, expiresIn: 30 * 86400 });
    const row = await db.refreshToken.create({ data: { userId, tokenHash: await passwords.hashPassword(token), expiresAt: new Date(Date.now() + 30 * 86400000) } });
    return { token, row };
  }
  try {
    process.env.GDS_MFA_ENCRYPTION_KEY = mfaKey.toString('hex');
    const unrelatedId = await fixture(), unrelated = await seedSession(unrelatedId);
    const scenarios = [
      ['password', async (prisma, userId) => new AuthSecurityService(prisma, passwords).changePassword(userId, 'synthetic-old-password', 'synthetic-new-password')],
      ['firebase', async (prisma, userId) => new AuthSecurityService(prisma, passwords, { verifyIdToken: async () => ({
        uid: userId, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'password' },
      }) }).revokeFirebaseSessions(userId, 'synthetic-provider-proof')],
      ['mfa-disable', async (prisma, userId, proof) => new MfaService(prisma).disable(userId, proof, Math.floor(Date.now() / 1000))],
      ['mfa-confirm', async (prisma, userId) => new MfaService(prisma).confirm(userId, totpAt(secret, Math.floor(Date.now() / 30000)), Math.floor(Date.now() / 1000))],
      ['mfa-recovery', async (prisma, userId, proof) => new MfaService(prisma).regenerateRecoveryCodes(userId, proof, Math.floor(Date.now() / 1000))],
      ['admin-role', async (prisma, userId) => new AdminUserService(prisma, audit).setRoles(actorId, userId, ['instructor'])],
      ['admin-status', async (prisma, userId) => new AdminUserService(prisma, audit).setStatus(actorId, userId, 'suspended')],
    ];
    async function scenarioFixture(name) {
      const userId = await fixture(), recovery = createRecoveryCodes(userId);
      if (name === 'firebase') await db.user.update({ where: { id: userId }, data: { firebaseUid: userId } });
      if (name.startsWith('mfa-')) {
        const encrypted = encryptMfaSecret(secret, mfaKey, userId);
        await db.userMfa.create({ data: name === 'mfa-confirm'
          ? { userId, revision: 0, pendingSecretEncrypted: encrypted, pendingExpiresAt: new Date(Date.now() + 600000) }
          : { userId, revision: 1, enabled: true, secretEncrypted: encrypted, enabledAt: new Date(), recoveryCodeHashes: recovery.hashes } });
      }
      return { userId, proof: recovery.codes[0] };
    }
    for (const [name, revoke] of scenarios) {
      const { userId, proof } = await scenarioFixture(name);
      const desktop = await seedSession(userId), mobile = await seedSession(userId);
      const consumed = gate(), resume = gate(), revokerStarted = gate();
      const refreshDb = { user: db.user, $transaction: work => db.$transaction(async tx => work({
        $queryRaw: tx.$queryRaw.bind(tx), user: tx.user, userMfa: tx.userMfa,
        refreshToken: { create: tx.refreshToken.create.bind(tx.refreshToken), updateMany: async input => {
          const result = await tx.refreshToken.updateMany(input);
          if (input.where.id === desktop.row.id && result.count === 1) { consumed.resolve(); await bounded(resume.promise, name + ' rotation resume'); }
          return result;
        } },
      })) };
      const rotating = settled(makeAuth(refreshDb).refresh({ refreshToken: desktop.token }));
      let revoking, schedulingError;
      try {
        await bounded(consumed.promise, name + ' consumed predecessor');
        revoking = settled(revoke(observedTransactions(db, revokerStarted), userId, proof));
        // Observe the server wait, not an assumed schedule based on a sleep.
        await waitForLock(db, await bounded(revokerStarted.promise, name + ' revoker pid'));
      } catch (error) { schedulingError = error; } finally { resume.resolve(); }
      const [rotation, revocation] = await Promise.all([rotating, revoking]);
      if (rotation.error) throw rotation.error;
      if (revocation?.error) throw revocation.error;
      if (schedulingError) throw schedulingError;
      const renewed = rotation.result;
      assert.equal(await db.refreshToken.count({ where: { userId, revokedAt: null } }), 0, name + ': a successor survived revoke-all');
      const claims = await jwt.verifyAsync(renewed.refreshToken, { secret: config.jwt.refreshSecret });
      assert.equal(claims.exp - claims.iat, 30 * 86400);
      assert.ok((await db.refreshToken.findUniqueOrThrow({ where: { id: mobile.row.id } })).revokedAt);
      assert.deepEqual(await db.refreshToken.findUniqueOrThrow({ where: { id: unrelated.row.id } }), unrelated.row);
      await assert.rejects(() => makeAuth(db).refresh({ refreshToken: renewed.refreshToken }), error => error.getStatus?.() === 401);
      console.log('GDS_AUTH_SUBJECT_FENCE_' + name.toUpperCase().replaceAll('-', '_') + '=PASS');
    }
    // A login whose old-password proof completed before a committed password
    // change must not mint a new session after that revocation.
    const userId = await fixture();
    const staleProof = { hashPassword: passwords.hashPassword.bind(passwords), comparePassword: async (value, hash) => {
      const matches = await passwords.comparePassword(value, hash);
      await new AuthSecurityService(db, passwords).changePassword(userId, 'synthetic-old-password', 'synthetic-new-password');
      return matches;
    } };
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await assert.rejects(() => new AuthService(db, staleProof, jwt, config, audit).login({
      email: user.email, password: 'synthetic-old-password',
    }), error => error.getStatus?.() === 401);
    assert.equal(await db.refreshToken.count({ where: { userId, revokedAt: null } }), 0);
    console.log('GDS_AUTH_SUBJECT_FENCE_PASSWORD_PROOF=PASS');

    for (const [name, revoke] of scenarios) {
      const { userId: reverseId, proof } = await scenarioFixture(name), oldSession = await seedSession(reverseId);
      const revoked = gate(), finishRevocation = gate(), refreshStarted = gate();
      const revocationDb = { user: db.user, userMfa: db.userMfa, $transaction: (work, options) => db.$transaction(async tx => {
        const result = await work(tx);
        revoked.resolve(); await bounded(finishRevocation.promise, 'reverse revocation resume'); return result;
      }, options) };
      const revokingFirst = settled(revoke(revocationDb, reverseId, proof));
      let rotatingAfter, schedulingError;
      try {
        await bounded(revoked.promise, name + ' revocation before rotation');
        rotatingAfter = settled(makeAuth(observedTransactions(db, refreshStarted)).refresh({ refreshToken: oldSession.token }));
        await waitForLock(db, await bounded(refreshStarted.promise, name + ' reverse refresh pid'));
      } catch (error) { schedulingError = error; } finally { finishRevocation.resolve(); }
      const [revocation, rotation] = await Promise.all([revokingFirst, rotatingAfter]);
      if (revocation.error) throw revocation.error;
      if (schedulingError) throw schedulingError;
      assert.equal(rotation?.error?.getStatus?.(), 401, name + ': revoked predecessor renewed');
      assert.equal(await db.refreshToken.count({ where: { userId: reverseId, revokedAt: null } }), 0);
      assert.deepEqual(await db.refreshToken.findUniqueOrThrow({ where: { id: unrelated.row.id } }), unrelated.row);
      console.log('GDS_AUTH_SUBJECT_FENCE_REVERSE_' + name.toUpperCase().replaceAll('-', '_') + '=PASS');
    }

    // Two legitimate administrators alter each other's roles concurrently.
    // Preserve the complete Serializable retry boundary and audit actor FKs.
    const adminRole = await db.role.findUniqueOrThrow({ where: { name: 'platform_admin' } });
    const adminIds = [await fixture(), await fixture()];
    await db.userRole.createMany({ data: adminIds.map(userId => ({ userId, roleId: adminRole.id })) });
    const held = [gate(), gate()], releaseAdmins = gate(), attempts = [0, 0];
    const adminDb = index => ({ $transaction: (work, options) => db.$transaction(async tx => {
      const attempt = ++attempts[index];
      return work({ user: tx.user, role: tx.role, userRole: tx.userRole, refreshToken: tx.refreshToken, auditLog: tx.auditLog,
        $queryRaw: async (...input) => {
          const result = await tx.$queryRaw(...input);
          if (attempt === 1 && input[0].join('').includes('FOR NO KEY UPDATE')) {
            held[index].resolve(); await bounded(releaseAdmins.promise, 'inverse admin fence');
          }
          return result;
        } });
    }, options) });
    const mutations = adminIds.map((target, index) => new AdminUserService(adminDb(index), audit)
      .setRoles(adminIds[1 - index], target, ['platform_admin', 'instructor'])
      .then(result => ({ result }), error => ({ error })));
    try { await bounded(Promise.all(held.map(item => item.promise)), 'both admin subject fences'); }
    finally { releaseAdmins.resolve(); }
    for (const outcome of await Promise.all(mutations)) { if (outcome.error) throw outcome.error; }
    assert.equal(await db.user.count({ where: { id: { in: adminIds }, status: 'active', roles: { some: { role: { name: 'platform_admin' } } } } }), 2);
    assert.equal(await db.auditLog.count({ where: { actorId: { in: adminIds }, action: 'USER_ROLE_CHANGED' } }), 2);
    console.log('GDS_AUTH_SUBJECT_FENCE_INVERSE_ADMINS=PASS; serializable attempts=' + attempts.join(','));

    // Isolate the last-admin invariant in this disposable database, restoring
    // all pre-existing synthetic administrators before returning to checkout.
    const otherAdmins = await db.user.findMany({ where: { id: { notIn: adminIds }, status: 'active',
      roles: { some: { role: { name: 'platform_admin' } } } }, select: { id: true } });
    await db.user.updateMany({ where: { id: { in: otherAdmins.map(user => user.id) } }, data: { status: 'suspended' } });
    try {
      const counted = [gate(), gate()], releaseCounts = gate(), lastAttempts = [0, 0];
      const lastAdminDb = index => ({ $transaction: (work, options) => db.$transaction(async tx => {
        const attempt = ++lastAttempts[index];
        return work({ $queryRaw: tx.$queryRaw.bind(tx), role: tx.role, userRole: tx.userRole,
          refreshToken: tx.refreshToken, auditLog: tx.auditLog, user: {
            findFirst: tx.user.findFirst.bind(tx.user), update: tx.user.update.bind(tx.user),
            count: async input => {
              const result = await tx.user.count(input);
              if (attempt === 1) { counted[index].resolve(); await bounded(releaseCounts.promise, 'last-admin concurrent counts'); }
              return result;
            },
          } });
      }, options) });
      const pendingRemovals = adminIds.map((target, index) => settled(
        new AdminUserService(lastAdminDb(index), audit).setRoles(adminIds[1 - index], target, ['instructor'])));
      try { await bounded(Promise.all(counted.map(item => item.promise)), 'both last-admin counts'); }
      finally { releaseCounts.resolve(); }
      const removals = await Promise.all(pendingRemovals);
      for (const outcome of removals) {
        if (outcome.error && outcome.error.getStatus?.() !== 409) throw outcome.error;
      }
      assert.equal(removals.filter(outcome => outcome.result).length, 1,
        'Last-admin outcomes: ' + removals.map(outcome => outcome.result ? 'committed' : 'conflict').join(','));
      assert.equal(removals.filter(outcome => outcome.error?.getStatus?.() === 409).length, 1);
      assert.equal(await db.user.count({ where: { status: 'active', deletedAt: null,
        roles: { some: { role: { name: 'platform_admin' } } } } }), 1);
    } finally {
      await db.user.updateMany({ where: { id: { in: otherAdmins.map(user => user.id) } }, data: { status: 'active' } });
    }
    console.log('GDS_AUTH_SUBJECT_FENCE_LAST_ADMIN=PASS');
  } finally {
    if (oldKey === undefined) delete process.env.GDS_MFA_ENCRYPTION_KEY; else process.env.GDS_MFA_ENCRYPTION_KEY = oldKey;
  }
};
