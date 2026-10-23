import { BadRequestException, Controller, Get, Header, Headers, Param, ParseUUIDPipe, Post, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ListPendingPaymentQueryDto } from './dto/payment-request-response.dto';
import { MAX_RECEIPT_BYTES, ReceiptImageUpload } from './bank-transfer-receipt-image';
import { BankReceiptService } from './bank-transfer-receipt.service';

@ApiTags('Bank Receipt Claims') @ApiBearerAuth()
@Controller('payments') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.student)
export class BankReceiptController {
  constructor(private readonly receipts:BankReceiptService) {}
  @Post('orders/:orderId/receipts')
  @ApiConsumes('multipart/form-data')
  @Header('Cache-Control','no-store')
  @RateLimit({identity:'user',limit:6,name:'bank-receipt-upload',windowSeconds:3600})
  @UseInterceptors(FileInterceptor('image',{limits:{fileSize:MAX_RECEIPT_BYTES,files:1,fields:0,parts:1},
    fileFilter:(_request,file,callback)=>{
      if (!['image/png','image/jpeg'].includes(file.mimetype)) return callback(new BadRequestException('RECEIPT_IMAGE_TYPE_INVALID'),false);
      callback(null,true);
    }}))
  upload(@CurrentUser('id') buyerId:string, @Param('orderId',new ParseUUIDPipe({version:'4'})) orderId:string,
    @Headers('idempotency-key') key:string|undefined, @UploadedFile() image:ReceiptImageUpload|undefined) {
    return this.receipts.upload(buyerId,orderId,key,image);
  }
  @Get('orders/:orderId/receipts') @Header('Cache-Control','no-store')
  list(@CurrentUser('id') buyerId:string, @Param('orderId',new ParseUUIDPipe({version:'4'})) orderId:string) {
    return this.receipts.listOwned(buyerId,orderId);
  }
  @Get('receipts/:receiptId/image')
  @Header('Cache-Control','private, no-store') @Header('X-Content-Type-Options','nosniff')
  @Header('Content-Security-Policy',"default-src 'none'; sandbox")
  @RateLimit({identity:'user',limit:30,name:'bank-receipt-image',windowSeconds:60})
  async image(@CurrentUser('id') buyerId:string, @Param('receiptId',new ParseUUIDPipe({version:'4'})) receiptId:string) {
    return new StreamableFile(await this.receipts.imageOwned(buyerId,receiptId),{type:'image/png',disposition:'inline'});
  }
}

@ApiTags('Admin Receipt Review') @ApiBearerAuth()
@Controller('admin/commerce/receipt-claims') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin)
export class BankReceiptAdminController {
  constructor(private readonly receipts:BankReceiptService) {}
  @Get() @Header('Cache-Control','no-store')
  list(@CurrentUser('id') actorId:string,@Query() query:ListPendingPaymentQueryDto) {return this.receipts.listAdmin(actorId,query);}
  @Get(':receiptId') @Header('Cache-Control','no-store')
  detail(@CurrentUser('id') actorId:string,@Param('receiptId',new ParseUUIDPipe({version:'4'})) receiptId:string) {
    return this.receipts.detailAdmin(actorId,receiptId);
  }
  @Get(':receiptId/image')
  @Header('Cache-Control','private, no-store') @Header('X-Content-Type-Options','nosniff')
  @Header('Content-Security-Policy',"default-src 'none'; sandbox")
  @RateLimit({identity:'user',limit:30,name:'admin-bank-receipt-image',windowSeconds:60})
  async image(@CurrentUser('id') actorId:string,@Param('receiptId',new ParseUUIDPipe({version:'4'})) receiptId:string) {
    return new StreamableFile(await this.receipts.imageAdmin(actorId,receiptId),{type:'image/png',disposition:'inline'});
  }
}
