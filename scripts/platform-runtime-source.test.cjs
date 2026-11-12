const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Static source evidence for the proposed application-role permission matrix.
// This test neither generates GRANT statements nor opens a database connection.
const auditedModules = [
  'src/modules/platform/platform-settings.service.ts',
  'src/modules/platform-requests/platform-requests.service.ts',
  'src/modules/auth/mfa.service.ts',
  'src/modules/affiliate/affiliate.service.ts',
  'src/modules/wallet/affiliate-wallet.service.ts',
];
const expectedUpdates = {
  platformPolicyRevision: ['approvedAt', 'approvedById', 'effectiveAt', 'status'],
  platformSupportTicket: ['status', 'updatedAt'],
  platformSupportReply: [],
  platformPartnerApplication: ['status'],
  userMfa: ['enabled', 'enabledAt', 'lastUsedStep', 'pendingExpiresAt', 'pendingSecretEncrypted', 'recoveryCodeHashes', 'revision', 'secretEncrypted'],
  affiliateIdentity: [],
  affiliateVisit: [],
  affiliateAttribution: [],
  affiliateAccrual: [],
};

function mutationFields() {
  const updates = Object.fromEntries(Object.keys(expectedUpdates).map(model => [model, new Set()]));
  const deletes = [];
  for (const relativePath of auditedModules) {
    const source = readFileSync(join(__dirname, '..', relativePath), 'utf8');
    const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        const target = node.expression.expression;
        const model = ts.isPropertyAccessExpression(target) ? target.name.text : null;
        if (model && Object.hasOwn(expectedUpdates, model)) {
          if (['delete', 'deleteMany'].includes(operation)) deletes.push(model);
          if (['update', 'updateMany', 'upsert'].includes(operation)) {
            const argument = node.arguments[0];
            assert.ok(argument && ts.isObjectLiteralExpression(argument), relativePath + ' mutation arguments require review');
            const fieldName = operation === 'upsert' ? 'update' : 'data';
            const data = argument.properties.find(property => property.name?.getText(ast) === fieldName);
            assert.ok(data && ts.isPropertyAssignment(data) && ts.isObjectLiteralExpression(data.initializer), relativePath + ' mutation data requires review');
            for (const property of data.initializer.properties) {
              assert.ok(property.name, relativePath + ' mutation spread requires review');
              updates[model].add(property.name.getText(ast).replace(/^['"]|['"]$/g, ''));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { updates, deletes };
}

test('GDS application sources use only the audited lifecycle update fields', () => {
  const { updates, deletes } = mutationFields();
  assert.deepEqual(deletes, []);
  for (const [model, fields] of Object.entries(expectedUpdates)) {
    assert.deepEqual([...updates[model]].sort(), [...fields].sort(), model);
  }
});

test('the MFA matrix covers encrypted state and hashed recovery records without a delete path', () => {
  const schema = readFileSync(join(__dirname, '../prisma/schema/115-user-mfa.prisma'), 'utf8');
  for (const column of ['secret_encrypted', 'pending_secret_encrypted', 'pending_expires_at', 'last_used_step', 'recovery_code_hashes', 'enabled_at', 'updated_at']) {
    assert.ok(schema.includes('@map("' + column + '")'), column);
  }
  assert.ok(schema.includes('updatedAt DateTime @updatedAt'));
});
