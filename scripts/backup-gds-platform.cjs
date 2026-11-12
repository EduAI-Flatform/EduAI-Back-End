'use strict';

const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { loadMigrationDatabaseUrl } = require('./run-production-migrations.cjs');

const FAILURE = 'GDS_PLATFORM_BACKUP_FAILED';
const CLIENT_FAILURES = new Set(['CLIENT_NOT_FOUND', 'CLIENT_VERSION_MISMATCH',
  'DATABASE_PERMISSION_DENIED', 'DATABASE_AUTHENTICATION_FAILED', 'CLIENT_FAILED']);
const LIBPQ_PARAMETERS = Object.freeze({
  sslmode: 'PGSSLMODE', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', sslrootcert: 'PGSSLROOTCERT',
  sslcrl: 'PGSSLCRL', sslcrldir: 'PGSSLCRLDIR', sslcompression: 'PGSSLCOMPRESSION',
  sslsni: 'PGSSLSNI', sslcertmode: 'PGSSLCERTMODE',
  ssl_min_protocol_version: 'PGSSLMINPROTOCOLVERSION', ssl_max_protocol_version: 'PGSSLMAXPROTOCOLVERSION',
  sslnegotiation: 'PGSSLNEGOTIATION', channel_binding: 'PGCHANNELBINDING', gssencmode: 'PGGSSENCMODE',
  krbsrvname: 'PGKRBSRVNAME', requirepeer: 'PGREQUIREPEER', connect_timeout: 'PGCONNECT_TIMEOUT',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
});
const PRISMA_PARAMETERS = new Set(['schema', 'pgbouncer', 'connection_limit', 'pool_timeout', 'statement_cache_size', 'socket_timeout']);

function fail() { return new Error(FAILURE); }

function backupEnvironment(databaseUrl, environment) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.hostname
    || !url.pathname.slice(1) || url.hash) throw fail();
  for (const key of [...url.searchParams.keys()]) {
    if (PRISMA_PARAMETERS.has(key)) url.searchParams.delete(key);
    else if (!Object.hasOwn(LIBPQ_PARAMETERS, key)) throw fail();
  }
  // libpq does not expand a URI obtained through its PGDATABASE fallback.
  // Decode individual fields instead, keeping credentials out of argv and
  // preserving supported explicit TLS verification/certificate options.
  const child = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof environment[key] === 'string') child[key] = environment[key];
  }
  child.PGHOST = url.hostname.replace(/^\[|\]$/g, '');
  child.PGPORT = url.port || '5432';
  child.PGUSER = decodeURIComponent(url.username);
  child.PGPASSWORD = decodeURIComponent(url.password);
  child.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  child.PGAPPNAME = 'eduai-gds-platform-backup';
  child.PGCONNECT_TIMEOUT = '20';
  child.PGOPTIONS = '-c default_transaction_read_only=on';
  for (const [key, value] of url.searchParams) child[LIBPQ_PARAMETERS[key]] = value;
  // libpq 16+ needs an explicit trust source for verify-full. Use the OS CA
  // store like Node TLS; retain hostname verification and any supplied CA.
  // https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNECT-SSLROOTCERT
  if (child.PGSSLMODE === 'verify-full' && !url.searchParams.has('sslrootcert')) {
    child.PGSSLROOTCERT = 'system';
  }
  return child;
}

function assertDirectory(directory, privateDirectory = false) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  if (privateDirectory && process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail();
  }
}

function privateBackupDirectory(homeDirectory) {
  const home = path.resolve(homeDirectory);
  // Inspect every existing ancestor, including the home directory. Resolving
  // symlinks and then trusting the resolved location would hide unsafe paths.
  let ancestor = path.parse(home).root;
  for (const segment of home.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    assertDirectory(ancestor);
  }
  let directory = home;
  for (const segment of ['.local', 'share', 'eduai-backups', 'gds-platform']) {
    directory = path.join(directory, segment);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw fail(); }
    assertDirectory(directory, ['eduai-backups', 'gds-platform'].includes(segment));
  }
  if (!directory.startsWith(`${home}${path.sep}`) || fs.realpathSync(directory) !== directory) throw fail();
  return directory;
}

function sameFile(file, identity) {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev
    && stat.ino === identity.ino && stat.nlink === 1;
}

