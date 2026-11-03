/** Creates exactly one named UAT catalog fixture. Dry-run by default. No payment writes. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SLUG = 'kiem-thu-thanh-toan-10000-uat';
const TITLE = 'Kiểm thử thanh toán EduAI - 10.000đ (UAT)';
const SOURCE_COURSE_ID = '00000020-0000-4000-8000-000000000001';
function assertUat(env, fingerprint) {
  if (!['development', 'test'].includes(env.NODE_ENV) || env.DEPLOYMENT_CLASS === 'production' || !env.DATABASE_URL || !/^[a-f0-9]{12}$/.test(fingerprint || '')) throw new Error('EXPLICIT_UAT_SCOPE_REQUIRED');
  const url = new URL(env.DATABASE_URL);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || createHash('sha256').update(url.hostname + url.pathname).digest('hex').slice(0, 12) !== fingerprint) throw new Error('UAT_DATABASE_MISMATCH');
}
function assertFixture(course, ownerId) {
  if (course && (course.title !== TITLE || course.instructorId !== ownerId || course.priceAmountMinor !== 10000 || course.priceCurrency !== 'VND' || course.visibility !== 'public' || course.moderationStatus !== 'clear' || course.deletedAt || !['draft', 'published'].includes(course.status))) throw new Error('EXISTING_COURSE_CONFLICT');
}
function assertContents(course, ownerId) {
  if (!course) return;
  if (course.lessons.length > 1 || course.lessons.some(lesson => lesson.slug !== 'xac-minh-quyen-hoc' || lesson.type !== 'article' || lesson.isPreview || lesson.orderIndex !== 0 || lesson.deletedAt)) throw new Error('FIXTURE_LESSON_CONFLICT');
  const product = course.commerceProduct;
  if (product && (product.type !== 'course' || product.sellerId !== ownerId || product.status === 'archived')) throw new Error('FIXTURE_PRODUCT_CONFLICT');
  if (course.status === 'published' && course.lessons.length !== 1) throw new Error('PUBLISHED_FIXTURE_LESSON_MISSING');
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--uat') || args.some((arg, i) => !['--uat','--apply','--expected-db-fingerprint'].includes(arg) && args[i-1] !== '--expected-db-fingerprint')) throw new Error('EXPLICIT_UAT_SCOPE_REQUIRED');
  const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env')));
  assertUat(env, args[args.indexOf('--expected-db-fingerprint')+1]);
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  try {
    const source = await db.course.findUnique({ where: { id: SOURCE_COURSE_ID }, include: { instructor: { include: { roles: { include: { role: true } } } } } });
    const teacher = source?.instructor;
    if (!teacher || teacher.status !== 'active' || teacher.deletedAt || !teacher.roles.some(r => r.role.name === 'instructor')) throw new Error('DEMO_INSTRUCTOR_REQUIRED');
    const admin = await db.user.findFirst({ where: { status: 'active', deletedAt: null, roles: { some: { role: { name: 'platform_admin' } } } }, select: { id: true } });
    if (!admin) throw new Error('EXISTING_ADMIN_REQUIRED');
    let course = await db.course.findUnique({ where: { slug: SLUG }, include: { lessons: true, commerceProduct: true } });
    assertFixture(course, teacher.id);
    assertContents(course, teacher.id);
    if (!args.includes('--apply')) { console.log(JSON.stringify({ mode: 'dry-run', action: course ? 'verify-or-resume' : 'create', slug: SLUG, amountMinor: 10000, currency: 'VND' })); return; }
    const { AuditService } = require('../dist/src/common/audit/audit.service');
    const { CoursesService } = require('../dist/src/modules/courses/courses.service');
    const { LessonsService } = require('../dist/src/modules/lessons/lessons.service');
    const { CommerceAdminService } = require('../dist/src/modules/commerce/commerce-admin.service');
    const audit = new AuditService(db);
    const courses = new CoursesService(db, undefined, audit, undefined, undefined);
    const lessons = new LessonsService(db, undefined);
    const commerce = new CommerceAdminService(db, courses, audit);
    const actor = { id: teacher.id, roles: teacher.roles.map(r => r.role.name) };
    let changed = false;
    if (!course) {
      const created = await courses.createCourse(actor, { title: TITLE, slug: SLUG, description: 'Khóa học mẫu chỉ dùng kiểm thử luồng mua khóa học và thanh toán trên dev/UAT. Giá 10.000 VND. PayOS có thể thu tiền thật; không cần chuyển tiền để xem thông tin khóa học.', thumbnailUrl: '/demo-assets/course-placeholder.svg', badge: 'UAT', level: 'beginner', visibility: 'public', priceAmountMinor: 10000, priceCurrency: 'VND' });
      course = await db.course.findUniqueOrThrow({ where: { id: created.id } });
      changed = true;
    }
    const lesson = await db.lesson.findUnique({ where: { courseId_slug: { courseId: course.id, slug: 'xac-minh-quyen-hoc' } } });
    if (!lesson) {
      if (course.status !== 'draft') throw new Error('PUBLISHED_FIXTURE_LESSON_MISSING');
      await lessons.createLesson(actor, course.id, { title: 'Xác minh quyền học sau thanh toán', slug: 'xac-minh-quyen-hoc', type: 'article', orderIndex: 0, durationMinutes: 2, isPreview: false, isRequired: true, content: 'Bài học mẫu UAT. Khi giao dịch đã được hệ thống xác minh và đơn hàng hoàn tất, bạn có thể mở nội dung này. Việc mở trang trả về hoặc quét QR không thay thế kết quả đối soát. Khóa này chỉ phục vụ kiểm thử.' });
      changed = true;
    } else if (lesson.deletedAt || lesson.type !== 'article' || lesson.isPreview || lesson.orderIndex !== 0) throw new Error('FIXTURE_LESSON_CONFLICT');
    if (course.status === 'draft') { await courses.publishCourse(actor, course.id); changed = true; }
    course = await db.course.findUniqueOrThrow({ where: { id: course.id } });
    const product = await db.commerceProduct.findUnique({ where: { courseId: course.id } });
    if (!product || product.status !== 'active') {
      await commerce.updateCatalog(admin.id, course.id, { expectedCourseUpdatedAt: course.updatedAt.toISOString(), priceAmountMinor: 10000, priceCurrency: 'VND', sellable: true });
      changed = true;
    }
    const verified = await db.course.findUniqueOrThrow({ where: { id: course.id }, include: { commerceProduct: true, _count: { select: { lessons: true } } } });
    assertFixture(verified, teacher.id);
    if (verified.status !== 'published' || verified.commerceProduct?.status !== 'active' || verified.commerceProduct.type !== 'course' || verified.commerceProduct.sellerId !== teacher.id || verified._count.lessons !== 1) throw new Error('FIXTURE_VERIFICATION_FAILED');
    console.log(JSON.stringify({ mode: 'apply', changed, courseId: course.id, slug: SLUG, amountMinor: 10000, currency: 'VND', published: true, sellable: true, lessons: 1 }));
  } finally { await db.$disconnect(); }
}
module.exports = { assertUat, assertFixture, assertContents };
if (require.main === module) main().catch(() => { console.error('UAT_COURSE_SETUP_FAILED'); process.exitCode = 1; });
