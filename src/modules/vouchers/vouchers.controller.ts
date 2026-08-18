import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { RedeemVoucherDto } from './dto/redeem-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import {
  VoucherPreviewResponse,
  VoucherRedemptionResponse,
  VoucherResponse,
  VoucherPage,
  VoucherRedemptionPage,
  VouchersService,
} from './vouchers.service';
import { ListVouchersQueryDto } from './dto/list-vouchers-query.dto';

@ApiTags('Vouchers')
@Controller()
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) {}

  @Post('admin/vouchers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Voucher created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid voucher policy or scope.' })
  @ApiConflictResponse({ description: 'Voucher code is already in use.' })
  createVoucher(
    @CurrentUser('id') actorId: string,
    @Body() input: CreateVoucherDto,
  ): Promise<VoucherResponse> {
    return this.vouchersService.createVoucher(actorId, input);
  }

  @Get('admin/vouchers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Voucher list returned successfully.' })
  listVouchers(@Query() query: ListVouchersQueryDto): Promise<VoucherPage> {
    return this.vouchersService.listVouchers(query);
  }

  @Get('admin/vouchers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Voucher returned successfully.' })
  @ApiNotFoundResponse({ description: 'Voucher not found.' })
  getVoucher(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<VoucherResponse> {
    return this.vouchersService.getVoucher(id);
  }

  @Get('admin/vouchers/:id/redemptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Voucher redemption history returned successfully.' })
  @ApiNotFoundResponse({ description: 'Voucher not found.' })
  listRedemptions(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListVouchersQueryDto,
  ): Promise<VoucherRedemptionPage> {
    return this.vouchersService.listRedemptions(id, query);
  }

  @Patch('admin/vouchers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Voucher updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid voucher policy or scope.' })
  @ApiConflictResponse({ description: 'Voucher code or redeemed policy conflict.' })
  @ApiNotFoundResponse({ description: 'Voucher not found.' })
  updateVoucher(
    @CurrentUser('id') actorId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateVoucherDto,
  ): Promise<VoucherResponse> {
    return this.vouchersService.updateVoucher(actorId, id, input);
  }

  @Post('courses/:courseId/voucher-preview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Voucher eligibility preview returned.' })
  @ApiBadRequestResponse({ description: 'Voucher is not eligible.' })
  @ApiNotFoundResponse({ description: 'Published course not found.' })
  preview(
    @CurrentUser('id') userId: string,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: RedeemVoucherDto,
  ): Promise<VoucherPreviewResponse> {
    return this.vouchersService.preview(userId, courseId, input.code);
  }

  @Post('courses/:courseId/voucher-redemptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Voucher redemption recorded.' })
  @ApiBadRequestResponse({ description: 'Voucher is not eligible.' })
  @ApiConflictResponse({ description: 'Redemption key conflict.' })
  @ApiNotFoundResponse({ description: 'Published course not found.' })
  redeem(
    @CurrentUser('id') userId: string,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: RedeemVoucherDto,
  ): Promise<VoucherRedemptionResponse> {
    return this.vouchersService.redeem(userId, courseId, input);
  }
}
