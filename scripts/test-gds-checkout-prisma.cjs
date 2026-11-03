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
  const { GdsInternalCheckoutService } = require('../dist/src/modules/wallet/gds-internal-checkout.service.js');
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
    const gds=new GdsInternalCheckoutService(db,config,fulfillment,audit);
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
      if(type==='membership') assert.equal(await db.membershipSubscription.count({where:{userId:buyerId,status:'active'}}),1);
      await gds.payOrder(buyerId,orderId);
      assert.equal((await db.gdsInternalWallet.findUniqueOrThrow({where:{buyerId}})).availableMinor,expectedBalance);
      console.log('GDS_FULL_SCHEMA_'+type.toUpperCase()+'_CHECKOUT=PASS; concurrent replay, exact debit, entitlement, no external attempt');
    }
  } finally { await db.$disconnect(); }
}
main().catch(error=>{console.error('GDS_FULL_SCHEMA_CHECKOUT=FAIL',error?.name||'Error',error?.code||'', error?.message||'', JSON.stringify(error?.meta??{}));process.exitCode=1});
