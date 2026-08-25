import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import {
  CommerceProductStatus,
  CommerceProductType,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class CommerceProductService {
  constructor(private readonly audit: AuditService) {}

  async ensureActiveMembershipProduct(
    tx: Prisma.TransactionClient,
    membershipPlanVersionId: string,
    sellerId: string,
  ) {
    let product = await tx.commerceProduct.findUnique({
      where: { membershipPlanVersionId },
    });
    if (!product) {
      product = await tx.commerceProduct.create({
        data: {
          type: CommerceProductType.membership,
          membershipPlanVersionId,
          sellerId,
          status: CommerceProductStatus.draft,
        },
      });
    }
    if (product.status === CommerceProductStatus.archived) {
      throw new ConflictException({
        error: 'MEMBERSHIP_UNAVAILABLE',
        message: 'Membership version is not available for checkout.',
      });
    }
    if (product.status === CommerceProductStatus.draft) {
      product = await tx.commerceProduct.update({
        where: { id: product.id },
        data: { status: CommerceProductStatus.active },
      });
    }
    return product;
  }

  async archiveMembershipPlanProducts(
    tx: Prisma.TransactionClient,
    actorId: string,
    membershipPlanId: string,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT product.id
        FROM commerce_products product
        JOIN membership_plan_versions version
          ON version.id = product.membership_plan_version_id
        WHERE version.plan_id = ${membershipPlanId}::uuid
        FOR UPDATE`,
    );
    const products = await tx.commerceProduct.findMany({
      where: {
        membershipPlanVersion: { planId: membershipPlanId },
        status: { not: CommerceProductStatus.archived },
      },
    });
    const archivedAt = new Date();
    for (const product of products) {
      await tx.commerceProduct.update({
        where: { id: product.id },
        data: { status: CommerceProductStatus.archived, archivedAt },
      });
      await this.audit.record({
        actorId,
        action: AuditAction.CommerceProductStatusChanged,
        target: { type: 'commerce_product', id: product.id },
        metadata: {
          membershipPlanId,
          membershipPlanVersionId: product.membershipPlanVersionId,
          previousStatus: product.status,
          nextStatus: CommerceProductStatus.archived,
          operationId: randomUUID(),
        },
      }, tx);
    }
  }
}
