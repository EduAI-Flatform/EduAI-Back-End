'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { backupGdsPlatform, backupEnvironment } = require('./backup-gds-platform.cjs');

const syntheticUrl = 'postgresql://migration-user:synthetic-private-password@database.example/eduai?sslmode=verify-full&sslrootcert=%2Fprivate%2Froot.crt&schema=public';
const fixedUuid = '00000000-0000-4000-8000-000000000001';
const dump = Buffer.from('PGDMPsynthetic-backup-content');
const failure = { message: 'GDS_PLATFORM_BACKUP_FAILED' };

test('uses system trust roots for verify-full without overriding an explicit CA or reducing TLS verification', () => {
  const system = backupEnvironment('postgresql://user:secret@db.example/eduai?sslmode=verify-full', {});
  assert.equal(system.PGSSLMODE, 'verify-full');
  assert.equal(system.PGSSLROOTCERT, 'system');
  for (const root of ['/private/custom.crt', 'system', '']) {
    const explicit = backupEnvironment('postgresql://user:secret@db.example/eduai?sslmode=verify-full&sslrootcert=' + encodeURIComponent(root), {});
    assert.equal(explicit.PGSSLROOTCERT, root);
    assert.equal(explicit.PGSSLMODE, 'verify-full');
  }
  for (const mode of ['require', 'verify-ca', 'disable']) {
    const explicit = backupEnvironment('postgresql://user:secret@db.example/eduai?sslmode=' + mode, {});
    assert.equal(explicit.PGSSLMODE, mode);
    assert.equal(explicit.PGSSLROOTCERT, undefined);
  }
});

test('reports only fixed diagnostic codes for missing clients and database failures', t => {
  const f = fixture(t);
  for (const [result, reason] of [
    [{ error: { code: 'ENOENT', message: syntheticUrl } }, 'CLIENT_NOT_FOUND'],
    [{ status: 1, stderr: 'pg_dump: error: server version: 17.0; pg_dump version: 16.0; ' + syntheticUrl }, 'CLIENT_VERSION_MISMATCH'],
    [{ status: 1, stderr: 'permission denied for table private_name ' + syntheticUrl }, 'DATABASE_PERMISSION_DENIED'],
    [{ status: 1, stderr: syntheticUrl }, 'CLIENT_FAILED'],
  ]) {
    assert.throws(() => backupGdsPlatform({ ...f.options, runner: () => result }), error => {
      assert.equal(error.message, failure.message);
      assert.equal(error.stage, 'dump');
      assert.equal(error.reason, reason);
      assert.ok(!JSON.stringify(error).includes('synthetic-private-password'));
      assert.ok(!JSON.stringify(error).includes('private_name'));
      return true;
    });
  }
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eduai-backup-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const options = {
    homeDirectory: home, rootDirectory: path.join(home, 'backend'),
    environment: { PATH: process.env.PATH ?? '', PGHOST: 'untrusted.example', PGOPTIONS: '-c role=superuser', DATABASE_URL: 'runtime-secret', OTHER_API_SECRET: 'application-secret' },
    loadDatabaseUrl: root => { assert.equal(root, path.join(home, 'backend')); return syntheticUrl; },
    now: () => new Date('2026-11-12T01:02:03.000Z'), uuid: () => fixedUuid,
    runner: (program, args, child) => {
      calls.push({ program, args, child });
      if (program === 'pg_dump') fs.writeSync(child.stdio[1], dump);
      return { status: 0, signal: null, stdout: 'PRIVATE TOC NEVER PRINTED', stderr: 'synthetic-private-password' };
    },
  };
  return { home, calls, options, directory: path.join(home, '.local', 'share', 'eduai-backups', 'gds-platform') };
}

test('creates an exclusive private custom backup, validates its TOC and returns metadata only', t => {
  const f = fixture(t);
  const result = backupGdsPlatform(f.options);
  assert.equal(result.validated, true);
  assert.equal(result.format, 'pg_dump_custom');
  assert.equal(result.bytes, dump.length);
  assert.equal(result.sha256, createHash('sha256').update(dump).digest('hex'));
  assert.ok(result.backupPath.startsWith(f.directory + path.sep));
  assert.deepEqual(fs.readFileSync(result.backupPath), dump);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => [call.program, call.args]), [
    ['pg_dump', ['--format=custom', '--no-password', '--serializable-deferrable']], ['pg_restore', ['--list']],
  ]);
  for (const call of f.calls) {
    assert.equal(call.child.shell, false);
    assert.equal(call.child.windowsHide, true);
    assert.ok(!JSON.stringify(call.args).includes('postgres'));
    assert.equal(call.child.env.PGOPTIONS, '-c default_transaction_read_only=on');
    assert.equal(call.child.env.PGHOST, 'database.example');
    assert.equal(call.child.env.PGPORT, '5432');
    assert.equal(call.child.env.PGUSER, 'migration-user');
    assert.equal(call.child.env.PGPASSWORD, 'synthetic-private-password');
    assert.equal(call.child.env.PGDATABASE, 'eduai');
    assert.equal(call.child.env.DATABASE_URL, undefined);
    assert.equal(call.child.env.OTHER_API_SECRET, undefined);
    assert.equal(call.child.env.PGSSLMODE, 'verify-full');
    assert.equal(call.child.env.PGSSLROOTCERT, '/private/root.crt');
    assert.equal(call.child.env.schema, undefined);
  }
  assert.equal(f.calls[0].child.stdio[0], 'ignore');
  assert.equal(typeof f.calls[0].child.stdio[1], 'number');
  assert.equal(typeof f.calls[1].child.stdio[0], 'number');
  assert.equal(f.calls[1].child.stdio[1], 'pipe');
  assert.ok(!JSON.stringify(result).includes('synthetic-private-password'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE TOC'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  }
});

test('rejects a colliding backup name without overwriting or deleting the existing file', t => {
  const f = fixture(t); const first = backupGdsPlatform(f.options);
  const original = fs.readFileSync(first.backupPath);
  assert.throws(() => backupGdsPlatform(f.options), failure);
  assert.deepEqual(fs.readFileSync(first.backupPath), original);
  assert.equal(f.calls.length, 2);
});

test('sanitizes missing/invalid dedicated credential-loader errors before creating a backup', t => {
  const f = fixture(t);
  for (const loadDatabaseUrl of [() => { throw new Error(syntheticUrl); }, () => undefined, () => 'https://secret.example/database', () => 'postgresql://user:secret@db/', () => syntheticUrl + '&options=-c%20role%3Dsuperuser']) {
    assert.throws(() => backupGdsPlatform({ ...f.options, loadDatabaseUrl }), failure);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(fs.existsSync(f.directory), false);
});

for (const mode of ['throw', 'exit', 'signal', 'timeout', 'empty', 'invalid-format', 'restore-failed', 'restore-empty-list']) {
  test(`removes only the incomplete owned backup and sanitizes ${mode} failures`, t => {
    const f = fixture(t);
    const runner = (program, args, child) => {
      if (program === 'pg_dump') {
        if (mode === 'throw') throw new Error(syntheticUrl);
        if (mode === 'exit') return { status: 1, stderr: syntheticUrl };
        if (mode === 'signal') return { status: null, signal: 'SIGTERM', stderr: syntheticUrl };
        if (mode === 'timeout') return { status: null, error: new Error(syntheticUrl) };
        if (mode !== 'empty') fs.writeSync(child.stdio[1], mode === 'invalid-format' ? 'invalid' : dump);
      }
      if (program === 'pg_restore' && mode === 'restore-failed') return { status: 1, stdout: syntheticUrl, stderr: syntheticUrl };
      if (program === 'pg_restore' && mode === 'restore-empty-list') return { status: 0, stdout: '' };
      return { status: 0 };
    };
    assert.throws(() => backupGdsPlatform({ ...f.options, runner }), failure);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  });
}

test('rejects symlink ancestors without writing outside the private home', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eduai-backup-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.home, '.local'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => backupGdsPlatform(f.options), failure);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(f.calls.length, 0);
});

