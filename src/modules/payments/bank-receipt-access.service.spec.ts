import { BankReceiptAccessService } from './bank-receipt-access.service';

describe('Full synthetic receipt access provenance',()=>{
  const buyer='11111111-1111-4111-8111-111111111111';const seller='22222222-2222-4222-8222-222222222222';const admin='33333333-3333-4333-8333-333333333333';
  const saved={...process.env};
  beforeEach(()=>{
    process.env.BANK_TRANSFER_SANDBOX_ENABLED='true';process.env.BANK_RECEIPT_SANDBOX_ENABLED='true';process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED='true';
    process.env.BANK_RECEIPT_SYNTHETIC_BUYER_IDS=buyer;process.env.BANK_RECEIPT_SYNTHETIC_SELLER_IDS=seller;process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS=admin;
  });
  afterAll(()=>{process.env=saved;});
  const harness=()=>{
    const now=new Date(); const generations:any[]=[];const effects:any[]=[];const events:any[]=[];const grants:any[]=[];
    const order:any={id:'order',buyerId:buyer,status:'pending_payment',confirmedSettlementId:null,currency:'VND',payableAmountMinor:1000n,
      lines:[{id:'line',productType:'course',productReferenceId:'course',sellerId:seller}],membershipCheckoutIntent:null};
    const claim={id:'claim',buyerId:buyer,orderId:'order',status:'MATCHED_CLAIM',expiresAt:new Date(now.getTime()+86400000)};
    const request={status:'PENDING',expiresAt:new Date(now.getTime()+900000)};
    const tx:any={$queryRaw:jest.fn().mockResolvedValue([]),
      commerceBankReceiptClaim:{findUnique:jest.fn().mockResolvedValue(claim)},commerceOrder:{findUnique:jest.fn().mockResolvedValue(order)},
      commerceBankTransferRequest:{findUnique:jest.fn().mockResolvedValue(request)},user:{findFirst:jest.fn().mockResolvedValue({id:buyer})},
      commerceReceiptAccessGeneration:{findFirst:jest.fn().mockImplementation(async()=>generations.at(-1)??null),findMany:jest.fn().mockImplementation(async()=>generations),
        create:jest.fn().mockImplementation(async({data}:any)=>{const row={status:'ACCESS_UNVERIFIED',createdAt:new Date(),closedAt:null,settlementId:null,...data};generations.push(row);return row;}),
        findUnique:jest.fn().mockImplementation(async({where}:any)=>generations.find(g=>g.id===where.id)??null),
        update:jest.fn().mockImplementation(async({where,data}:any)=>Object.assign(generations.find(g=>g.id===where.id),data))},
      commerceReceiptAccessEffect:{create:jest.fn().mockImplementation(async({data}:any)=>{effects.push(data);return data;}),findMany:jest.fn().mockImplementation(async({where}:any)=>effects.filter(e=>e.generationId===where.generationId))},
      commerceReceiptAccessEvent:{findUnique:jest.fn().mockImplementation(async({where}:any)=>events.find(e=>e.actorId===where.actorId_operationKeyHash.actorId&&e.operationKeyHash===where.actorId_operationKeyHash.operationKeyHash)??null),
        create:jest.fn().mockImplementation(async({data}:any)=>{events.push(data);return data;})},
      courseAccessGrant:{findUnique:jest.fn().mockImplementation(async({where}:any)=>grants.find(g=>g.id===where.id))},
      membershipSubscription:{findFirst:jest.fn().mockResolvedValue(null),create:jest.fn(),updateMany:jest.fn()},serviceEntitlementGrant:{updateMany:jest.fn()},
      commerceSettlement:{findFirst:jest.fn().mockResolvedValue({id:'settlement'})},
    };
    tx.$transaction=jest.fn(async fn=>fn(tx));
    const access={ensureGrant:jest.fn().mockImplementation(async(input:any)=>{const g={id:'grant-'+grants.length,status:'active',...input};grants.push(g);return g;}),
      revokeGrant:jest.fn().mockImplementation(async(identity:any)=>{const g=grants.find(g=>g.sourceId===identity.sourceId&&g.courseId===identity.courseId);if(g)g.status='revoked';return g;})};
    const audit={record:jest.fn()};const config={app:{nodeEnv:'test'}};
    return {service:new BankReceiptAccessService(tx,access as any,audit as any,config as any),tx,access,audit,config,order,claim,request,generations,effects,events,grants};
  };
  it('requires every feature flag and synthetic buyer before DB access',async()=>{
    const h=harness();delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
    await expect(h.service.grantForClaim(buyer,'claim')).rejects.toThrow('RECEIPT_EARLY_ACCESS_DISABLED');expect(h.tx.$transaction).not.toHaveBeenCalled();
  });
  it('grants actual course learning through a separate auditable source only once',async()=>{
    const h=harness();const first=await h.service.grantForClaim(buyer,'claim');const second=await h.service.grantForClaim(buyer,'claim');
    expect(first.state).toBe('ACCESS_UNVERIFIED');expect(second.generation).toBe(1);expect(h.access.ensureGrant).toHaveBeenCalledTimes(1);
    expect(h.grants[0].sourceType).toBe('unverified_receipt_access');expect(h.effects[0].effectKind).toBe('COURSE_ACCESS');
    expect(h.order.status).toBe('pending_payment');expect(h.order.confirmedSettlementId).toBeNull();
  });
  it('fails closed for sellers outside the explicit synthetic allowlist',async()=>{
    const h=harness();h.order.lines[0].sellerId='different';await expect(h.service.grantForClaim(buyer,'claim')).rejects.toThrow('RECEIPT_ACCESS_SCOPE_UNSUPPORTED');expect(h.grants).toHaveLength(0);
  });
  it('revokes only exact early effects and does not resurrect on another receipt upload',async()=>{
    const h=harness();await h.service.grantForClaim(buyer,'claim');h.grants.push({id:'paid',sourceType:'course_purchase',sourceId:'paid-line',courseId:'course',userId:buyer,status:'active'});
    delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
    const revoked=await h.service.revoke(admin,'claim','revoke-key-1',{reason:'Synthetic bank mismatch',expectedGeneration:1});
    expect(revoked.state).toBe('REVOKED');expect(h.grants[0].status).toBe('revoked');expect(h.grants[1].status).toBe('active');
    process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED='true';await h.service.grantForClaim(buyer,'claim');expect(h.generations).toHaveLength(1);
  });
  it('restores as a new generation preserving original course window',async()=>{
    const h=harness();await h.service.grantForClaim(buyer,'claim');await h.service.revoke(admin,'claim','revoke-key-1',{reason:'Synthetic bank mismatch',expectedGeneration:1});
    const result=await h.service.restore(admin,'claim','restore-key-1',{reason:'Synthetic corrected evidence',expectedGeneration:1});
    expect(result.generation).toBe(2);expect(h.grants[0].status).toBe('revoked');expect(h.grants[1].sourceId).not.toBe(h.grants[0].sourceId);expect(h.grants[1].startsAt).toEqual(h.grants[0].startsAt);
  });
  it('rejects stale generations and reused keys with different reasons',async()=>{
    const h=harness();await h.service.grantForClaim(buyer,'claim');
    await expect(h.service.revoke(admin,'claim','revoke-key-1',{reason:'Synthetic bank mismatch',expectedGeneration:2})).rejects.toThrow('RECEIPT_ACCESS_STATE_CHANGED');
    await h.service.revoke(admin,'claim','revoke-key-1',{reason:'Synthetic bank mismatch',expectedGeneration:1});
    await expect(h.service.revoke(admin,'claim','revoke-key-1',{reason:'Different synthetic reason',expectedGeneration:1})).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });
  it('blocks admin revocation after a canonical payment wins the order lock',async()=>{
    const h=harness();await h.service.grantForClaim(buyer,'claim');h.order.status='confirmed';h.order.confirmedSettlementId='settlement';
    await expect(h.service.revoke(admin,'claim','revoke-key-1',{reason:'Synthetic bank mismatch',expectedGeneration:1})).rejects.toThrow('ORDER_ALREADY_VERIFIED');expect(h.grants[0].status).toBe('active');
  });
  it('converts exactly early effects only after canonical settlement without changing other rights',async()=>{
    const h=harness();await h.service.grantForClaim(buyer,'claim');h.order.status='confirmed';h.order.confirmedSettlementId='settlement';
    expect(await h.service.convertForPaidOrder(h.tx,'order','settlement')).toBe(true);expect(h.generations[0].status).toBe('VERIFIED_PAID');expect(h.grants[0].status).toBe('revoked');
  });
  it('grants complete membership terms, included courses and service quota with a shared restore pool',async()=>{
    const h=harness();const startsAt=new Date(Date.now()-1000);const endsAt=new Date(Date.now()+86400000);
    h.order.lines[0].productType='membership';h.order.lines[0].productReferenceId='version';
    const entitlement={definitionId:'definition',valueType:'metered',resetPeriod:'term',booleanValue:null,quota:5n};
    h.order.membershipCheckoutIntent={versionId:'version',startsAt,endsAt,removedCourses:[],version:{
      includedCourses:[{courseId:'included-course'}],serviceEntitlements:[entitlement]}};
    h.tx.membershipSubscription.create.mockResolvedValue({id:'membership-term'});
    h.tx.serviceEntitlementQuotaPool={createMany:jest.fn(),findUnique:jest.fn().mockResolvedValue({
      id:'pool',orderLineId:'line',userId:buyer,...entitlement,startsAt,endsAt})};
    h.tx.serviceEntitlementGrant.create=jest.fn().mockResolvedValue({id:'service-grant'});
    await h.service.grantForClaim(buyer,'claim');
    expect(h.tx.membershipSubscription.create).toHaveBeenCalledWith({data:expect.objectContaining({sourceOrderLineId:null,startsAt,expiresAt:endsAt})});
    expect(h.access.ensureGrant).toHaveBeenCalledWith(expect.objectContaining({courseId:'included-course',startsAt,endsAt}),h.tx);
    expect(h.tx.serviceEntitlementGrant.create).toHaveBeenCalledWith({data:expect.objectContaining({sourceType:'UNVERIFIED_RECEIPT_ACCESS',quotaPoolId:'pool',quota:5n})});
    expect(h.effects.map(e=>e.effectKind)).toEqual(['MEMBERSHIP_TERM','MEMBERSHIP_COURSE','MEMBERSHIP_SERVICE']);
    await h.service.revoke(admin,'claim','membership-revoke',{reason:'Synthetic membership review',expectedGeneration:1});
    expect(h.tx.membershipSubscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'membership-term',sourceOrderLineId:null}),data:{status:'cancelled'}}));
    await h.service.restore(admin,'claim','membership-restore',{reason:'Synthetic membership restored',expectedGeneration:1});
    expect(h.tx.serviceEntitlementGrant.create.mock.calls[1][0].data.quotaPoolId).toBe('pool');
    expect(h.tx.serviceEntitlementGrant.create.mock.calls[1][0].data.endsAt).toEqual(endsAt);
  });});
