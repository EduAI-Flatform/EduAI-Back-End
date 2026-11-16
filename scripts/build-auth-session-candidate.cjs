'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.cwd(), git = path.join(root, '.git');
const gitStat = fs.lstatSync(git);
if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error('AUTH_SESSION_STAGE_INVALID');
const staging = path.resolve(git, 'auth-session-candidate');
if (path.dirname(staging) !== path.resolve(git)) throw new Error('AUTH_SESSION_STAGE_INVALID');
if (fs.existsSync(staging)) {
  const stat = fs.lstatSync(staging);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('AUTH_SESSION_STAGE_INVALID');
  // Only the verified generated-artifact directory is cleared, never source,
  // the durable minimum-version marker or any application/user data.
  fs.rmSync(staging, { recursive: true });
}
fs.mkdirSync(staging);
const config = path.join(git, 'auth-session-candidate.tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ extends: '../tsconfig.build.json',
  compilerOptions: { outDir: './auth-session-candidate/dist', incremental: false },
  include: ['../src/**/*.ts', '../generated/**/*.ts', '../prisma/**/*.ts'],
}), { mode: 0o600 });
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', config], { stdio: 'inherit', shell: false });
if (result.status !== 0) process.exit(result.status || 1);
const metadata = spawnSync(process.execPath, [path.join(root, 'scripts/write-auth-runtime-metadata.cjs'), '--staged'], { stdio: 'inherit', shell: false });
if (metadata.status !== 0) process.exit(metadata.status || 1);
console.log('authSessionCandidate: STAGED_WITHOUT_MUTATING_LIVE_DIST');
