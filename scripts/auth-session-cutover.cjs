'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const shaPattern = /^[0-9a-f]{40}$/;
const fail = code => new Error(code);
function regularPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw fail('AUTH_SESSION_FLOOR_INVALID');
}
function candidate(root, expected) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'dist/auth-runtime.json'), 'utf8'));
    const modulePath = path.join(root, 'dist/src/modules/auth/auth-session.js');
    delete require.cache[require.resolve(modulePath)];
    const version = require(modulePath).AUTH_SESSION_TOKEN_VERSION;
    if (!shaPattern.test(expected ?? '') || metadata.revision !== expected || version !== 2 || metadata.tokenVersion !== version)
      throw fail('AUTH_SESSION_CANDIDATE_INVALID');
    return metadata;
  } catch { throw fail('AUTH_SESSION_CANDIDATE_INVALID'); }
}
function floorAt(root) {
  const git = path.join(root, '.git'), stat = fs.lstatSync(git);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('AUTH_SESSION_FLOOR_INVALID');
  const file = path.join(git, 'auth-session-minimum-version.json');
  try {
    regularPrivateFile(file);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(record.minimumTokenVersion) || record.minimumTokenVersion < 2 || !shaPattern.test(record.firstRevision ?? '')) throw fail('AUTH_SESSION_FLOOR_INVALID');
    return { file, record };
  } catch (error) { if (error.code === 'ENOENT') return { file, record: null }; throw fail('AUTH_SESSION_FLOOR_INVALID'); }
}
function establishFloor(file, revision) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ minimumTokenVersion: 2, firstRevision: revision }));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') { const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    regularPrivateFile(file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function restartWithAuthSessionFloor(environment, options = {}) {
  const root = options.root ?? process.cwd(), spawn = options.spawn ?? spawnSync;
  const wait = options.wait ?? delay, isAlive = options.isAlive ?? alive;
  const staged = path.join(root, '.git/auth-session-candidate');
  const metadata = candidate(staged, environment.EXPECTED_DEPLOY_SHA), floor = floorAt(root);
  if (!floor.record && options.authorizeCutover !== true) throw fail('AUTH_SESSION_CUTOVER_AUTHORIZATION_REQUIRED');
  if (floor.record && metadata.tokenVersion < floor.record.minimumTokenVersion) throw fail('AUTH_SESSION_DOWNGRADE_FORBIDDEN');
  const port = Number(environment.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('AUTH_SESSION_PORT_INVALID');
  const readHealth = options.readHealth ?? (async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw fail('AUTH_SESSION_READINESS_FAILED');
    const body = await response.json(); return body.data ?? body;
  });
  const pm2 = (args, capture = false) => {
    const result = spawn('pm2', args, { env: environment, shell: false, ...(capture ? { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] } : { stdio: 'inherit' }) });
    if (result.status !== 0) throw fail('AUTH_SESSION_PROCESS_COMMAND_FAILED');
    return result;
  };
  const managed = () => {
    let all; try { all = JSON.parse(pm2(['jlist'], true).stdout); } catch { throw fail('AUTH_SESSION_PROCESS_STATE_INVALID'); }
    const list = Array.isArray(all) ? all.filter(item => item.name === 'eduai-backend') : [];
    const app = list[0], expected = path.join(root, 'dist/src/main');
    const state = app?.pm2_env ?? {};
    const entryMatches = typeof state.pm_exec_path === 'string' && [expected, expected + '.js'].includes(path.resolve(state.pm_exec_path));
    const sameRealPath = (left, right) => {
      if (typeof left !== 'string' || !left) return false;
      try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
    };
    const entryBase = typeof state.pm_exec_path === 'string' ? path.basename(state.pm_exec_path) : '';
    const args = JSON.stringify(Array.isArray(state.args) ? state.args : typeof state.args === 'string' ? state.args.split(' ') : []);
    const facts = { managedCount: list.length, forkMode: state.exec_mode === 'fork_mode',
      nodeInterpreter: typeof state.exec_interpreter === 'string' && ['node', 'node.exe'].includes(path.basename(state.exec_interpreter)),
      cwdMatches: typeof state.pm_cwd === 'string' && path.resolve(state.pm_cwd) === path.resolve(root),
      cwdResolvesToRoot: sameRealPath(state.pm_cwd, root), watchingDisabled: state.watch === false,
      entryMatches, entryResolvesToMain: sameRealPath(state.pm_exec_path, expected + '.js'),
      entryKind: entryMatches ? 'DIRECT_MAIN' : ['npm', 'npm.cmd', 'npm-cli.js'].includes(entryBase) ? 'NPM' : ['node', 'node.exe'].includes(entryBase) ? 'NODE_BINARY' : 'OTHER',
      argumentsKind: args === '["start"]' ? 'NPM_START' : args === '["run","start"]' ? 'NPM_RUN_START' : args === '[]' ? 'NONE' : 'OTHER',
      minimumVersionPersisted: floor.record !== null };
    if (facts.managedCount !== 1 || !facts.forkMode || !facts.nodeInterpreter || !facts.cwdMatches || !facts.watchingDisabled || !facts.entryMatches) {
      const error = fail('AUTH_SESSION_PROCESS_LAYOUT_UNSUPPORTED');
      error.processLayout = facts; throw error;
    }
    return app;
  };
  const before = managed();
  if (!Number.isSafeInteger(before.pid) || before.pid < 0) throw fail('AUTH_SESSION_PROCESS_STATE_INVALID');
  const oldPid = before.pid;
  // The floor survives every later failure. Never lower it or restart legacy code.
  if (!floor.record) establishFloor(floor.file, metadata.revision);
  pm2(['stop', 'eduai-backend']);
  let drained = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const stopped = managed();
    if (stopped.pm2_env.status === 'stopped' && stopped.pid === 0 && (oldPid === 0 || !isAlive(oldPid))) { drained = true; break; }
    await wait(100);
  }
  if (!drained) throw fail('AUTH_SESSION_OLD_PROCESS_NOT_DRAINED');
  try {
    const live = path.join(root, 'dist'), previous = path.join(staged, 'previous-dist');
    if (fs.existsSync(live)) {
      const stat = fs.lstatSync(live);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('AUTH_SESSION_LIVE_ARTIFACT_INVALID');
      fs.renameSync(live, previous);
    }
    fs.renameSync(path.join(staged, 'dist'), live);
    candidate(root, environment.EXPECTED_DEPLOY_SHA);
    pm2(['restart', 'eduai-backend', '--update-env']);
    let ready = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const app = managed();
      try {
        const health = await readHealth();
        if (app.pm2_env.status === 'online' && Number.isSafeInteger(app.pid) && app.pid > 0 && app.pid !== oldPid &&
          health.status === 'ok' && health.authSession?.tokenVersion === metadata.tokenVersion && health.authSession?.revision === metadata.revision) { ready = true; break; }
      } catch { /* Startup can briefly refuse connections; bounded retry only. */ }
      await wait(1000);
    }
    if (!ready) throw fail('AUTH_SESSION_READINESS_FAILED');
    pm2(['save']);
  } catch (error) {
    try { pm2(['stop', 'eduai-backend']); } catch { /* Keep original failure; never restore the old binary. */ }
    throw error;
  }
  return { tokenVersion: metadata.tokenVersion, revision: metadata.revision, oldProcessDrained: true, minimumVersionPersisted: true };
}
module.exports = { restartWithAuthSessionFloor };
