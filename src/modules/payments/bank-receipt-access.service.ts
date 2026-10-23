import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CommerceReceiptAccessGeneration, CourseAccessSourceType, Prisma } from '../../../generated/prisma/client';
import { AuditAction, AuditService } from '../../common/audit/audit.service';
import { receiptEarlyAccessEnabled, receiptSandboxEnabled } from '../../common/security/receipt-sandbox-policy';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseAccessService } from '../access/course-access.service';
import { ensureReceiptQuotaPool } from '../memberships/receipt-quota-pool';
import { bankTransferEnabled } from './bank-transfer-policy';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const includeOrder={lines:{orderBy:{id:'asc'}},membershipCheckoutIntent:{include:{version:{include:{includedCourses:true,serviceEntitlements:true}},removedCourses:true}}} satisfies Prisma.CommerceOrderInclude;
type AccessOrder=Prisma.CommerceOrderGetPayload<{include:typeof includeOrder}>;
export interface ReceiptAccessActionInput {reason:string;expectedGeneration:number}

/** Full learning entitlement, deliberately independent of financial confirmation. */
@Injectable()
export class BankReceiptAccessService {
  constructor(private readonly prisma:PrismaService,private readonly courseAccess:CourseAccessService,
    private readonly audit:AuditService,private readonly config:AppConfigService) {}

  async grantForClaim(buyerId:string,claimId:string) {
    this.assertGrantEnabled(buyerId);
    return this.serializable(async tx=>{
      const {claim,order}=await this.load(tx,claimId,buyerId);
      const prior=await this.latest(tx,order.id);
      // A second screenshot is never permission to restore a revoked generation.
      if(prior)return this.describe(prior);
      await this.requireEligible(tx,order,claim.status,claim.expiresAt);
      const generation=await this.createGeneration(tx,order,claimId,buyerId,1,new Date());
      await this.event(tx,generation,buyerId,'GRANTED',digest('auto:'+order.id),digest(claimId),'Synthetic matched receipt access');
      await this.audit.record({actorId:buyerId,action:AuditAction.ReceiptAccessGranted,target:{type:'commerce_receipt_access_generation',id:generation.id},
        metadata:{orderId:order.id,claimId,provenance:'UNVERIFIED_RECEIPT_ACCESS',financialProof:false}},tx);
      return this.describe(generation);
    });
  }
  revoke(actorId:string,claimId:string,key:string|undefined,input:ReceiptAccessActionInput) {
    return this.change(actorId,claimId,key,input,'REVOKED');
  }
  restore(actorId:string,claimId:string,key:string|undefined,input:ReceiptAccessActionInput) {
    return this.change(actorId,claimId,key,input,'RESTORED');
  }
  async describeClaim(buyerId:string,claimId:string) {
    if(!receiptSandboxEnabled(this.config.app.nodeEnv,process.env,buyerId))throw new ServiceUnavailableException('BANK_RECEIPT_DISABLED');
    return this.serializable(async tx=>{const {order}=await this.load(tx,claimId,buyerId);return this.describe(await this.latest(tx,order.id));});
  }
  async describeClaimAdmin(actorId:string,claimId:string) {
    return this.serializable(async tx=>{await this.operator(tx,actorId);const {order}=await this.load(tx,claimId);return this.describe(await this.latest(tx,order.id));});
  }

