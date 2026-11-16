'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const seed = require('./auth-v2-replay-fixture.cjs');
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const settled = promise => promise.then(result => ({ result }), error => ({ error }));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('V2_SYNTHETIC_GATE_TIMEOUT')), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function waitForLock(db, pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.wait_event_type === 'Lock') return;
    await delay(10);
  }
  throw new Error('V2_EXPECTED_POSTGRES_LOCK_NOT_OBSERVED');
}
module.exports = async function verifyV2(db) {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CI, 'true'); assert.equal(url.username, 'eduai_migration_replay');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname)); assert.equal(url.pathname, '/eduai_migration_replay');
  const { JwtService } = require('@nestjs/jwt');
  const { AuthService } = require('../dist/src/modules/auth/auth.service.js');
  const { AuthSecurityService } = require('../dist/src/modules/auth/auth-security.service.js');
  const { PasswordService } = require('../dist/src/modules/auth/password.service.js');
  const { MfaService } = require('../dist/src/modules/auth/mfa.service.js');
  const { MfaController } = require('../dist/src/modules/auth/mfa.controller.js');
  const { createRecoveryCodes, encryptMfaSecret, encodeBase32, totpAt } = require('../dist/src/modules/auth/mfa-crypto.js');
  const jwt = new JwtService(), passwords = new PasswordService();
  const config = { jwt: { accessSecret: 'synthetic-v2-probe-access', refreshSecret: 'synthetic-v2-probe-refresh' } };
  const passwordHash = await passwords.hashPassword('synthetic-v2-old-password');
  const role = await db.role.findUniqueOrThrow({ where: { name: 'student' } });
  const fixture = () => db.user.create({ data: { email: randomUUID() + '@synthetic.invalid', fullName: 'Synthetic V2 session',
    authProvider: 'local', passwordHash, roles: { create: { roleId: role.id } } } });
  const auth = client => new AuthService(client, passwords, jwt, config, { record: async () => {} }, undefined, new MfaService(client));
  const claims = { mfaRevision: 0, mfaVerified: false };
  const grantsBefore = await db.courseAccessGrant.findMany({ orderBy: { id: 'asc' } });
  const owner = await fixture();
  const desktop = await seed(db, owner.id, jwt, config.jwt.refreshSecret, { ...claims, padding: 'x'.repeat(100) });
  const mobile = await seed(db, owner.id, jwt, config.jwt.refreshSecret, { ...claims, padding: 'x'.repeat(100) });
  assert.equal(desktop.token.slice(0, 72), mobile.token.slice(0, 72));
  await db.refreshToken.update({ where: { id: desktop.row.id }, data: { tokenHash: mobile.row.tokenHash } });
  await assert.rejects(() => auth(db).refresh({ refreshToken: desktop.token }), error => error.getStatus?.() === 401);
  await db.refreshToken.update({ where: { id: desktop.row.id }, data: { tokenHash: desktop.row.tokenHash } });
  const second = await auth(db).refresh({ refreshToken: desktop.token });
  const third = await auth(db).refresh({ refreshToken: second.refreshToken });
  await auth(db).logout({ refreshToken: desktop.token });
  await auth(db).logout({ refreshToken: desktop.token });
  await assert.rejects(() => auth(db).refresh({ refreshToken: third.refreshToken }), error => error.getStatus?.() === 401);
  await auth(db).refresh({ refreshToken: mobile.token });
  assert.equal(await db.refreshToken.count({ where: { userId: owner.id, sessionFamilyId: desktop.row.sessionFamilyId, revokedAt: null } }), 0);
  assert.ok(await db.refreshToken.findUnique({ where: { id: desktop.row.id } }), 'Unexpired predecessor must be retained');
  console.log('GDS_AUTH_V2_EXACT_FAMILY=PASS; full-token tail binding, multiple rotations, retained predecessor logout, idempotency and independent device');

  for (const order of ['refresh-first', 'logout-first']) {
    const user = await fixture(), primary = await seed(db, user.id, jwt, config.jwt.refreshSecret, claims);
    const other = await seed(db, user.id, jwt, config.jwt.refreshSecret, claims);
    const held = gate(), resume = gate(), started = gate();
    const holding = { $transaction: work => db.$transaction(async tx => work({
      $queryRaw: tx.$queryRaw.bind(tx), user: tx.user, userMfa: tx.userMfa,
      refreshToken: { findUnique: tx.refreshToken.findUnique.bind(tx.refreshToken), create: tx.refreshToken.create.bind(tx.refreshToken),
        updateMany: async input => { const result = await tx.refreshToken.updateMany(input); held.resolve(); await bounded(resume.promise); return result; } },
    })) };
    const observed = { $transaction: work => db.$transaction(async tx => {
      const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`; started.resolve(row.pid); return work(tx);
    }) };
    const first = settled(auth(holding)[order === 'refresh-first' ? 'refresh' : 'logout']({ refreshToken: primary.token }));
    let second, schedulingError;
    try {
      await bounded(held.promise);
      second = settled(auth(observed)[order === 'refresh-first' ? 'logout' : 'refresh']({ refreshToken: primary.token }));
      await waitForLock(db, await bounded(started.promise));
    } catch (error) { schedulingError = error; } finally { resume.resolve(); }
    const [a, b] = await Promise.all([first, second]);
    if (a.error) throw a.error; if (schedulingError) throw schedulingError;
    if (order === 'refresh-first') { if (b.error) throw b.error; }
    else assert.equal(b?.error?.getStatus?.(), 401);
    assert.equal(await db.refreshToken.count({ where: { userId: user.id, sessionFamilyId: primary.row.sessionFamilyId, revokedAt: null } }), 0);
    assert.deepEqual(await db.refreshToken.findUniqueOrThrow({ where: { id: other.row.id } }), other.row);
    console.log('GDS_AUTH_V2_' + order.toUpperCase().replaceAll('-', '_') + '=PASS; actual PostgreSQL lock wait, no successor survived family logout');
  }

  const oldKey = process.env.GDS_MFA_ENCRYPTION_KEY, key = Buffer.alloc(32, 7), secret = encodeBase32(Buffer.alloc(20, 6));
  try {
    process.env.GDS_MFA_ENCRYPTION_KEY = key.toString('hex');
    for (const method of ['enroll', 'disable', 'confirm', 'verify', 'recovery']) {
      const user = await fixture(), recovery = createRecoveryCodes(user.id);
      if (method !== 'enroll') {
        const encrypted = encryptMfaSecret(secret, key, user.id);
        await db.userMfa.create({ data: method === 'confirm'
          ? { userId: user.id, pendingSecretEncrypted: encrypted, pendingExpiresAt: new Date(Date.now() + 600000) }
          : { userId: user.id, enabled: true, revision: 2, secretEncrypted: encrypted, enabledAt: new Date(), recoveryCodeHashes: recovery.hashes } });
      }
      const primary = await seed(db, user.id, jwt, config.jwt.refreshSecret,
        { mfaRevision: ['enroll', 'confirm'].includes(method) ? 0 : 2, mfaVerified: ['disable', 'recovery'].includes(method) });
      await new AuthSecurityService(db, passwords).changePassword(user.id, 'synthetic-v2-old-password', 'synthetic-v2-new-password');
      const snapshot = async () => ({ user: await db.user.findUniqueOrThrow({ where: { id: user.id } }),
        factor: await db.userMfa.findUnique({ where: { userId: user.id } }),
        tokens: await db.refreshToken.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } }), audits: await db.auditLog.count({ where: { actorId: user.id } }) });
      const before = await snapshot(); assert.equal(before.user.authRevision, 1);
      const service = auth(db), controller = new MfaController(new MfaService(db), service);
      await assert.rejects(() => controller[method](primary.caller, { code: method === 'confirm' ? totpAt(secret, Math.floor(Date.now() / 30000)) : recovery.codes[0] }), error => error.getStatus?.() === 401);
      assert.deepEqual(await snapshot(), before, method + ': stale primary consumed factor or created session');
      const fresh = await service.login({ email: user.email, password: 'synthetic-v2-new-password' });
      assert.equal(jwt.decode(fresh.refreshToken).authRevision, 1);
      console.log('GDS_AUTH_V2_STALE_MFA_' + method.toUpperCase() + '=PASS; completed credential revocation denies stale caller before proof, new primary can authenticate');
    }
  } finally { if (oldKey === undefined) delete process.env.GDS_MFA_ENCRYPTION_KEY; else process.env.GDS_MFA_ENCRYPTION_KEY = oldKey; }
  assert.deepEqual(await db.courseAccessGrant.findMany({ orderBy: { id: 'asc' } }), grantsBefore);
};