test('rejects symlink destination without modifying its target', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  const outside = path.join(f.home, 'outside.dump'); fs.writeFileSync(outside, 'existing');
  const filename = `gds-platform-2026-11-12T01-02-03-000Z-${fixedUuid}.dump`;
  try { fs.symlinkSync(outside, path.join(f.directory, filename), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows file symlinks require developer mode or privilege'); return; } throw error; }
  assert.throws(() => backupGdsPlatform(f.options), failure);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'existing');
  assert.equal(f.calls.length, 0);
});

test('does not clean up a file replaced by another inode while pg_dump is running', t => {
  const f = fixture(t); let replacement; let saved;
  const runner = (_program, _args, child) => {
    fs.writeSync(child.stdio[1], dump);
    replacement = path.join(f.directory, fs.readdirSync(f.directory)[0]);
    saved = replacement + '.held';
    fs.renameSync(replacement, saved);
    fs.writeFileSync(replacement, 'unrelated replacement');
    return { status: 1, stderr: syntheticUrl };
  };
  assert.throws(() => backupGdsPlatform({ ...f.options, runner }), failure);
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'unrelated replacement');
  assert.deepEqual(fs.readFileSync(saved), dump);
});

test('does not accept injected filename traversal', t => {
  const f = fixture(t);
  assert.throws(() => backupGdsPlatform({ ...f.options, uuid: () => '../../outside' }), failure);
  assert.equal(f.calls.length, 0);
});

test('rejects an existing group-readable backup directory on POSIX', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(f.directory, 0o755);
  assert.throws(() => backupGdsPlatform(f.options), failure);
  assert.equal(f.calls.length, 0);
});

test('does not inherit connection overrides and preserves explicit TLS options', () => {
  const env = backupEnvironment(syntheticUrl, { PGSSLMODE: 'disable', PGSERVICE: 'unsafe', PGPASSWORD: 'runtime-password', PGOPTIONS: 'unsafe' });
  assert.equal(env.PGSSLMODE, 'verify-full'); assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGPASSWORD, 'synthetic-private-password');
  assert.equal(env.PGSSLROOTCERT, '/private/root.crt');
});

test('decodes credentials and database names and preserves custom ports and IPv6 hosts', () => {
  const env = backupEnvironment('postgresql://migration%40user:pass%3Aword@[::1]:6543/eduai%20db?sslmode=require&channel_binding=require', {});
  assert.equal(env.PGHOST, '::1'); assert.equal(env.PGPORT, '6543');
  assert.equal(env.PGUSER, 'migration@user'); assert.equal(env.PGPASSWORD, 'pass:word');
  assert.equal(env.PGDATABASE, 'eduai db'); assert.equal(env.PGCHANNELBINDING, 'require');
});