  /** Caller holds canonical payment proof; order + buyer locks make revoke/payment races serial. */
  async convertForPaidOrder(tx:Prisma.TransactionClient,orderId:string,settlementId:string):Promise<boolean> {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id=${orderId}::uuid FOR UPDATE`);
    const order=await tx.commerceOrder.findUnique({where:{id:orderId}});
    if(!order || order.status!=='confirmed' || order.confirmedSettlementId!==settlementId)throw new ConflictException('RECEIPT_CANONICAL_PAYMENT_REQUIRED');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${order.buyerId}::uuid FOR UPDATE`);
    const generation=await this.latest(tx,orderId);
    if(!generation)return false;
    if(generation.status==='VERIFIED_PAID') {
      if(generation.settlementId!==settlementId)throw new ConflictException('RECEIPT_CANONICAL_PAYMENT_REQUIRED');
      return true;
    }
    const settlement=await tx.commerceSettlement.findFirst({where:{id:settlementId,orderId,kind:'provider_collection',disposition:'matched',amountMinor:order.payableAmountMinor,currency:order.currency},select:{id:true}});
    if(!settlement)throw new ConflictException('RECEIPT_CANONICAL_PAYMENT_REQUIRED');
    await this.retireEffects(tx,generation,'RECEIPT_CONVERTED_TO_VERIFIED_PAID');
    const verified=await tx.commerceReceiptAccessGeneration.update({where:{id:generation.id},data:{status:'VERIFIED_PAID',closedAt:new Date(),settlementId}});
    await this.event(tx,verified,order.buyerId,'VERIFIED_PAID',digest('verified:'+orderId+':'+settlementId),digest(settlementId),'Canonical payment converted access');
    await this.audit.record({actorKind:'SYSTEM',action:AuditAction.ReceiptAccessVerified,target:{type:'commerce_receipt_access_generation',id:generation.id},metadata:{orderId,settlementId}},tx);
    return true;
  }

  private async change(actorId:string,claimId:string,key:string|undefined,input:ReceiptAccessActionInput,action:'REVOKED'|'RESTORED') {
    if(!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new ConflictException('INVALID_IDEMPOTENCY_KEY');
    if(typeof input.reason!=='string' || input.reason.trim().length<8 || input.reason.length>300 || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration<1)throw new ConflictException('INVALID_RECEIPT_ACCESS_ACTION');
    const operationKeyHash=digest(key);const requestHash=digest(JSON.stringify({claimId,action,reason:input.reason,expectedGeneration:input.expectedGeneration}));
    return this.serializable(async tx=>{
      await this.operator(tx,actorId);
      const {claim,order}=await this.load(tx,claimId);
      const previous=await tx.commerceReceiptAccessEvent.findUnique({where:{actorId_operationKeyHash:{actorId,operationKeyHash}}});
      if(previous) {
        if(previous.requestHash!==requestHash)throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        return this.describe(await tx.commerceReceiptAccessGeneration.findUnique({where:{id:previous.generationId}}));
      }
      if(order.status==='confirmed' || order.confirmedSettlementId)throw new ConflictException('ORDER_ALREADY_VERIFIED');
      const generation=await this.latest(tx,order.id);
      if(!generation || generation.generation!==input.expectedGeneration || generation.status!==(action==='REVOKED'?'ACCESS_UNVERIFIED':'REVOKED'))throw new ConflictException('RECEIPT_ACCESS_STATE_CHANGED');
      let changed:CommerceReceiptAccessGeneration;
      if(action==='REVOKED') {
        await this.retireEffects(tx,generation,'RECEIPT_ADMIN_REVOKED');
        changed=await tx.commerceReceiptAccessGeneration.update({where:{id:generation.id},data:{status:'REVOKED',closedAt:new Date()}});
      } else {
        this.assertGrantEnabled(order.buyerId);
        await this.requireEligible(tx,order,claim.status,claim.expiresAt);
        changed=await this.createGeneration(tx,order,claimId,actorId,generation.generation+1,generation.accessStartsAt);
      }
      await this.event(tx,changed,actorId,action,operationKeyHash,requestHash,input.reason.trim());
      await this.audit.record({actorId,action:action==='REVOKED'?AuditAction.ReceiptAccessRevoked:AuditAction.ReceiptAccessRestored,
        target:{type:'commerce_receipt_access_generation',id:changed.id},metadata:{orderId:order.id,generation:changed.generation,reasonDigest:digest(input.reason.trim())}},tx);
      return this.describe(changed);
    });
  }

  private async createGeneration(tx:Prisma.TransactionClient,order:AccessOrder,claimId:string,createdById:string,generation:number,accessStartsAt:Date) {
    const result=await tx.commerceReceiptAccessGeneration.create({data:{id:randomUUID(),orderId:order.id,buyerId:order.buyerId,claimId,createdById,generation,accessStartsAt}});
    for(const line of order.lines) {
      const sourceId=result.id+':'+line.id;
      if(line.productType==='course') {
        const grant=await this.courseAccess.ensureGrant({userId:order.buyerId,courseId:line.productReferenceId,sourceType:CourseAccessSourceType.unverified_receipt_access,sourceId,startsAt:accessStartsAt,endsAt:null},tx);
        if(!grant)throw new ConflictException('RECEIPT_ACCESS_RESOURCE_MISSING');
        await this.effect(tx,result.id,line.id,'COURSE_ACCESS','course_access_grant',grant.id);
        continue;
      }
      const intent=order.membershipCheckoutIntent!;
      const overlap=await tx.membershipSubscription.findFirst({where:{userId:order.buyerId,status:'active',startsAt:{lt:intent.endsAt},expiresAt:{gt:intent.startsAt}},select:{id:true}});
      if(overlap)throw new ConflictException('MEMBERSHIP_TERM_OVERLAP');
      const subscription=await tx.membershipSubscription.create({data:{userId:order.buyerId,versionId:intent.versionId,sourceOrderLineId:null,startsAt:intent.startsAt,expiresAt:intent.endsAt}});
      await this.effect(tx,result.id,line.id,'MEMBERSHIP_TERM','membership_subscription',subscription.id);
      for(const included of intent.version.includedCourses) {
        const grant=await this.courseAccess.ensureGrant({userId:order.buyerId,courseId:included.courseId,sourceType:CourseAccessSourceType.unverified_receipt_access,sourceId,startsAt:intent.startsAt,endsAt:intent.endsAt},tx);
        if(!grant)throw new ConflictException('RECEIPT_ACCESS_RESOURCE_MISSING');
        await this.effect(tx,result.id,line.id,'MEMBERSHIP_COURSE','course_access_grant',grant.id);
      }
      for(const removed of intent.removedCourses) {
        if(!removed.graceStartsAt || !removed.graceEndsAt)continue;
        const grant=await this.courseAccess.ensureGrant({userId:order.buyerId,courseId:removed.courseId,sourceType:CourseAccessSourceType.unverified_receipt_access,sourceId:sourceId+':grace',startsAt:removed.graceStartsAt,endsAt:removed.graceEndsAt},tx);
        if(!grant)throw new ConflictException('RECEIPT_ACCESS_RESOURCE_MISSING');
        await this.effect(tx,result.id,line.id,'MEMBERSHIP_GRACE','course_access_grant',grant.id);
      }
      for(const entitlement of intent.version.serviceEntitlements) {
        const pool=await ensureReceiptQuotaPool(tx,{orderLineId:line.id,userId:order.buyerId,definitionId:entitlement.definitionId,valueType:entitlement.valueType,resetPeriod:entitlement.resetPeriod,booleanValue:entitlement.booleanValue,quota:entitlement.quota,startsAt:intent.startsAt,endsAt:intent.endsAt});
        const grant=await tx.serviceEntitlementGrant.create({data:{userId:order.buyerId,definitionId:entitlement.definitionId,sourceType:'UNVERIFIED_RECEIPT_ACCESS',sourceId,
          valueType:entitlement.valueType,resetPeriod:entitlement.resetPeriod,booleanValue:entitlement.booleanValue,quota:entitlement.quota,quotaPoolId:pool.id,startsAt:intent.startsAt,endsAt:intent.endsAt}});
        await this.effect(tx,result.id,line.id,'MEMBERSHIP_SERVICE','service_entitlement_grant',grant.id);
      }
    }
    return result;
  }
  private async retireEffects(tx:Prisma.TransactionClient,generation:CommerceReceiptAccessGeneration,reason:string) {
    const effects=await tx.commerceReceiptAccessEffect.findMany({where:{generationId:generation.id},orderBy:{id:'asc'}});
    for(const effect of effects) {
      if(effect.resourceType==='course_access_grant') {
        const grant=await tx.courseAccessGrant.findUnique({where:{id:effect.resourceId}});
        if(!grant || grant.userId!==generation.buyerId || grant.sourceType!==CourseAccessSourceType.unverified_receipt_access || !grant.sourceId.startsWith(generation.id+':'))throw new ConflictException('RECEIPT_ACCESS_PROVENANCE_MISMATCH');
        await this.courseAccess.revokeGrant({userId:grant.userId,courseId:grant.courseId,sourceType:grant.sourceType,sourceId:grant.sourceId},reason,tx);
      } else if(effect.resourceType==='membership_subscription') {
        await tx.membershipSubscription.updateMany({where:{id:effect.resourceId,userId:generation.buyerId,sourceOrderLineId:null,status:'active'},data:{status:'cancelled'}});
      } else if(effect.resourceType==='service_entitlement_grant') {
        await tx.serviceEntitlementGrant.updateMany({where:{id:effect.resourceId,userId:generation.buyerId,sourceType:'UNVERIFIED_RECEIPT_ACCESS',sourceId:generation.id+':'+effect.orderLineId,status:'active'},data:{status:'revoked',revokedAt:new Date()}});
      }
    }
  }
  private async requireEligible(tx:Prisma.TransactionClient,order:AccessOrder,claimStatus:string,claimExpiresAt:Date) {
    this.assertGrantEnabled(order.buyerId);
    const now=new Date();const request=await tx.commerceBankTransferRequest.findUnique({where:{orderId:order.id}});
    if(claimStatus!=='MATCHED_CLAIM' || claimExpiresAt<=now || order.status!=='pending_payment' || order.confirmedSettlementId || !request || !['PENDING','UNDER_REVIEW','NEEDS_SUPPORT'].includes(request.status) || request.expiresAt<=now)throw new ConflictException('RECEIPT_ACCESS_NOT_ELIGIBLE');
    const sellers=(process.env.BANK_RECEIPT_SYNTHETIC_SELLER_IDS??'').split(',').map(id=>id.trim()).filter(Boolean);
    if(order.currency!=='VND' || order.payableAmountMinor<=0n || order.lines.length===0 || order.lines.some(line=>!sellers.includes(line.sellerId) || !['course','membership'].includes(line.productType))
      || (order.lines.some(line=>line.productType==='membership') && (order.lines.length!==1 || !order.membershipCheckoutIntent || order.membershipCheckoutIntent.versionId!==order.lines[0].productReferenceId)))throw new ConflictException('RECEIPT_ACCESS_SCOPE_UNSUPPORTED');
  }
  private async load(tx:Prisma.TransactionClient,claimId:string,buyerId?:string) {
    const claim=await tx.commerceBankReceiptClaim.findUnique({where:{id:claimId}});
    if(!claim || (buyerId && claim.buyerId!==buyerId))throw new NotFoundException('RECEIPT_NOT_FOUND');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id=${claim.orderId}::uuid FOR UPDATE`);
    const order=await tx.commerceOrder.findUnique({where:{id:claim.orderId},include:includeOrder});
    if(!order || order.buyerId!==claim.buyerId)throw new NotFoundException('RECEIPT_NOT_FOUND');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${order.buyerId}::uuid FOR UPDATE`);
    const buyer=await tx.user.findFirst({where:{id:order.buyerId,status:'active',deletedAt:null},select:{id:true}});
    if(!buyer)throw new NotFoundException('RECEIPT_NOT_FOUND');
    return {claim,order};
  }
  private latest(tx:Prisma.TransactionClient,orderId:string) {
    return tx.commerceReceiptAccessGeneration.findFirst({where:{orderId},orderBy:{generation:'desc'}});
  }
  private effect(tx:Prisma.TransactionClient,generationId:string,orderLineId:string,effectKind:string,resourceType:string,resourceId:string) {
    return tx.commerceReceiptAccessEffect.create({data:{id:randomUUID(),generationId,orderLineId,effectKind,resourceType,resourceId}});
  }
  private event(tx:Prisma.TransactionClient,generation:CommerceReceiptAccessGeneration,actorId:string,action:string,operationKeyHash:string,requestHash:string,reason:string) {
    return tx.commerceReceiptAccessEvent.create({data:{id:randomUUID(),generationId:generation.id,actorId,action,operationKeyHash,requestHash,reason,reasonDigest:digest(reason)}});
  }
  private describe(generation:CommerceReceiptAccessGeneration|null) {
    return {state:generation?.status??'NONE',generation:generation?.generation??0,generationId:generation?.id??null,source:'UNVERIFIED_RECEIPT_ACCESS',financialProof:false,
      accessEnabled:generation?.status==='ACCESS_UNVERIFIED' && receiptEarlyAccessEnabled(this.config.app.nodeEnv,process.env,generation.buyerId)};
  }
  private assertGrantEnabled(buyerId:string) {
    if(!receiptEarlyAccessEnabled(this.config.app.nodeEnv,process.env,buyerId))throw new ServiceUnavailableException('RECEIPT_EARLY_ACCESS_DISABLED');
  }
  private async operator(tx:Prisma.TransactionClient,actorId:string) {
    if(!bankTransferEnabled(this.config.app.nodeEnv,process.env.BANK_TRANSFER_SANDBOX_ENABLED) || process.env.BANK_RECEIPT_SANDBOX_ENABLED!=='true')throw new ServiceUnavailableException('BANK_RECEIPT_DISABLED');
    const allowed=(process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS??'').split(',').map(id=>id.trim());
    const admin=allowed.includes(actorId)?await tx.user.findFirst({where:{id:actorId,status:'active',deletedAt:null,roles:{some:{role:{name:'platform_admin'}}}},select:{id:true}}):null;
    if(!admin)throw new ForbiddenException('RECEIPT_OPERATOR_REQUIRED');
  }
  private async serializable<T>(operation:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
    for(let attempt=0;attempt<3;attempt++) {
      try{return await this.prisma.$transaction(operation,{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
      catch(error) {
        const cause=error instanceof Error?(error as Error&{cause?:{kind?:unknown}}).cause:undefined;
        const retry=(error instanceof Prisma.PrismaClientKnownRequestError && ['P2034','P2002'].includes(error.code)) || (error instanceof Error && error.name==='DriverAdapterError' && cause?.kind==='TransactionWriteConflict');
        if(!retry)throw error;
        if(attempt===2)throw new ConflictException('RECEIPT_ACCESS_CONCURRENT_OPERATION');
      }
    }
    throw new ConflictException('RECEIPT_ACCESS_CONCURRENT_OPERATION');
  }
}
