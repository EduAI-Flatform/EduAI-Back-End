'use strict';
async function verifyPointRuntime(client, reader) {
  const result = await reader(client);
  if (result?.ready !== true) throw new Error('POINT_RUNTIME_NOT_READY');
  return { pointRuntimeReady: true };
}
async function main() {
  require('dotenv').config({ quiet: true });
  const { PrismaService } = require('../dist/src/prisma/prisma.service.js');
  const { readActivityPointReadiness } = require('../dist/src/modules/tmi/activity-point.readiness.js');
  const client = new PrismaService();
  try {
    console.log(JSON.stringify(await verifyPointRuntime(client, readActivityPointReadiness)));
  } finally { await client.$disconnect(); }
}
if (require.main === module) main().catch(() => {
  console.error('POINT_RUNTIME_VERIFICATION_FAILED'); process.exitCode = 1;
});
module.exports = { verifyPointRuntime };
