'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Synthetic fixtures only. Never use this to issue sessions in a real database.
module.exports = async function seedV2Session(db, userId, jwt, refreshSecret, claims = {}) {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CI, 'true');
  assert.equal(url.username, 'eduai_migration_replay');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { refreshTokenDigest } = require('../dist/src/modules/auth/auth-session.js');
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { authRevision: true, email: true } });
  const id = randomUUID(), sid = randomUUID(), authTime = Math.floor(Date.now() / 1000);
  const payload = { ...claims, sub: userId, tokenVersion: 2, tokenUse: 'refresh', authRevision: user.authRevision, sid, jti: id, authTime };
  const token = await jwt.signAsync(payload, { secret: refreshSecret, expiresIn: 30 * 86400 });
  const row = await db.refreshToken.create({ data: { id, userId, sessionFamilyId: sid, tokenHash: refreshTokenDigest(token), expiresAt: new Date(Date.now() + 30 * 86400000) } });
  const { sub, tokenUse, jti, ...identity } = payload;
  return { token, row, caller: { ...identity, id: userId, email: user.email, roles: ['student'] } };
};
