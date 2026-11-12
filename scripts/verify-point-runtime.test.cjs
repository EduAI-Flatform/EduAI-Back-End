'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyPointRuntime } = require('./verify-point-runtime.cjs');
test('deployment verifies the actual runtime client without changing policies', async () => {
  const client = {};
  assert.deepEqual(await verifyPointRuntime(client, async input => {
    assert.equal(input, client); return { ready: true };
  }), { pointRuntimeReady: true });
  await assert.rejects(verifyPointRuntime(client, async () => ({ ready: false })), /POINT_RUNTIME_NOT_READY/);
});
