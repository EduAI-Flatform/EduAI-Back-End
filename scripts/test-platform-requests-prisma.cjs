'use strict';
// Disposable localhost CI only; no .env loading or external services.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { PlatformSettingsService } = require('../dist/src/modules/platform/platform-settings.service.js');
  const { PlatformRequestsService } = require('../dist/src/modules/platform-requests/platform-requests.service.js');
  const { DEFAULT_PLATFORM_SETTINGS } = require('../dist/src/modules/platform/platform-settings.defaults.js');
  const sharp = require('sharp');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const role = 'request_' + randomUUID().replaceAll('-', '');
  let runtime;
  try {
    const [admin, owner, other] = await Promise.all(['operator', 'owner', 'other'].map(label => db.user.create({
      data: { email: `${randomUUID()}@synthetic.invalid`, fullName: `Synthetic request ${label}` },
    })));
    let version = (await db.platformPolicyRevision.aggregate({ where: { group: 'operations' }, _max: { version: true } }))._max.version ?? 0;
    const policy = enabled => db.platformPolicyRevision.create({ data: { group: 'operations', version: ++version,
      status: 'scheduled', createdById: admin.id, approvedById: admin.id, approvedAt: new Date(), effectiveAt: new Date(),
      content: { ...DEFAULT_PLATFORM_SETTINGS.operations, supportEnabled: enabled, invoiceRequestsEnabled: enabled,
        partnerApplicationsEnabled: enabled, maxAttachmentMb: 1 },
    } });
    await policy(false);
    await db.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT ON users,platform_policy_revisions,commerce_orders,commerce_settlements,
      platform_support_tickets,platform_support_replies,platform_partner_applications,audit_logs TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT INSERT ON platform_support_tickets,platform_support_replies,platform_partner_applications,audit_logs TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT UPDATE(status,updated_at) ON platform_support_tickets,platform_partner_applications TO "${role}"`);
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` }) });
    const [identity] = await runtime.$queryRaw`SELECT current_user AS name,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
      has_table_privilege(current_user, 'commerce_orders', 'UPDATE') AS can_update_orders,
      has_table_privilege(current_user, 'platform_policy_revisions', 'INSERT') AS can_create_policies`;
    assert.deepEqual(identity, { name: role, superuser: false, can_update_orders: false, can_create_policies: false });
    const requests = new PlatformRequestsService(runtime, new PlatformSettingsService(runtime));
    const input = { title: 'Synthetic private support', content: 'Synthetic private body. '.repeat(20) };
    await assert.rejects(() => requests.createSupport(owner.id, input), error => error.getStatus() === 503);
    assert.equal(await db.platformSupportTicket.count({ where: { ownerId: owner.id } }), 0);
    const active = await policy(true);
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00A89F' } }).png().toBuffer();
    const ticket = await requests.createSupport(owner.id, input, { buffer: image, size: image.length, mimetype: 'image/png' });
    assert.equal(ticket.ownerId, owner.id); assert.ok(ticket.attachmentSize > 0); assert.ok(!('attachmentData' in ticket));
    const normalized = await requests.getSupportImage(owner.id, ticket.id);
    assert.equal((await sharp(normalized).metadata()).format, 'png');
    assert.deepEqual(await requests.getSupportImage(undefined, ticket.id), normalized);
    await assert.rejects(() => requests.getSupportImage(other.id, ticket.id), error => error.getStatus() === 404);
    await assert.rejects(() => requests.getSupport(other.id, ticket.id, { page: 1, pageSize: 20 }), error => error.getStatus() === 404);
    await assert.rejects(() => requests.reply(other.id, ticket.id, 'Not owned', false), error => error.getStatus() === 404);
    assert.equal((await requests.listSupport(other.id, { page: 1, pageSize: 20 })).total, 0);
    const listing = await requests.listSupport(owner.id, { page: 1, pageSize: 20 });
    assert.equal(listing.total, 1); assert.equal(listing.items[0].content.length, 200);
    assert.ok(!('attachmentData' in listing.items[0]));
    await requests.reply(owner.id, ticket.id, 'Synthetic owner follow-up', false);
    await requests.updateSupport(admin.id, ticket.id, { status: 'in_progress' });
    await requests.reply(admin.id, ticket.id, 'Synthetic staff reply', true);
    const detail = await requests.getSupport(owner.id, ticket.id, { page: 1, pageSize: 1 });
    assert.equal(detail.status, 'in_progress'); assert.equal(detail.replyTotal, 2); assert.equal(detail.replies.length, 1);
    await requests.updateSupport(admin.id, ticket.id, { status: 'closed' });
    await assert.rejects(() => requests.reply(owner.id, ticket.id, 'Closed reply', false), error => error.getStatus() === 409);
    const ticketCount = await db.platformSupportTicket.count({ where: { ownerId: owner.id } });
    await assert.rejects(() => requests.createSupport(owner.id, input, { buffer: Buffer.from('invalid'), size: 7, mimetype: 'image/png' }), error => error.getStatus() === 400);
    await assert.rejects(() => requests.createSupport(owner.id, input, { buffer: Buffer.alloc(1024 * 1024 + 1), size: 1024 * 1024 + 1, mimetype: 'image/png' }), error => error.getStatus() === 400);
    assert.equal(await db.platformSupportTicket.count({ where: { ownerId: owner.id } }), ticketCount);
    const partner = await requests.createPartner({ category: 'school', name: 'Synthetic partner', organization: 'Synthetic school',
      phone: '0900000000', email: 'SYNTHETIC@EXAMPLE.TEST', content: 'Synthetic connection request only', consent: true });
    const storedPartner = await db.platformPartnerApplication.findUniqueOrThrow({ where: { id: partner.id } });
    assert.equal(storedPartner.policyId, active.id); assert.equal(storedPartner.email, 'synthetic@example.test'); assert.ok(storedPartner.consentAt);
    await requests.updatePartner(admin.id, partner.id, { status: 'reviewing' });
    const audits = await db.auditLog.findMany({ where: { targetId: { in: [ticket.id, partner.id] } }, select: { metadataJson: true } });
    assert.ok(audits.length >= 6); assert.ok(!JSON.stringify(audits).includes('private body')); assert.ok(!JSON.stringify(audits).includes('synthetic@example.test'));
    // Reuse a canonical settlement from the earlier checkout replay; do not fabricate PAID.
    const order = await db.commerceOrder.findFirstOrThrow({ where: { status: 'confirmed',
      buyer: { email: { endsWith: '@synthetic.invalid' } }, confirmedSettlement: { isNot: null } },
      include: { confirmedSettlement: true } });
    const invoiceInput = { orderId: order.id, recipientName: 'Synthetic invoice recipient', taxCode: '0000000000',
      billingAddress: 'Synthetic billing address', invoiceEmail: 'invoice@synthetic.invalid' };
    await assert.rejects(() => requests.createInvoice(other.id, invoiceInput), error => error.getStatus() === 404);
    const invoice = await requests.createInvoice(order.buyerId, invoiceInput);
    assert.equal(invoice.requestType, 'invoice'); assert.equal(invoice.orderId, order.id);
    assert.equal((await requests.createInvoice(order.buyerId, invoiceInput)).id, invoice.id);
    assert.equal(await db.platformSupportTicket.count({ where: { orderId: order.id } }), 1);
    await requests.updateSupport(admin.id, invoice.id, { status: 'in_progress' });
    await requests.reply(admin.id, invoice.id, 'Synthetic invoice request received', true);
    const invoiceDetail = await requests.getSupport(order.buyerId, invoice.id, { page: 1, pageSize: 20 });
    assert.equal(invoiceDetail.status, 'in_progress'); assert.equal(invoiceDetail.replyTotal, 1);
    assert.deepEqual(await db.commerceOrder.findUniqueOrThrow({ where: { id: order.id }, include: { confirmedSettlement: true } }), order);
    await policy(false);
    await assert.rejects(() => requests.reply(owner.id, ticket.id, 'Disabled intake', false), error => error.getStatus() === 503);
    assert.equal((await requests.getSupport(owner.id, ticket.id, { page: 1, pageSize: 20 })).replyTotal, 2);
    await assert.rejects(() => requests.createInvoice(order.buyerId, invoiceInput), error => error.getStatus() === 503);
    console.log('PLATFORM_REQUESTS_RESTRICTED_PRISMA_INTAKE_IMAGE_OWNERSHIP_REPLY_ADMIN_AND_POLICY=PASS');
  } finally {
    await runtime?.$disconnect();
    await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`).catch(() => {});
    await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    await db.$disconnect();
  }
}
main().catch(error => { console.error('PLATFORM_REQUESTS_PRISMA=FAIL', error?.name || 'Error'); process.exitCode = 1; });
