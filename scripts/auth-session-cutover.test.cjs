'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { restartWithAuthSessionFloor, captureProcessTree, isBackendPortOpen } = require('./auth-session-cutover.cjs');
const { loadPointRuntime, verifyPointRuntime } = require('./verify-point-runtime.cjs');
const sha = 'a'.repeat(40);
function fixture(version = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-auth-cutover-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node dist/src/main' } }));
  fs.mkdirSync(path.join(root, 'dist/src/modules/auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/src/main.js'), '// synthetic legacy runtime');
  fs.writeFileSync(path.join(root, 'dist/src/modules/auth/auth-session.js'), 'exports.AUTH_SESSION_TOKEN_VERSION=1;');
  fs.writeFileSync(path.join(root, 'dist/auth-runtime.json'), JSON.stringify({ tokenVersion: 1, revision: 'b'.repeat(40) }));
  const staged = path.join(root, '.git/auth-session-candidate');
  const stage = () => {
    fs.mkdirSync(path.join(staged, 'dist/src/modules/auth'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'dist/src/main.js'), '// synthetic candidate runtime');
    fs.writeFileSync(path.join(staged, 'dist/src/modules/auth/auth-session.js'), `exports.AUTH_SESSION_TOKEN_VERSION=${version};`);
    fs.writeFileSync(path.join(staged, 'dist/auth-runtime.json'), JSON.stringify({ tokenVersion: version, revision: sha }));
  };
  stage();
  const marker = path.join(root, '.git/auth-session-minimum-version.json');
  let state = 'online', pid = 101, nextPid = 201, oldAlive = true;
  const calls = [], failures = { stop: false, start: false, health: false, lingering: false };
  const layout = { exec_interpreter: 'node', pm_cwd: root, watch: false };
  const spawn = (_command, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'jlist') return { status: 0, stdout: JSON.stringify([{ name: 'eduai-backend', pid,
      pm2_env: { status: state, exec_mode: 'fork_mode', pm_exec_path: path.join(root, 'dist/src/main.js'), ...layout } }]) };
    if (args[0] === 'stop') { if (failures.stop) return { status: 1 }; state = 'stopped'; pid = 0; oldAlive = failures.lingering; }
    if (args[0] === 'restart') { if (failures.start) return { status: 1 }; state = 'online'; pid = ++nextPid; }
    return { status: 0 };
  };
  const dependencies = { root, spawn, wait: async () => {}, isAlive: value => value === 101 && oldAlive,
    processTree: async value => [value], isPortOpen: async () => false,
    readHealth: async () => ({ status: 'ok', authSession: { tokenVersion: 2, revision: failures.health ? 'b'.repeat(40) : sha } }) };
  const invoke = (authorizeCutover = false) => restartWithAuthSessionFloor({ EXPECTED_DEPLOY_SHA: sha, PORT: '3000' }, { ...dependencies, authorizeCutover });
  return { root, staged, stage, layout, marker, failures, calls, dependencies, invoke, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('first cutover requires explicit authorization before marker or process mutation', async () => {
  const f = fixture(); try {
    await assert.rejects(() => f.invoke(), /AUTH_SESSION_CUTOVER_AUTHORIZATION_REQUIRED/);
    assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.marker), false);
    // A crash/autorestart still targets legacy bytes: denied staging never
    // installs the candidate into the currently managed executable path.
    assert.equal(fs.readFileSync(path.join(f.root, 'dist/src/main.js'), 'utf8'), '// synthetic legacy runtime');
  } finally { f.cleanup(); }
});
test('writes durable floor before stop, drains old PID, verifies exact build health then saves', async () => {
  const f = fixture(); try {
    await f.invoke(true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.marker)), { minimumTokenVersion: 2, firstRevision: sha });
    assert.ok(f.calls.indexOf('stop eduai-backend') < f.calls.indexOf('restart eduai-backend --update-env'));
    assert.equal(f.calls.at(-1), 'save');
    fs.rmSync(f.staged, { recursive: true }); f.stage();
    await f.invoke(false); // Established floor permits subsequent compatible deploys.
    assert.equal(JSON.parse(fs.readFileSync(f.marker)).firstRevision, sha);
  } finally { f.cleanup(); }
});
test('rejects legacy candidates and malformed/missing metadata before PM2 mutation', async () => {
  for (const kind of ['legacy', 'missing', 'revision', 'marker']) {
    const f = fixture(kind === 'legacy' ? 1 : 2); try {
      if (kind === 'missing') fs.unlinkSync(path.join(f.staged, 'dist/auth-runtime.json'));
      if (kind === 'revision') fs.writeFileSync(path.join(f.staged, 'dist/auth-runtime.json'), JSON.stringify({ tokenVersion: 2, revision: 'b'.repeat(40) }));
      if (kind === 'marker') fs.writeFileSync(f.marker, '{}', { mode: 0o600 });
      await assert.rejects(() => f.invoke(true)); assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
  }
});
test('rejects non-Node interpreter, different cwd and file watching before floor or stop', async () => {
  for (const change of [{ exec_interpreter: 'python' }, { pm_cwd: os.tmpdir() }, { watch: true }]) {
    const f = fixture(); try {
      Object.assign(f.layout, change);
      await assert.rejects(() => f.invoke(true), /AUTH_SESSION_PROCESS_LAYOUT_UNSUPPORTED/);
      assert.equal(fs.existsSync(f.marker), false); assert.equal(f.calls.includes('stop eduai-backend'), false);
    } finally { f.cleanup(); }
  }
});
test('layout rejection exposes bounded diagnostic facts without command paths or environment', async () => {
  const f = fixture(); try {
    f.layout.exec_interpreter = 'none';
    let caught;
    try { await f.invoke(true); } catch (error) { caught = error; }
    assert.equal(caught?.message, 'AUTH_SESSION_PROCESS_LAYOUT_UNSUPPORTED');
    assert.equal(caught?.processLayout?.managedCount, 1);
    assert.equal(caught?.processLayout?.nodeInterpreter, false);
    assert.equal(caught?.processLayout?.interpreterKind, 'NONE');
    assert.equal(caught?.processLayout?.watchState, 'DISABLED');
    assert.equal(caught?.processLayout?.cwdMatches, true);
    assert.equal(caught?.processLayout?.entryKind, 'DIRECT_MAIN');
    assert.equal(caught?.processLayout?.minimumVersionPersisted, false);
    assert.ok(!JSON.stringify(caught.processLayout).includes(f.root));
    assert.equal(f.calls.includes('stop eduai-backend'), false); assert.equal(fs.existsSync(f.marker), false);
  } finally { f.cleanup(); }
});
test('preserves the observed npm-start launcher while draining its whole old process tree', async () => {
  const f = fixture(); try {
    Object.assign(f.layout, { pm_exec_path: path.join(f.root, 'npm'), args: ['start'] });
    let capturedBeforeStop = false;
    f.dependencies.processTree = async () => { capturedBeforeStop = !f.calls.includes('stop eduai-backend'); return [101, 102, 103]; };
    f.dependencies.isAlive = pid => !f.calls.includes('stop eduai-backend') && [101, 102, 103].includes(pid);
    const result = await f.invoke(true);
    assert.equal(capturedBeforeStop, true); assert.equal(result.oldProcessCount, 3);
    assert.equal(result.launcher, 'NPM_START'); assert.ok(f.calls.includes('restart eduai-backend --update-env'));
  } finally { f.cleanup(); }
});
test('rejects npm pre/post hooks and unexpected start scripts before floor or stop', async () => {
  for (const scripts of [{ start: 'node other.js' }, { start: 'node dist/src/main', prestart: 'node other.js' }, { start: 'node dist/src/main', poststart: 'node other.js' }]) {
    const f = fixture(); try {
      Object.assign(f.layout, { pm_exec_path: path.join(f.root, 'npm'), args: ['start'] });
      fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts }));
      await assert.rejects(() => f.invoke(true), /AUTH_SESSION_PROCESS_LAYOUT_UNSUPPORTED/);
      assert.equal(fs.existsSync(f.marker), false); assert.equal(f.calls.includes('stop eduai-backend'), false);
    } finally { f.cleanup(); }
  }
});
test('an old npm child or listening backend port prevents artifact promotion and restart', async () => {
  for (const kind of ['child', 'port']) {
    const f = fixture(); try {
      Object.assign(f.layout, { pm_exec_path: path.join(f.root, 'npm'), args: ['start'] });
      f.dependencies.processTree = async () => [101, 102];
      f.dependencies.isAlive = pid => kind === 'child' && pid === 102;
      f.dependencies.isPortOpen = async () => kind === 'port';
      await assert.rejects(() => f.invoke(true), kind === 'child' ? /AUTH_SESSION_OLD_PROCESS_NOT_DRAINED/ : /AUTH_SESSION_LEGACY_PORT_STILL_OPEN/);
      assert.equal(f.calls.includes('restart eduai-backend --update-env'), false);
      assert.equal(fs.readFileSync(path.join(f.root, 'dist/src/main.js'), 'utf8'), '// synthetic legacy runtime');
      assert.equal(JSON.parse(fs.readFileSync(f.marker)).minimumTokenVersion, 2);
    } finally { f.cleanup(); }
  }
});

