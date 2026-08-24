import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CommerceCartStatus,
  CommerceProductStatus,
  CommerceProductType,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CartAvailability,
  CartItemResponseDto,
  CartResponseDto,
} from './dto/commerce-response.dto';

const CART_CURRENCY = 'VND' as const;
const QUALIFYING_ENROLLMENT_STATUSES = ['active', 'completed'];

const cartInclude = {
  lines: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      product: {
        include: { course: true },
      },
    },
  },
} satisfies Prisma.CommerceCartInclude;

type CartRecord = Prisma.CommerceCartGetPayload<{ include: typeof cartInclude }>;
type CartClient = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'commerceCart'
  | 'commerceCartLine'
  | 'commerceProduct'
  | 'course'
  | 'enrollment'
>;

@Injectable()
export class CommerceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly auditService: AuditService,
  ) {}

  async getCart(learnerId: string): Promise<CartResponseDto> {
    this.assertEnabled();
    const cart = await this.prisma.commerceCart.findFirst({
      where: { buyerId: learnerId, status: CommerceCartStatus.active },
      include: cartInclude,
    });
    return this.projectCart(learnerId, cart, this.prisma);
  }

  addCourse(learnerId: string, courseId: string): Promise<CartResponseDto> {
    this.assertEnabled();
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM courses WHERE id = ${courseId}::uuid FOR SHARE`,
      );
      const course = await tx.course.findFirst({ where: { id: courseId } });
      this.assertPurchasableCourse(course);

      const owned = await tx.enrollment.findFirst({
        where: {
          userId: learnerId,
          courseId,
          status: { in: QUALIFYING_ENROLLMENT_STATUSES },
        },
        select: { id: true },
      });
      if (owned) {
        throw new ConflictException({
          error: 'ALREADY_OWNED',
          message: 'You already have perpetual access to this course.',
        });
      }

      const product = await this.ensureActiveCourseProduct(tx, course);
      const cart = await this.findOrCreateActiveCart(tx, learnerId);
      const existingLine = await tx.commerceCartLine.findUnique({
        where: { cartId_productId: { cartId: cart.id, productId: product.id } },
        select: { id: true },
      });
      await tx.commerceCartLine.upsert({
        where: { cartId_productId: { cartId: cart.id, productId: product.id } },
        create: { cartId: cart.id, productId: product.id, quantity: 1 },
        update: { quantity: 1 },
      });

      if (!existingLine) {
        await this.auditService.record(
          {
            actorId: learnerId,
            action: AuditAction.CommerceCartItemAdded,
            target: { type: 'commerce_cart', id: cart.id },
            metadata: { courseId, productId: product.id, operationId: randomUUID() },
          },
          tx,
        );
      }

      const updated = await this.findActiveCart(tx, learnerId);
      return this.projectCart(learnerId, updated, tx);
    });
  }

  removeCourse(learnerId: string, courseId: string): Promise<CartResponseDto> {
    this.assertEnabled();
    return this.runSerializable(async (tx) => {
      const cart = await this.findActiveCart(tx, learnerId);
      if (!cart) return this.emptyCart();

      const line = cart.lines.find((item) => item.product.courseId === courseId);
      if (line) {
        await tx.commerceCartLine.delete({ where: { id: line.id } });
        await this.auditService.record(
          {
            actorId: learnerId,
            action: AuditAction.CommerceCartItemRemoved,
            target: { type: 'commerce_cart', id: cart.id },
            metadata: {
              courseId,
              productId: line.productId,
              operationId: randomUUID(),
            },
          },
          tx,
        );
      }

      return this.projectCart(learnerId, await this.findActiveCart(tx, learnerId), tx);
    });
  }

  clearCart(learnerId: string): Promise<CartResponseDto> {
    this.assertEnabled();
    return this.runSerializable(async (tx) => {
      const cart = await this.findActiveCart(tx, learnerId);
      if (!cart || cart.lines.length === 0) return this.projectCart(learnerId, cart, tx);

      await tx.commerceCartLine.deleteMany({ where: { cartId: cart.id } });
      await this.auditService.record(
        {
          actorId: learnerId,
          action: AuditAction.CommerceCartCleared,
          target: { type: 'commerce_cart', id: cart.id },
          metadata: { removedItemCount: cart.lines.length, operationId: randomUUID() },
        },
        tx,
      );
      return this.projectCart(learnerId, await this.findActiveCart(tx, learnerId), tx);
    });
  }

  private assertEnabled(): void {
    if (!this.config.commerce.enabled) {
      throw new ServiceUnavailableException({
        error: 'COMMERCE_DISABLED',
        message: 'Commerce is not enabled.',
      });
    }
  }

  private assertPurchasableCourse(
    course: Awaited<ReturnType<CartClient['course']['findFirst']>>,
  ): asserts course is NonNullable<typeof course> {
    if (!course || course.deletedAt) {
      throw new NotFoundException({ error: 'COURSE_NOT_FOUND', message: 'Course not found.' });
    }
    if (
      course.status !== 'published' ||
      course.visibility !== 'public' ||
      course.moderationStatus !== 'clear'
    ) {
      throw new BadRequestException({
        error: 'COURSE_UNAVAILABLE',
        message: 'Course is not available for purchase.',
      });
    }
    if (
      course.priceAmountMinor === null ||
      course.priceAmountMinor <= 0 ||
      !Number.isSafeInteger(course.priceAmountMinor)
    ) {
      throw new BadRequestException({
        error: 'PAYMENT_NOT_REQUIRED',
        message: 'This course does not require a paid checkout.',
      });
    }
    if (course.priceCurrency !== CART_CURRENCY) {
      throw new BadRequestException({
        error: 'UNSUPPORTED_CURRENCY',
        message: 'Phase 3 checkout supports VND only.',
      });
    }
  }

  private async ensureActiveCourseProduct(
    tx: CartClient,
    course: NonNullable<Awaited<ReturnType<CartClient['course']['findFirst']>>>,
  ) {
    let product = await tx.commerceProduct.findUnique({
      where: { courseId: course.id },
    });
    if (!product) {
      product = await tx.commerceProduct.create({
        data: {
          type: CommerceProductType.course,
          courseId: course.id,
          sellerId: course.instructorId,
          status: CommerceProductStatus.draft,
        },
      });
    }
    if (product.status === CommerceProductStatus.archived) {
      throw new BadRequestException({
        error: 'COURSE_UNAVAILABLE',
        message: 'Course is not available for purchase.',
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

  private async findOrCreateActiveCart(tx: CartClient, learnerId: string) {
    const existing = await tx.commerceCart.findFirst({
      where: { buyerId: learnerId, status: CommerceCartStatus.active },
      select: { id: true },
    });
    if (existing) return existing;
    return tx.commerceCart.create({
      data: { buyerId: learnerId, status: CommerceCartStatus.active, currency: CART_CURRENCY },
      select: { id: true },
    });
  }

  private findActiveCart(tx: CartClient, learnerId: string): Promise<CartRecord | null> {
    return tx.commerceCart.findFirst({
      where: { buyerId: learnerId, status: CommerceCartStatus.active },
      include: cartInclude,
    });
  }

  private async projectCart(
    learnerId: string,
    cart: CartRecord | null,
    client: Pick<Prisma.TransactionClient, 'enrollment'>,
  ): Promise<CartResponseDto> {
    if (!cart) return this.emptyCart();

    const items = await Promise.all(
      cart.lines.map(async (line): Promise<CartItemResponseDto> => {
        const course = line.product.course;
        const owned = course
          ? await client.enrollment.findFirst({
              where: {
                userId: learnerId,
                courseId: course.id,
                status: { in: QUALIFYING_ENROLLMENT_STATUSES },
              },
              select: { id: true },
            })
          : null;
        const availability = this.resolveAvailability(line.product.status, course, Boolean(owned));
        const amountMinor = course?.priceAmountMinor ?? 0;
        return {
          id: line.id,
          productId: line.productId,
          course: {
            id: course?.id ?? line.product.courseId ?? '',
            title: course?.title ?? '',
            slug: course?.slug ?? '',
            thumbnailUrl: course?.thumbnailUrl ?? null,
          },
          unitPrice: { amountMinor: String(amountMinor), currency: CART_CURRENCY },
          quantity: 1,
          availability,
          warnings: [],
        };
      }),
    );
    const subtotal = items.reduce(
      (sum, item) =>
        item.availability === 'AVAILABLE' ? sum + BigInt(item.unitPrice.amountMinor) : sum,
      0n,
    );
    return {
      id: cart.id,
      status: 'ACTIVE',
      currency: CART_CURRENCY,
      items,
      summary: {
        subtotalAmountMinor: subtotal.toString(),
        currency: CART_CURRENCY,
        itemCount: items.length,
        canCheckout: items.length > 0 && items.every((item) => item.availability === 'AVAILABLE'),
      },
    };
  }

  private resolveAvailability(
    productStatus: CommerceProductStatus,
    course: CartRecord['lines'][number]['product']['course'],
    owned: boolean,
  ): CartAvailability {
    if (owned) return 'ALREADY_OWNED';
    if (
      productStatus !== CommerceProductStatus.active ||
      !course ||
      course.deletedAt ||
      course.status !== 'published' ||
      course.visibility !== 'public' ||
      course.moderationStatus !== 'clear'
    ) {
      return 'COURSE_UNAVAILABLE';
    }
    if (
      course.priceAmountMinor === null ||
      course.priceAmountMinor <= 0 ||
      !Number.isSafeInteger(course.priceAmountMinor)
    ) {
      return 'PAYMENT_NOT_REQUIRED';
    }
    if (course.priceCurrency !== CART_CURRENCY) return 'UNSUPPORTED_CURRENCY';
    return 'AVAILABLE';
  }

  private emptyCart(): CartResponseDto {
    return {
      id: null,
      status: 'ACTIVE',
      currency: CART_CURRENCY,
      items: [],
      summary: {
        subtotalAmountMinor: '0',
        currency: CART_CURRENCY,
        itemCount: 0,
        canCheckout: false,
      },
    };
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2002');
        if (!retryable || attempt === 2) throw error;
      }
    }
    throw new Error('Unreachable commerce transaction retry state.');
  }
}
