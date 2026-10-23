import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { bankTransferEnabled } from './bank-transfer-policy';
import { BankReceiptService } from './bank-transfer-receipt.service';

/** Receipt retention has its own timer so storage failures cannot block payment expiry. */
@Injectable()
export class BankReceiptCleanupScheduler implements OnApplicationBootstrap,OnApplicationShutdown {
  private timer?:NodeJS.Timeout;
  private running=false;
  private readonly logger=new Logger(BankReceiptCleanupScheduler.name);
  constructor(private readonly receipts:BankReceiptService,private readonly config:AppConfigService) {}
  onApplicationBootstrap() {
    if (!bankTransferEnabled(this.config.app.nodeEnv,process.env.BANK_TRANSFER_SANDBOX_ENABLED)
      || process.env.BANK_RECEIPT_SANDBOX_ENABLED !== 'true') return;
    void this.run(); this.timer=setInterval(()=>void this.run(),60000); this.timer.unref();
  }
  onApplicationShutdown() { if(this.timer)clearInterval(this.timer);this.timer=undefined; }
  private async run() {
    if(this.running)return; this.running=true;
    try {await this.receipts.cleanupExpired();}
    catch {this.logger.warn('Synthetic receipt retention checkpoint failed; it will retry.');}
    finally {this.running=false;}
  }
}
