import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CommerceAdminService } from './commerce-admin.service';
import {
  ListCommerceCatalogQueryDto,
  ListCommerceOrdersQueryDto,
  UpdateCommerceCatalogDto,
} from './dto/admin-commerce.dto';

@ApiTags('Admin Commerce')
@ApiBearerAuth()
@Controller('admin/commerce')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class CommerceAdminController {
  constructor(private readonly service: CommerceAdminService) {}

  @Get('catalog')
  @ApiOkResponse({ description: 'Paginated Commerce course catalog.' })
  listCatalog(@Query() query: ListCommerceCatalogQueryDto) {
    return this.service.listCatalog(query);
  }

  @Patch('catalog/:courseId')
  @ApiOkResponse({ description: 'Course price and sellability updated.' })
  updateCatalog(
    @CurrentUser('id') actorId: string,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: UpdateCommerceCatalogDto,
  ) {
    return this.service.updateCatalog(actorId, courseId, input);
  }

  @Get('orders')
  @ApiOkResponse({ description: 'Paginated sanitized Commerce orders.' })
  listOrders(@Query() query: ListCommerceOrdersQueryDto) {
    return this.service.listOrders(query);
  }

  @Get('orders/:orderId')
  @ApiOkResponse({ description: 'Sanitized Commerce order detail and lifecycle.' })
  getOrder(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string) {
    return this.service.getOrder(orderId);
  }
}