test('process-tree snapshot includes descendants only and rejects unavailable or malformed snapshots', () => {
  const spawn = (command, args, options) => {
    assert.equal(command, 'ps'); assert.deepEqual(args, ['-e', '-o', 'pid=,ppid=']);
    assert.equal(options.shell, false);
    return { status: 0, stdout: '1 0\n101 1\n102 101\n103 102\n200 1\n' };
  };
  assert.deepEqual(captureProcessTree(101, spawn, {}), [101, 102, 103]);
  for (const result of [{ status: 1 }, { status: 0, stdout: '' },
    { status: 0, stdout: '1 0' }, { status: 0, stdout: '101 1\n101 2' },
    { status: 0, stdout: '101 102\n102 101' }, { status: 0, stdout: '101 bad' }]) {
    assert.throws(() => captureProcessTree(101, () => result), /AUTH_SESSION_PROCESS_TREE_/);
  }
});

test('failed process-tree capture precedes durable floor and stop', async () => {
  const f = fixture(); try {
    f.dependencies.processTree = async () => { throw new Error('AUTH_SESSION_PROCESS_TREE_UNAVAILABLE'); };
    await assert.rejects(() => f.invoke(true), /AUTH_SESSION_PROCESS_TREE_UNAVAILABLE/);
    assert.equal(fs.existsSync(f.marker), false); assert.equal(f.calls.includes('stop eduai-backend'), false);
  } finally { f.cleanup(); }
});

