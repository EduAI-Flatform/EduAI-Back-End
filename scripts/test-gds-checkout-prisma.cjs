'use strict';
// Full-migration PostgreSQL + real service regression. Disposable CI database only.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { AuditService } = require('../dist/src/common/audit/audit.service.js');
  const { CourseAccessService } = require('../dist/src/modules/access/course-access.service.js');
  const { CommerceService } = require('../dist/src/modules/commerce/commerce.service.js');
  const { CommerceOrderService } = require('../dist/src/modules/commerce/commerce-order.service.js');
  const { CommerceProductService } = require('../dist/src/modules/commerce/commerce-product.service.js');
  const { CommerceFulfillmentService } = require('../dist/src/modules/payments/commerce-fulfillment.service.js');
  const { MembershipCheckoutService } = require('../dist/src/modules/memberships/membership-checkout.service.js');
  const { MembershipContinuityService } = require('../dist/src/modules/memberships/membership-continuity.service.js');
  const { LegacyMembershipReportService } = require('../dist/src/modules/memberships/legacy-membership-report.service.js');
  const { LegacyMembershipInventoryService } = require('../dist/src/modules/memberships/legacy-membership-inventory.service.js');
  const { LearningPathService } = require('../dist/src/modules/courses/learning-path.service.js');
  const { CourseCompletionService } = require('../dist/src/modules/courses/course-completion.service.js');
  const { UpdateLessonProgressDto } = require('../dist/src/modules/courses/dto/update-lesson-progress.dto.js');
  const { validateSync } = require('class-validator');
  const { PlatformSettingsService } = require('../dist/src/modules/platform/platform-settings.service.js');
  const { DEFAULT_PLATFORM_SETTINGS } = require('../dist/src/modules/platform/platform-settings.defaults.js');
  const { QuizzesService } = require('../dist/src/modules/quizzes/quizzes.service.js');
  const { GdsInternalCheckoutService } = require('../dist/src/modules/wallet/gds-internal-checkout.service.js');
  const { RevenueFinanceService } = require('../dist/src/modules/revenue-sharing/revenue-finance.service.js');
  const { GdsRevenueWalletService } = require('../dist/src/modules/wallet/gds-revenue-wallet.service.js');
  const { AffiliateWalletService } = require('../dist/src/modules/wallet/affiliate-wallet.service.js');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const ids = Object.fromEntries(['buyerCourse','buyerMember','seller','course','plan','version','duration'].map(k => [k,randomUUID()]));
    await db.user.createMany({data:['buyerCourse','buyerMember','seller'].map(k=>({id:ids[k],email:ids[k]+'@synthetic.invalid',fullName:'Synthetic GDS checkout'}))});
    const role=await db.role.upsert({where:{name:'student'},create:{name:'student'},update:{}});
    await db.userRole.createMany({data:['buyerCourse','buyerMember'].map(k=>({userId:ids[k],roleId:role.id}))});
    const adminRole=await db.role.upsert({where:{name:'platform_admin'},create:{name:'platform_admin'},update:{}});
    await db.userRole.create({data:{userId:ids.seller,roleId:adminRole.id}});
    await db.course.create({data:{id:ids.course,instructorId:ids.seller,title:'Synthetic GDS paid course',slug:'gds-'+ids.course,level:'beginner',status:'published',visibility:'public',priceAmountMinor:10000,priceCurrency:'VND'}});
    await db.membershipPlan.create({data:{id:ids.plan,code:'GDS_'+ids.plan.replace(/-/g,'').toUpperCase()}});
    await db.membershipPlanVersion.create({data:{id:ids.version,planId:ids.plan,versionNumber:1,displayName:'Synthetic GDS member',baseMonthlyPriceAmountMinor:20000n,currency:'VND',createdById:ids.seller}});
    await db.membershipDurationOption.create({data:{id:ids.duration,versionId:ids.version,months:1,discountPercent:0,displayOrder:0}});
    await db.membershipPlanIncludedCourse.create({data:{versionId:ids.version,courseId:ids.course,graceDays:0,createdById:ids.seller}});
    await db.membershipPlanVersion.update({where:{id:ids.version},data:{status:'published',publishedById:ids.seller,publishedAt:new Date()}});
    // Explicitly synthetic opening balances, restricted to the disposable database above.
    for(const buyerId of [ids.buyerCourse,ids.buyerMember]) await db.gdsInternalWallet.create({data:{buyerId,availableMinor:40000n}});
    const production=process.env.GDS_TEST_PRODUCTION==='true';
    if (production) {
      const runtimeRole='gds_runtime_'+randomUUID().replaceAll('-','');
      const quoted='"'+runtimeRole+'"';
      await db.$executeRawUnsafe('CREATE ROLE '+quoted+' NOLOGIN');
      await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO '+quoted);
      const { buildRuntimeGdsPrivilegeStatement }=require('./membership-runtime-privileges.cjs');
      // pg accepts one statement per prepared query; these trusted generated grants contain no values.
      for (const sql of buildRuntimeGdsPrivilegeStatement('postgresql://'+runtimeRole+'@localhost/test').split(';').filter(x=>x.trim())) await db.$executeRawUnsafe(sql);
      // This fixture exercises only zero-wallet reporting, not withdrawal writes.
      // Production grants the same SELECT via buildRuntimeGdsWithdrawalPrivilegeStatement.
      await db.$executeRawUnsafe('GRANT SELECT ON TABLE public.gds_withdrawals TO '+quoted);
      const runtime=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL,options:'-c role='+runtimeRole})});
      try {
        const probe=randomUUID();
        await db.user.create({data:{id:probe,email:probe+'@synthetic.invalid',fullName:'Runtime zero balance probe'}});
        await runtime.gdsInternalWallet.upsert({where:{buyerId:probe},create:{buyerId:probe},update:{}});
        const empty=await runtime.gdsInternalWallet.findUniqueOrThrow({where:{buyerId:probe}});
        assert.equal(empty.availableMinor,0n);
        const legacy=randomUUID();
        await db.user.create({data:{id:legacy,email:legacy+'@synthetic.invalid',fullName:'Legacy zero-wallet user'}});
        const {GdsWalletService}=require('../dist/src/modules/wallet/gds-wallet.service.js');
        const zeroConfig={app:{nodeEnv:'production',deploymentClass:'production'},gdsWallet:{sandboxEnabled:false},payos:{environment:'production'},commerce:{idempotencySecret:'synthetic-gds-checkout-ci-only-32-chars'}};
        const summary=new GdsWalletService(runtime,zeroConfig);
        const zero=await Promise.all([summary.summary(legacy),summary.summary(legacy)]);
        assert.ok(zero.every(x=>x.state==='READY_PRODUCTION'&&x.balance.availableMinor==='0'));
        assert.ok(zero.every(x=>x.paymentHeldMinor==='0'&&x.withdrawalHeldMinor==='0'&&x.totalWithdrawnMinor==='0'));
        const [withdrawalRights]=await runtime.$queryRawUnsafe(`SELECT
          has_table_privilege(current_user,'public.gds_withdrawals','SELECT') AS can_read,
          has_table_privilege(current_user,'public.gds_withdrawals','INSERT') AS can_insert,
          has_table_privilege(current_user,'public.gds_withdrawals','UPDATE') AS can_update,
          has_table_privilege(current_user,'public.gds_withdrawals','DELETE') AS can_delete`);
        assert.deepEqual(withdrawalRights,{can_read:true,can_insert:false,can_update:false,can_delete:false});
        assert.equal(await runtime.gdsInternalWallet.count({where:{buyerId:legacy}}),1);
        assert.equal(await runtime.gdsInternalJournal.count({where:{wallet:{buyerId:legacy}}}),0);
        const signedUp=randomUUID();
        await db.user.create({data:{id:signedUp,email:signedUp+'@synthetic.invalid',fullName:'Signup zero-wallet user',gdsInternalWallet:{create:{}}}});
        assert.equal((await runtime.gdsInternalWallet.findUniqueOrThrow({where:{buyerId:signedUp}})).availableMinor,0n);
        await assert.rejects(runtime.gdsInternalWallet.update({where:{id:empty.id},data:{availableMinor:9999n}}));
        console.log('GDS_RUNTIME_PRISMA_ZERO_WALLET=PASS');
      }finally{await runtime.$disconnect();}
    }
    const config=production?{app:{nodeEnv:'production',deploymentClass:'production',publicAppUrl:'https://production.example'},gdsWallet:{sandboxEnabled:false,productionTopupEnabled:false,productionCheckoutEnabled:true},payos:{environment:'production',clientId:'synthetic',apiKey:'synthetic',checksumKey:'synthetic',webhookUrl:'https://api.production.example/api/v1/payments/webhooks/payos'},commerce:{idempotencySecret:'synthetic-gds-checkout-ci-only-32-chars'}}:{app:{nodeEnv:'test',deploymentClass:'uat'},gdsWallet:{sandboxEnabled:true,checkoutEnabled:true},commerce:{idempotencySecret:'synthetic-gds-checkout-ci-only'}};
    const audit=new AuditService(db);
    const access=new CourseAccessService(db,config);
    const fulfillment=new CommerceFulfillmentService(db,access,audit,{createForUser:async()=>{}});
    const finance=new RevenueFinanceService(db);
    const revenue=new GdsRevenueWalletService(db,config,finance,new AffiliateWalletService(finance));
    const gds=new GdsInternalCheckoutService(db,config,fulfillment,audit,revenue);
    const cart=new CommerceService(db,audit,access);
    const orders=new CommerceOrderService(db,config,{},audit,access);
    const membership=new MembershipCheckoutService(db,audit,new CommerceProductService(audit),new MembershipContinuityService(db,access,audit));
    await cart.addCourse(ids.buyerCourse,ids.course);
    const courseOrder=await orders.createOrder(ids.buyerCourse,randomUUID(),{});
    const memberOrder=(await membership.createCheckout(ids.buyerMember,randomUUID(),{versionId:ids.version,durationOptionId:ids.duration,changedBenefitsConfirmed:true})).order;
    for(const [buyerId,orderId,expectedBalance,type] of [[ids.buyerCourse,courseOrder.id,30000n,'course'],[ids.buyerMember,memberOrder.id,20000n,'membership']]) {
      const receipts=await Promise.all([gds.payOrder(buyerId,orderId),gds.payOrder(buyerId,orderId)]);
      assert.ok(receipts.every(r=>r.status==='CONFIRMED'));
      const order=await db.commerceOrder.findUniqueOrThrow({where:{id:orderId},include:{confirmedSettlement:true}});
      assert.equal(order.status,'confirmed'); assert.equal(order.fulfillmentStatus,'fulfilled');
      assert.equal(order.confirmedSettlement.kind,'wallet_capture');
      assert.equal(order.confirmedSettlement.paymentAttemptId,null); assert.equal(order.confirmedSettlement.paymentEventId,null);
      const wallet=await db.gdsInternalWallet.findUniqueOrThrow({where:{buyerId}});
      assert.equal(wallet.availableMinor,expectedBalance); assert.equal(wallet.heldMinor,0n);
      assert.equal(await db.gdsInternalJournal.count({where:{orderRef:orderId}}),2);
      assert.equal(await db.commerceSettlement.count({where:{orderId}}),1);
      assert.equal(await db.commercePaymentAttempt.count({where:{orderId}}),0);
      assert.equal((await access.decide({user:{id:buyerId,roles:['student']},courseId:ids.course,operation:'FULL_LEARNING'})).allowed,true);
      if (type === 'course') {
        const lesson = await db.lesson.create({ data: { courseId: ids.course, title: 'Synthetic checkpoint lesson',
          slug: 'checkpoint-' + randomUUID(), type: 'video', orderIndex: 1, durationMinutes: 1, isRequired: true } });
        const completion = new CourseCompletionService({ issueForCompletion: async () => {
          throw new Error('Partial progress must not issue a certificate');
        } });
        const learning = new LearningPathService(db, completion, access);
        const user = { id: buyerId, roles: ['student'] };
        const grantsBefore = await db.courseAccessGrant.findMany({ where: { userId: buyerId }, orderBy: { id: 'asc' } });
        const invalid = Object.assign(new UpdateLessonProgressDto(), { watchedSeconds: 2.345678, durationSeconds: 60.123456, lastPositionSeconds: 2.345678 });
        assert.equal(validateSync(invalid).length, 3);
        for (const position of [2.35, 4.71, 2.35]) {
          const input = Object.assign(new UpdateLessonProgressDto(), { watchedSeconds: position, durationSeconds: 60.12, lastPositionSeconds: position });
          assert.equal(validateSync(input).length, 0);
          const path = await learning.updateLessonProgress(user, lesson.id, input);
          assert.equal(path.completed, false);
        }
        const reloaded = await new LearningPathService(db, completion, access).getLessonProgress(user, lesson.id);
        assert.equal(reloaded.status, 'in_progress'); assert.equal(reloaded.watchedSeconds, 5);
        assert.equal(reloaded.durationSeconds, 60); assert.equal(reloaded.lastPositionSeconds, 2);
        assert.equal(reloaded.completedAt, null);
        assert.equal(await db.learningProgress.count({ where: { userId: buyerId, lessonId: lesson.id } }), 1);
        await assert.rejects(() => learning.getLessonProgress({ id: ids.buyerMember, roles: ['student'] }, lesson.id), error => error.getStatus() === 404);
        assert.deepEqual(await db.courseAccessGrant.findMany({ where: { userId: buyerId }, orderBy: { id: 'asc' } }), grantsBefore);
        console.log('GDS_LEARNING_PROGRESS_POSTGRES_PERSISTENCE=PASS; DTO precision, checkpoints, reload, replay, ownership and unchanged purchased grants');
        const teacher = await db.user.create({ data: { email: randomUUID() + '@synthetic.invalid', fullName: 'Synthetic quiz policy teacher' } });
        const instructorRole = await db.role.upsert({ where: { name: 'instructor' }, create: { name: 'instructor' }, update: {} });
        await db.userRole.create({ data: { userId: teacher.id, roleId: instructorRole.id } });
        const draft = await db.course.create({ data: { instructorId: teacher.id, title: 'Synthetic quiz defaults draft',
          slug: 'quiz-policy-' + randomUUID(), level: 'beginner', visibility: 'private' } });
        const settings = new PlatformSettingsService(db);
        const createPolicy = async passingScore => {
          const content = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
          Object.assign(content.quizDefaults, { passingScore, maxAttempts: 2, allowInstructorOverrides: false });
          const revision = await settings.create(ids.seller, 'courses', content);
          const impact = await settings.preview(revision.id);
          assert.equal(impact.canSchedule, true); assert.equal(impact.preservesPurchasedAccess, true);
          await settings.approve(ids.seller, revision.id);
          await settings.schedule(ids.seller, revision.id, new Date());
          return revision;
        };
        await createPolicy(85);
        const quizzes = new QuizzesService(db, audit, completion, access, undefined, settings);
        const teacherUser = { id: teacher.id, roles: ['instructor'] };
        const firstQuiz = await quizzes.createQuiz(teacherUser, draft.id, { title: 'First governed quiz' });
        assert.equal(firstQuiz.passingScore, 85); assert.equal(firstQuiz.maxAttempts, 2);
        await createPolicy(90);
        const secondQuiz = await quizzes.createQuiz(teacherUser, draft.id, { title: 'Second governed quiz' });
        assert.equal(secondQuiz.passingScore, 90);
        await assert.rejects(() => quizzes.updateQuiz(teacherUser, firstQuiz.id, { passingScore: 90 }), error => error.getStatus() === 403);
        await quizzes.updateQuiz(teacherUser, firstQuiz.id, { title: 'Historical settings retained' });
        assert.equal((await db.quiz.findUniqueOrThrow({ where: { id: firstQuiz.id } })).passingScore, 85);
        assert.deepEqual(await db.courseAccessGrant.findMany({ where: { userId: buyerId }, orderBy: { id: 'asc' } }), grantsBefore);
        console.log('GDS_GOVERNED_QUIZ_DEFAULTS_POSTGRES=PASS; draft-preview-approve-effective, API lock, future-only defaults and unchanged purchased grants');
        const operationsBefore = (await settings.current()).settings.operations;
        const partnerContent = { enabled: false, items: [{ name: 'Synthetic School', logoUrl: '/gds-logo.png',
          url: 'https://example.test', category: 'school', connectionStatus: 'testing' }] };
        const partnerRevision = await settings.create(ids.seller, 'partners', partnerContent);
        assert.equal((await settings.preview(partnerRevision.id)).preservesPurchasedAccess, true);
        await settings.approve(ids.seller, partnerRevision.id);
        await settings.schedule(ids.seller, partnerRevision.id, new Date());
        const reloadedSettings = new PlatformSettingsService(db);
        assert.deepEqual((await reloadedSettings.publicSettings()).settings.partners, partnerContent);
        assert.deepEqual((await reloadedSettings.current()).settings.operations, operationsBefore);
        assert.deepEqual(await db.courseAccessGrant.findMany({ where: { userId: buyerId }, orderBy: { id: 'asc' } }), grantsBefore);
        console.log('GDS_PARTNER_CONNECTION_METADATA_POSTGRES=PASS; governed persistence, reload and unchanged intake flags and purchased grants');
      }
      if(type==='membership') {
        assert.equal(await db.membershipSubscription.count({where:{userId:buyerId,status:'active'}}),1);
        const before = await db.courseAccessGrant.findMany({where:{userId:buyerId},orderBy:{id:'asc'}});
        const report = await new LegacyMembershipReportService(db).report(orderId);
        assert.equal(report.status,'reconciled'); assert.equal(report.readOnly,true); assert.deepEqual(report.findings,[]);
        assert.deepEqual(await db.courseAccessGrant.findMany({where:{userId:buyerId},orderBy:{id:'asc'}}),before);
        console.log('GDS_LEGACY_MEMBERSHIP_RECONCILIATION=PASS; canonical capture, restricted scope, unchanged purchased grants');
        const inventory = new LegacyMembershipInventoryService(db);
        const subscription = await db.membershipSubscription.findFirstOrThrow({where:{userId:buyerId}});
        const orphanUser=randomUUID();
        await db.user.create({data:{id:orphanUser,email:orphanUser+'@synthetic.invalid',fullName:'Synthetic legacy inventory exception'}});
        const orphanSubscription=await db.membershipSubscription.create({data:{userId:orphanUser,versionId:ids.version,startsAt:subscription.startsAt,expiresAt:subscription.expiresAt}});
        const definition=await db.serviceEntitlementDefinition.create({data:{code:'LEGACY_AUDIT_'+randomUUID().replaceAll('-','').toUpperCase(),valueType:'boolean',resetPeriod:'none',displayName:'Synthetic legacy inventory',createdById:ids.seller}});
        const separateService=await db.serviceEntitlementGrant.create({data:{userId:orphanUser,definitionId:definition.id,sourceType:'ADMIN',sourceId:randomUUID(),valueType:'boolean',resetPeriod:'none',booleanValue:true,startsAt:subscription.startsAt,endsAt:subscription.expiresAt}});
        for (const [source,targetId,expectedOrder,expectedCode] of [
          ['orders',orderId,orderId,'ORDER_RECONCILIATION_REQUIRED'],
          ['subscriptions',subscription.id,orderId,'ORDER_RECONCILIATION_REQUIRED'],
          ['course_grants',before[0].id,orderId,'ORDER_RECONCILIATION_REQUIRED'],
          ['subscriptions',orphanSubscription.id,null,'SOURCE_ORDER_MISSING'],
          ['service_grants',separateService.id,null,'UNSUPPORTED_SERVICE_SOURCE'],
        ]) {
          let after; let found=false;
          for(let page=0;page<100;page++) {
            const result=await inventory.list({source,pageSize:1,after});
            assert.equal(result.readOnly,true); assert.equal(result.migrationReadiness,'not_assessed');
            if(result.items.some(item=>item.id===targetId&&item.orderId===expectedOrder&&item.code===expectedCode))found=true;
            if(!result.hasMore)break;
            assert.notEqual(result.nextCursor,after); after=result.nextCursor;
          }
          assert.equal(found,true);
        }
        assert.deepEqual(await db.courseAccessGrant.findMany({where:{userId:buyerId},orderBy:{id:'asc'}}),before);
        assert.deepEqual(await db.membershipSubscription.findUniqueOrThrow({where:{id:orphanSubscription.id}}),orphanSubscription);
        assert.deepEqual(await db.serviceEntitlementGrant.findUniqueOrThrow({where:{id:separateService.id}}),separateService);
        console.log('GDS_LEGACY_SOURCE_INVENTORY=PASS; cursor paging, independent source coverage, unchanged grants');
      }
      await gds.payOrder(buyerId,orderId);
      assert.equal((await db.gdsInternalWallet.findUniqueOrThrow({where:{buyerId}})).availableMinor,expectedBalance);
      console.log('GDS_FULL_SCHEMA_'+type.toUpperCase()+'_CHECKOUT=PASS; concurrent replay, exact debit, entitlement, no external attempt');
    }
  } finally { await db.$disconnect(); }
}
main().catch(error=>{console.error('GDS_FULL_SCHEMA_CHECKOUT=FAIL',error?.name||'Error',error?.code||'', error?.message||'', JSON.stringify(error?.meta??{}));process.exitCode=1});