function checkedResult(result) {
  if (!result || result.error || result.signal || result.status !== 0) {
    // Classify locally; never return client stderr, connection fields or paths.
    const stderr = typeof result?.stderr === 'string' || Buffer.isBuffer(result?.stderr)
      ? result.stderr.toString() : '';
    const reason = result?.error?.code === 'ENOENT' ? 'CLIENT_NOT_FOUND'
      : /server version:.*pg_dump version:/s.test(stderr) ? 'CLIENT_VERSION_MISMATCH'
        : /permission denied/i.test(stderr) ? 'DATABASE_PERMISSION_DENIED'
          : /password authentication failed|no pg_hba.conf entry/i.test(stderr) ? 'DATABASE_AUTHENTICATION_FAILED'
            : 'CLIENT_FAILED';
    throw Object.assign(fail(), { reason });
  }
}

function hashFile(descriptor) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) break;
    hash.update(buffer.subarray(0, count)); position += count;
  }
  return hash.digest('hex');
}

/** Makes a server-local, verified custom-format backup. Never mutates the DB. */
function backupGdsPlatform(dependencies = {}) {
  const root = dependencies.rootDirectory ?? path.resolve(__dirname, '..');
  const home = dependencies.homeDirectory ?? homedir();
  const runner = dependencies.runner ?? spawnSync;
  let file;
  let identity;
  let descriptor;
  let stage = 'load-config';
  try {
    const environment = backupEnvironment(
      (dependencies.loadDatabaseUrl ?? loadMigrationDatabaseUrl)(root),
      dependencies.environment ?? process.env,
    );
    stage = 'prepare-directory';
    const directory = privateBackupDirectory(home);
    const date = (dependencies.now ?? (() => new Date()))();
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
    const identifier = (dependencies.uuid ?? randomUUID)();
    if (!/^[a-f0-9-]{36}$/.test(identifier)) throw fail();
    file = path.join(directory, `gds-platform-${timestamp}-${identifier}.dump`);
    stage = 'create-archive';
    descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    identity = fs.fstatSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    stage = 'dump';
    checkedResult(runner('pg_dump', ['--format=custom', '--no-password', '--serializable-deferrable'], {
      env: environment, shell: false, windowsHide: true, stdio: ['ignore', descriptor, 'pipe'],
      timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    }));
    stage = 'validate-archive';
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    if (!sameFile(file, identity)) throw fail();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || !stat.size || stat.nlink !== 1) throw fail();
    const magic = Buffer.alloc(5);
    if (fs.readSync(descriptor, magic, 0, 5, 0) !== 5 || magic.toString('ascii') !== 'PGDMP') throw fail();
    stage = 'archive-list';
    const listing = runner('pg_restore', ['--list'], {
      env: environment, shell: false, windowsHide: true, stdio: [descriptor, 'pipe', 'pipe'],
      timeout: 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    });
    checkedResult(listing);
    if (!(Buffer.isBuffer(listing.stdout) || typeof listing.stdout === 'string')
      || !listing.stdout.toString().trim()) throw fail();
    stage = 'hash';
    const sha256 = hashFile(descriptor);
    if (!sameFile(file, identity) || fs.fstatSync(descriptor).size !== stat.size) throw fail();
    fs.closeSync(descriptor); descriptor = undefined;
    return { backupPath: file, bytes: stat.size, sha256, format: 'pg_dump_custom', validated: true, createdAt: date.toISOString() };
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    // Remove only the incomplete inode created by this run. Never delete a
    // replaced file, symlink, pre-existing backup, or recursively remove dirs.
    if (file && identity) { try { if (sameFile(file, identity)) fs.unlinkSync(file); } catch {} }
    throw Object.assign(fail(), { stage, reason: CLIENT_FAILURES.has(error?.reason) ? error.reason : 'OPERATION_FAILED' });
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw fail();
    console.log(JSON.stringify(backupGdsPlatform()));
  } catch (error) {
    console.error(FAILURE);
    if (error?.message === FAILURE
      && (CLIENT_FAILURES.has(error.reason) || error.reason === 'OPERATION_FAILED')) {
      console.error(JSON.stringify({ backupFailureStage: error.stage, backupFailureReason: error.reason }));
    }
    process.exitCode = 1;
  }
}

module.exports = { backupGdsPlatform, backupEnvironment };
