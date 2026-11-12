'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeGdsMfaKey } = require('./initialize-gds-mfa-key.cjs');

const syntheticKey = 'ab'.repeat(32);
const syntheticDatabase = 'postgresql://migration:synthetic-database-secret@db.example/eduai';
const failure = { message: 'GDS_MFA_KEY_INITIALIZATION_FAILED' };

function fixture(t, source = 'NODE_ENV=production\nOTHER_VALUE="keep exactly"\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eduai-mfa-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.env');
  fs.writeFileSync(file, source, { mode: 0o600 });
  const queries = []; const clients = []; let material = false; let failQuery = false;
  class FakeClient {
    constructor(options) { clients.push(options); }
    async connect() { queries.push('connect'); }
    async query(sql) {
      queries.push(sql);
      if (failQuery) throw new Error(syntheticDatabase);
      if (sql.includes('SELECT EXISTS')) return { rows: [{ has_mfa_material: material }] };
      return { rows: [] };
    }
    async end() { queries.push('end'); }
  }
  const options = {
    rootDirectory: root, environment: {}, ClientConstructor: FakeClient,
    loadDatabaseUrl: directory => { assert.equal(directory, root); return syntheticDatabase; },
    randomBytes: length => { assert.equal(length, 32); return Buffer.from(syntheticKey, 'hex'); },
  };
  return { root, file, options, queries, clients, setMaterial: () => { material = true; }, failQuery: () => { failQuery = true; } };
}

test('preserves an existing valid key and every source byte without database access', async t => {
  const source = '# configuration\r\nGDS_MFA_ENCRYPTION_KEY="' + syntheticKey.toUpperCase() + '" # do not rotate\r\nOTHER=x\r\n';
  const f = fixture(t, source); const before = fs.statSync(f.file);
  const result = await initializeGdsMfaKey(f.options);
  assert.deepEqual(result, { mfaKeyConfigured: true, created: false });
  assert.equal(fs.readFileSync(f.file, 'utf8'), source);
  assert.equal(fs.statSync(f.file).mtimeMs, before.mtimeMs);
  assert.equal(f.clients.length, 0);
  assert.ok(!JSON.stringify(result).includes(syntheticKey));
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
});

test('initializes a missing key only after a read-only material check and preserves other bytes', async t => {
  const source = '# start\r\nOTHER="unchanged value"\r\n\r\n';
  const f = fixture(t, source);
  const result = await initializeGdsMfaKey(f.options);
  assert.deepEqual(result, { mfaKeyConfigured: true, created: true });
  assert.equal(fs.readFileSync(f.file, 'utf8'), source + 'GDS_MFA_ENCRYPTION_KEY=' + syntheticKey + '\r\n');
  assert.equal(f.clients[0].connectionString, syntheticDatabase);
  assert.ok(f.queries.includes('BEGIN READ ONLY'));
  assert.ok(f.queries.includes('COMMIT'));
  assert.ok(!f.queries.some(query => /INSERT|UPDATE|DELETE/i.test(query)));
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('replaces a single blank declaration without changing surrounding configuration', async t => {
  const f = fixture(t, 'BEFORE=x\n export GDS_MFA_ENCRYPTION_KEY="" # unset\nAFTER=y');
  await initializeGdsMfaKey(f.options);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'BEFORE=x\n export GDS_MFA_ENCRYPTION_KEY=' + syntheticKey + '\nAFTER=y');
});

test('rejects duplicate or invalid nonblank declarations without DB calls or mutations', async t => {
  for (const source of [
    'GDS_MFA_ENCRYPTION_KEY=invalid\n',
    'GDS_MFA_ENCRYPTION_KEY=' + syntheticKey + '\nGDS_MFA_ENCRYPTION_KEY=\n',
    'export GDS_MFA_ENCRYPTION_KEY=\n GDS_MFA_ENCRYPTION_KEY=\n',
    'GDS_MFA_ENCRYPTION_KEY\n',
  ]) {
    const f = fixture(t, source);
    await assert.rejects(initializeGdsMfaKey(f.options), failure);
    assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    assert.equal(f.clients.length, 0);
    assert.deepEqual(fs.readdirSync(f.root), ['.env']);
  }
});

test('never generates a replacement when encrypted or pending MFA material exists', async t => {
  const f = fixture(t); f.setMaterial(); const original = fs.readFileSync(f.file);
  f.options.randomBytes = () => { assert.fail('must not generate a replacement key'); };
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.ok(f.queries.some(sql => sql.includes('secret_encrypted IS NOT NULL') && sql.includes('pending_secret_encrypted IS NOT NULL') && sql.includes('recovery_code_hashes')));
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
});

test('fails closed and sanitizes read-only database failures', async t => {
  const f = fixture(t); f.failQuery(); const original = fs.readFileSync(f.file);
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.ok(f.queries.includes('end'));
});

test('detects concurrent source edits without overwriting the external update', async t => {
  const f = fixture(t);
  f.options.randomBytes = () => { fs.writeFileSync(f.file, 'EXTERNAL_CHANGE=preserve\n', { mode: 0o600 }); return Buffer.from(syntheticKey, 'hex'); };
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'EXTERNAL_CHANGE=preserve\n');
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
});

