import { ConflictException } from '@nestjs/common';
import { CommerceProductStatus, CommerceProductType } from '../../../generated/prisma/client';
import { CommerceProductService } from './commerce-product.service';

describe('CommerceProductService membership boundary', () => {
  const product = {
    id: 'product-id',
    type: CommerceProductType.membership,
    courseId: null,
    membershipPlanVersionId: 'version-id',
    sellerId: 'seller-id',
    status: CommerceProductStatus.draft,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  };

  function harness() {
    const tx = {
      $queryRaw: jest.fn(),
      commerceProduct: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(product),
        update: jest.fn().mockResolvedValue({ ...product, status: CommerceProductStatus.active }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const audit = { record: jest.fn() };
    return { service: new CommerceProductService(audit as never), tx, audit };
  }

  it('uses the guarded draft-to-active lifecycle for a new membership product', async () => {
    const { service, tx } = harness();

    await expect(service.ensureActiveMembershipProduct(
      tx as never,
      'version-id',
      'seller-id',
    )).resolves.toMatchObject({ status: CommerceProductStatus.active });

    expect(tx.commerceProduct.create).toHaveBeenCalledWith({ data: {
      type: CommerceProductType.membership,
      membershipPlanVersionId: 'version-id',
      sellerId: 'seller-id',
      status: CommerceProductStatus.draft,
    } });
    expect(tx.commerceProduct.update).toHaveBeenCalledWith({
      where: { id: 'product-id' },
      data: { status: CommerceProductStatus.active },
    });
  });

  it('never reactivates an archived membership product', async () => {
    const { service, tx } = harness();
    tx.commerceProduct.findUnique.mockResolvedValue({
      ...product,
      status: CommerceProductStatus.archived,
    });

    await expect(service.ensureActiveMembershipProduct(
      tx as never,
      'version-id',
      'seller-id',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(tx.commerceProduct.update).not.toHaveBeenCalled();
  });

  it('archives only non-archived products for the exact plan with atomic audit', async () => {
    const { service, tx, audit } = harness();
    tx.commerceProduct.findMany.mockResolvedValue([{ ...product, status: CommerceProductStatus.active }]);
    tx.commerceProduct.update.mockResolvedValue({ ...product, status: CommerceProductStatus.archived });

    await service.archiveMembershipPlanProducts(tx as never, 'admin-id', 'plan-id');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.commerceProduct.findMany).toHaveBeenCalledWith({
      where: {
        membershipPlanVersion: { planId: 'plan-id' },
        status: { not: CommerceProductStatus.archived },
      },
    });
    expect(tx.commerceProduct.update).toHaveBeenCalledWith({
      where: { id: 'product-id' },
      data: { status: CommerceProductStatus.archived, archivedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-id',
        target: { type: 'commerce_product', id: 'product-id' },
        metadata: expect.objectContaining({
          membershipPlanId: 'plan-id',
          membershipPlanVersionId: 'version-id',
          previousStatus: CommerceProductStatus.active,
          nextStatus: CommerceProductStatus.archived,
        }),
      }),
      tx,
    );
  });
});
