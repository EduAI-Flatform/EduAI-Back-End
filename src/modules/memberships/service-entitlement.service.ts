import { createHash, createHmac } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  ServiceEntitlementGrantStatus,
  ServiceEntitlementValueType,
} from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { entitlementUsageWindow } from './service-entitlement.rules';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const grantInclude = { definition: true } satisfies Prisma.ServiceEntitlementGrantInclude;
type Grant = Prisma.ServiceEntitlementGrantGetPayload<{ include: typeof grantInclude }>;

export interface ProvisionServiceEntitlementsInput {
  userId: string;
  versionId: string;
  sourceType: string;
  sourceId: string;
  startsAt: Date;
  endsAt: Date | null;
}

@Injectable()
export class ServiceEntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async listForUser(userId: string, at = new Date()) {
    const grants = await this.activeGrants(this.prisma, userId, undefined, at);
    const decisions = await Promise.all(grants.map((grant) => this.grantDecision(this.prisma, grant, at)));
    const byCode = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      const current = byCode.get(decision.code);
      if (!current || (!current.allowed && decision.allowed)) byCode.set(decision.code, decision);
    }
    return { items: [...byCode.values()], evaluatedAt: at };
  }

  async resolve(userId: string, code: string, at = new Date()) {
    const normalizedCode = code.trim().toUpperCase();
    const grants = await this.activeGrants(this.prisma, userId, normalizedCode, at);
    if (grants.length === 0) return this.denied(normalizedCode);
    const decisions = await Promise.all(grants.map((grant) => this.grantDecision(this.prisma, grant, at)));
    return decisions.find((decision) => decision.allowed) ?? decisions[0];
  }

  async provisionFromPlanVersion(
    input: ProvisionServiceEntitlementsInput,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.sourceType)
      || input.sourceId.length < 1 || input.sourceId.length > 128
      || (input.endsAt !== null && input.endsAt <= input.startsAt)) {
      throw new BadRequestException('Invalid service entitlement grant source or window.');
    }
    const configured = await client.membershipPlanEntitlement.findMany({
      where: { versionId: input.versionId },
      orderBy: [{ definitionId: 'asc' }],
    });
    if (configured.length === 0) return [];
    await client.serviceEntitlementGrant.createMany({
      data: configured.map((item) => ({
        userId: input.userId, definitionId: item.definitionId,
        sourceType: input.sourceType, sourceId: input.sourceId,
        valueType: item.valueType, resetPeriod: item.resetPeriod,
        booleanValue: item.booleanValue, quota: item.quota,
        startsAt: input.startsAt, endsAt: input.endsAt,
      })),
      skipDuplicates: true,
    });
    return client.serviceEntitlementGrant.findMany({
      where: {
        userId: input.userId, sourceType: input.sourceType, sourceId: input.sourceId,
        definitionId: { in: configured.map((item) => item.definitionId) },
      },
      include: grantInclude,
      orderBy: [{ definition: { code: 'asc' } }],
    });
  }

  consume(
    userId: string,
    code: string,
    quantity: bigint,
    idempotencyKey: string | undefined,
    at = new Date(),
  ) {
    this.assertInput(quantity, idempotencyKey);
    const normalizedCode = code.trim().toUpperCase();
    const operationKeyHash = this.operationKeyHash(idempotencyKey as string);
    const requestHash = this.requestHash(normalizedCode, quantity);
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`);
      const existing = await tx.serviceEntitlementUsage.findUnique({
        where: { userId_operationKeyHash: { userId, operationKeyHash } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was already used for different entitlement input.' });
        }
        return {
          allowed: true, code: normalizedCode, consumed: existing.quantity.toString(),
          remaining: existing.remainingAfter?.toString() ?? null, idempotent: true, periodStartsAt: existing.periodStartsAt,
          periodEndsAt: existing.periodEndsAt,
        };
      }

      const grants = await this.activeGrants(tx, userId, normalizedCode, at);
      for (const grant of grants) {
        const decision = await this.grantDecision(tx, grant, at);
        if (!decision.allowed) continue;
        const remaining = decision.remaining === null ? null : BigInt(decision.remaining);
        if (remaining !== null && remaining < quantity) continue;
        const usage = await tx.serviceEntitlementUsage.create({
          data: {
            grantId: grant.id, userId, operationKeyHash, requestHash, quantity,
            periodStartsAt: decision.periodStartsAt,
            periodEndsAt: decision.periodEndsAt,
            remainingAfter: remaining === null ? null : remaining - quantity,
            createdAt: at,
          },
        });
        return {
          allowed: true, code: normalizedCode, consumed: quantity.toString(),
          remaining: usage.remainingAfter?.toString() ?? null,
          idempotent: false, periodStartsAt: usage.periodStartsAt,
          periodEndsAt: usage.periodEndsAt,
        };
      }
      throw new ForbiddenException({ error: 'ENTITLEMENT_EXHAUSTED_OR_UNAVAILABLE', message: 'The service entitlement is unavailable or exhausted.' });
    });
  }

  operationKeyHash(key: string): string {
    const secret = this.config.commerce.idempotencySecret;
    if (!secret) throw new ServiceUnavailableException('Service entitlement quota is unavailable.');
    return createHmac('sha256', secret).update(key).digest('hex');
  }

  requestHash(code: string, quantity: bigint): string {
    return createHash('sha256').update(JSON.stringify({ code: code.trim().toUpperCase(), quantity: quantity.toString() })).digest('hex');
  }

  private async activeGrants(
    client: Pick<PrismaService, 'serviceEntitlementGrant'> | Prisma.TransactionClient,
    userId: string,
    code: string | undefined,
    at: Date,
  ): Promise<Grant[]> {
    return client.serviceEntitlementGrant.findMany({
      where: {
        userId,
        status: ServiceEntitlementGrantStatus.active,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
        ...(code ? { definition: { code } } : {}),
      },
      include: grantInclude,
      orderBy: [{ endsAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async grantDecision(
    client: Pick<PrismaService, 'serviceEntitlementUsage'> | Prisma.TransactionClient,
    grant: Grant,
    at: Date,
  ) {
    const window = entitlementUsageWindow(grant.resetPeriod, grant.startsAt, grant.endsAt, at);
    let remaining: string | null = null;
    let allowed = grant.valueType !== ServiceEntitlementValueType.boolean || grant.booleanValue === true;
    if (grant.valueType === ServiceEntitlementValueType.metered) {
      const usage = await client.serviceEntitlementUsage.aggregate({
        where: { grantId: grant.id, periodStartsAt: window.startsAt, periodEndsAt: window.endsAt },
        _sum: { quantity: true },
      });
      const amount = usage._sum.quantity ?? 0n;
      const available = (grant.quota as bigint) - amount;
      allowed = available > 0n;
      remaining = (available > 0n ? available : 0n).toString();
    }
    return {
      code: grant.definition.code,
      displayName: grant.definition.displayName,
      description: grant.definition.description,
      unitLabel: grant.definition.unitLabel,
      valueType: grant.valueType.toUpperCase(),
      resetPeriod: grant.resetPeriod.toUpperCase(),
      allowed,
      reason: allowed ? 'ENTITLEMENT_ACTIVE' : 'ENTITLEMENT_DISABLED_OR_EXHAUSTED',
      remaining,
      periodStartsAt: window.startsAt,
      periodEndsAt: window.endsAt,
    };
  }

  private denied(code: string) {
    return { code, allowed: false, reason: 'ENTITLEMENT_EXPIRED_OR_MISSING', remaining: null };
  }

  private assertInput(quantity: bigint, key: string | undefined): void {
    if (quantity <= 0n || quantity > 9_223_372_036_854_775_807n) {
      throw new BadRequestException({ error: 'INVALID_ENTITLEMENT_QUANTITY', message: 'Quantity must be a positive supported integer.' });
    }
    if (!key || !KEY_PATTERN.test(key)) {
      throw new BadRequestException({ error: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-128 bounded ASCII characters.' });
    }
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
        if (retryable && attempt < 2) continue;
        throw error;
      }
    }
    throw new Error('Unreachable service entitlement transaction state.');
  }
}