test('rejects a concurrently held initialization lock without deleting it', async t => {
  const f = fixture(t); const lock = path.join(f.root, '.env.gds-mfa.lock');
  fs.writeFileSync(lock, 'existing-lock', { mode: 0o600 });
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'existing-lock');
  assert.equal(f.clients.length, 0);
});

test('rejects a symlink root before reading or changing its target', async t => {
  const f = fixture(t); const alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlinkSync(alias));
  await assert.rejects(initializeGdsMfaKey({ ...f.options, rootDirectory: alias }), failure);
  assert.equal(f.clients.length, 0);
});

test('rejects a non-private existing env on POSIX', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); fs.chmodSync(f.file, 0o644);
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.equal(f.clients.length, 0);
});

test('does not generate over an external environment key absent from the file', async t => {
  const f = fixture(t); f.options.environment.GDS_MFA_ENCRYPTION_KEY = syntheticKey;
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.equal(f.clients.length, 0);
});

test('failed atomic rename preserves the original env and removes only this run temporary file', async t => {
  const f = fixture(t); const original = fs.readFileSync(f.file);
  f.options.renameFile = (temporary, target) => {
    assert.equal(target, f.file);
    assert.equal(path.dirname(temporary), f.root);
    assert.equal(require('dotenv').parse(fs.readFileSync(temporary))["GDS_MFA_ENCRYPTION_KEY"], syntheticKey);
    if (process.platform !== 'win32') assert.equal(fs.statSync(temporary).mode & 0o777, 0o600);
    throw new Error('synthetic-private-error:' + syntheticKey);
  };
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
});

test('rejects a symlink env file without reading or overwriting the target', async t => {
  const f = fixture(t); const target = path.join(f.root, 'private-target');
  fs.renameSync(f.file, target);
  try { fs.symlinkSync(target, f.file, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows file symlinks require developer mode or privilege'); return; } throw error; }
  const original = fs.readFileSync(target);
  await assert.rejects(initializeGdsMfaKey(f.options), failure);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(f.clients.length, 0);
});

test('rejects unknown database material-query results rather than assuming a new install', async t => {
  for (const rows of [[], [{ has_mfa_material: null }], [{ has_mfa_material: 'false' }], [{ wrong_column: false }]]) {
    const f = fixture(t); const original = fs.readFileSync(f.file); const queries = [];
    f.options.ClientConstructor = class {
      async connect() {}
      async query(sql) { queries.push(sql); return { rows }; }
      async end() { queries.push('end'); }
    };
    await assert.rejects(initializeGdsMfaKey(f.options), failure);
    assert.deepEqual(fs.readFileSync(f.file), original);
    assert.ok(queries.includes('ROLLBACK'));
    assert.ok(queries.includes('end'));
  }
});

test('a second successful invocation never rotates the installed key', async t => {
  const f = fixture(t);
  await initializeGdsMfaKey(f.options);
  const installed = fs.readFileSync(f.file);
  f.options.randomBytes = () => { assert.fail('second invocation must not generate a key'); };
  const result = await initializeGdsMfaKey(f.options);
  assert.equal(result.created, false);
  assert.deepEqual(fs.readFileSync(f.file), installed);
  assert.equal(f.clients.length, 1);
});
