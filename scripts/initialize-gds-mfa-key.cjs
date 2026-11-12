'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const dotenv = require('dotenv');
const { loadMigrationDatabaseUrl, buildDatabaseClientConfig } = require('./run-production-migrations.cjs');

const KEY = 'GDS_MFA_ENCRYPTION_KEY';
const FAILURE = 'GDS_MFA_KEY_INITIALIZATION_FAILED';
const MATERIAL_QUERY = `SELECT EXISTS (
  SELECT 1 FROM public.user_mfa
  WHERE enabled OR secret_encrypted IS NOT NULL OR pending_secret_encrypted IS NOT NULL
     OR cardinality(recovery_code_hashes) > 0
) AS has_mfa_material`;
const fail = () => new Error(FAILURE);

function assertDirectoryAncestry(directory) {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  }
}

function assertPrivateFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1) throw fail();
  if (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw fail();
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function safeRead(file) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink()) throw fail();
  assertPrivateFile(before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    assertPrivateFile(stat);
    if (!sameIdentity(before, stat)) throw fail();
    return { bytes: fs.readFileSync(fd), stat };
  } finally { fs.closeSync(fd); }
}

function removeOwned(file, identity) {
  if (!file || !identity) return;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && sameIdentity(stat, identity)) fs.unlinkSync(file);
  } catch { /* Never replace a different writer's file while cleaning up. */ }
}

function keyState(source) {
  const declarations = source.match(/^[\t ]*(?:export[\t ]+)?GDS_MFA_ENCRYPTION_KEY(?=[\t =:]|$).*$/gm) ?? [];
  if (declarations.length > 1) throw fail();
  const values = dotenv.parse(source);
  const value = values[KEY];
  if (declarations.length && value === undefined) throw fail();
  if (value !== undefined && value !== '' && !/^[a-f0-9]{64}$/i.test(value)) throw fail();
  return { configured: Boolean(value), hasDeclaration: declarations.length === 1 };
}

async function assertNoEncryptedMaterial(root, dependencies) {
  const connectionString = (dependencies.loadDatabaseUrl ?? loadMigrationDatabaseUrl)(root);
  if (typeof connectionString !== 'string' || !/^postgres(?:ql)?:\/\//.test(connectionString)) throw fail();
  const ClientConstructor = dependencies.ClientConstructor ?? Client;
  const client = new ClientConstructor(buildDatabaseClientConfig(connectionString, 'eduai-gds-mfa-key-initialize'));
  let transaction = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY'); transaction = true;
    const result = await client.query(MATERIAL_QUERY);
    // Missing table, unexpected result shapes, and encrypted/pending records
    // all fail closed. Never replace a key needed to decrypt existing factors.
    if (result.rows?.length !== 1 || result.rows[0].has_mfa_material !== false) throw fail();
    await client.query('COMMIT'); transaction = false;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/** Initialize once, never rotate. CLI accepts no paths or secret arguments. */
async function initializeGdsMfaKey(dependencies = {}) {
  const root = path.resolve(dependencies.rootDirectory ?? path.join(__dirname, '..'));
  const file = path.join(root, '.env');
  const lock = path.join(root, '.env.gds-mfa.lock');
  let lockIdentity;
  let temporary;
  let temporaryIdentity;
  let descriptor;
  try {
    assertDirectoryAncestry(root);
    descriptor = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    lockIdentity = fs.fstatSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    const original = safeRead(file);
    // Reject invalid UTF-8 rather than silently rewriting unrelated bytes.
    const source = original.bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(original.bytes)) throw fail();
    const state = keyState(source);
    if (state.configured) return { mfaKeyConfigured: true, created: false };
    if ((dependencies.environment ?? process.env)[KEY]) throw fail();
    await assertNoEncryptedMaterial(root, dependencies);
    const secret = (dependencies.randomBytes ?? randomBytes)(32);
    if (!Buffer.isBuffer(secret) || secret.length !== 32) throw fail();
    const key = secret.toString('hex');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const candidate = state.hasDeclaration
      ? source.replace(/^([\t ]*(?:export[\t ]+)?)GDS_MFA_ENCRYPTION_KEY[\t ]*(?:=|:)[^\r\n]*(\r?\n|$)/m,
        (_match, prefix, ending) => `${prefix}${KEY}=${key}${ending}`)
      : source + (source && !source.endsWith('\n') ? newline : '') + `${KEY}=${key}${newline}`;
    if (candidate === source || dotenv.parse(candidate)[KEY] !== key) throw fail();
    temporary = path.join(root, `.env.gds-mfa-${randomUUID()}.tmp`);
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    temporaryIdentity = fs.fstatSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, candidate, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    assertDirectoryAncestry(root);
    const current = safeRead(file);
    if (!sameIdentity(original.stat, current.stat) || !current.bytes.equals(original.bytes)) throw fail();
    const lockStat = fs.lstatSync(lock);
    if (lockStat.isSymbolicLink() || !sameIdentity(lockIdentity, lockStat)) throw fail();
    // Same-directory atomic replacement follows the existing wallet env editor
    // pattern, with an exclusive initializer lock and source compare first.
    (dependencies.renameFile ?? fs.renameSync)(temporary, file);
    if (process.platform !== 'win32') {
      descriptor = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
    }
    const installed = safeRead(file);
    if (!sameIdentity(installed.stat, temporaryIdentity) || !installed.bytes.equals(Buffer.from(candidate, 'utf8'))) throw fail();
    return { mfaKeyConfigured: true, created: true };
  } catch { throw fail(); }
  finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    removeOwned(temporary, temporaryIdentity);
    removeOwned(lock, lockIdentity);
  }
}

if (require.main === module) {
  Promise.resolve().then(() => {
    if (process.argv.length !== 2) throw fail();
    return initializeGdsMfaKey();
  }).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error(FAILURE); process.exitCode = 1;
  });
}

module.exports = { initializeGdsMfaKey, MATERIAL_QUERY };