test('native port probe distinguishes a listening server from its closed port', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  try { assert.equal(await isBackendPortOpen(port), true); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  assert.equal(await isBackendPortOpen(port), false);
});
test('stop/start/health failures never lower the floor or restore legacy execution', async () => {
  for (const failure of ['stop', 'start', 'health', 'lingering']) {
    const f = fixture(); try {
      f.failures[failure] = true;
      await assert.rejects(() => f.invoke(true));
      assert.equal(JSON.parse(fs.readFileSync(f.marker)).minimumTokenVersion, 2);
      assert.equal(f.calls.includes('save'), false);
      assert.ok(f.calls.filter(value => value.startsWith('restart')).length <= 1);
      if (failure === 'lingering') assert.equal(f.calls.includes('restart eduai-backend --update-env'), false);
    } finally { f.cleanup(); }
  }
});
test('pre-promotion point readiness uses the staged implementation rather than live code', async () => {
  const f = fixture(); try {
    for (const [directory, ready] of [[path.join(f.root, 'dist'), false], [path.join(f.staged, 'dist'), true]]) {
      fs.mkdirSync(path.join(directory, 'src/prisma'), { recursive: true });
      fs.mkdirSync(path.join(directory, 'src/modules/tmi'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'src/prisma/prisma.service.js'), 'exports.PrismaService=class {};');
      fs.writeFileSync(path.join(directory, 'src/modules/tmi/activity-point.readiness.js'), `exports.readActivityPointReadiness=async()=>({ready:${ready}});`);
    }
    const staged = loadPointRuntime(f.root, ['--staged']), live = loadPointRuntime(f.root, []);
    await assert.rejects(() => verifyPointRuntime(new live.PrismaService(), live.readActivityPointReadiness), /POINT_RUNTIME_NOT_READY/);
    assert.deepEqual(await verifyPointRuntime(new staged.PrismaService(), staged.readActivityPointReadiness), { pointRuntimeReady: true });
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
    assert.match(workflow, /node scripts\/verify-point-runtime\.cjs --staged/);
    assert.match(workflow, /deployment_stage="backend-build"\s+npm run build:auth-candidate/);
  } finally { f.cleanup(); }
});
