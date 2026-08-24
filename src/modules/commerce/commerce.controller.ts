import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CartResponseDto } from './dto/commerce-response.dto';
import { CommerceService } from './commerce.service';
import { CommerceOrderService } from './commerce-order.service';
import { OrderResponseDto } from './dto/order-response.dto';

@ApiTags('Commerce')
@ApiBearerAuth()
@Controller('commerce')
export class CommerceController {
  constructor(
    private readonly commerceService: CommerceService,
    private readonly orderService: CommerceOrderService,
  ) {}

  @Get('cart')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiOkResponse({ type: CartResponseDto })
  getCart(@CurrentUser('id') learnerId: string): Promise<CartResponseDto> {
    return this.commerceService.getCart(learnerId);
  }

  @Post('cart/items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiCreatedResponse({ type: CartResponseDto })
  @ApiConflictResponse({ description: 'Course is already owned.' })
  addCourse(
    @CurrentUser('id') learnerId: string,
    @Body() input: AddCartItemDto,
  ): Promise<CartResponseDto> {
    return this.commerceService.addCourse(learnerId, input.courseId);
  }

  @Delete('cart/items/:courseId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiOkResponse({ type: CartResponseDto })
  removeCourse(
    @CurrentUser('id') learnerId: string,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<CartResponseDto> {
    return this.commerceService.removeCourse(learnerId, courseId);
  }

  @Delete('cart/items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiOkResponse({ type: CartResponseDto })
  clearCart(@CurrentUser('id') learnerId: string): Promise<CartResponseDto> {
    return this.commerceService.clearCart(learnerId);
  }

  @Post('orders')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiConflictResponse({ description: 'Idempotency key or ownership conflict.' })
  createOrder(
    @CurrentUser('id') learnerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateOrderDto,
  ): Promise<OrderResponseDto> {
    return this.orderService.createOrder(learnerId, idempotencyKey, input);
  }
}
