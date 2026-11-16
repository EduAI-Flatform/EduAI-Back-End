'use strict';
const path = require('node:path');
function loadPointRuntime(root, args) {
  if (args.length > 1 || args.some(arg => arg !== '--staged')) throw new Error('POINT_RUNTIME_ARGUMENT_INVALID');
  const directory = path.join(root, args.includes('--staged') ? '.git/auth-session-candidate/dist' : 'dist');
  const { PrismaService } = require(path.join(directory, 'src/prisma/prisma.service.js'));
  const { readActivityPointReadiness } = require(path.join(directory, 'src/modules/tmi/activity-point.readiness.js'));
  return { PrismaService, readActivityPointReadiness };
}
async function verifyPointRuntime(client, reader) {
  const result = await reader(client);
  if (result?.ready !== true) throw new Error('POINT_RUNTIME_NOT_READY');
  return { pointRuntimeReady: true };
}
async function main() {
  require('dotenv').config({ quiet: true });
  const { PrismaService, readActivityPointReadiness } = loadPointRuntime(process.cwd(), process.argv.slice(2));
  const client = new PrismaService();
  try {
    console.log(JSON.stringify(await verifyPointRuntime(client, readActivityPointReadiness)));
  } finally { await client.$disconnect(); }
}
if (require.main === module) main().catch(() => {
  console.error('POINT_RUNTIME_VERIFICATION_FAILED'); process.exitCode = 1;
});
module.exports = { verifyPointRuntime, loadPointRuntime };
