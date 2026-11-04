import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/** Bound upstream bodies before parsing; never include upstream text in errors/logs. */
export async function readBankResponse(response: Response, limit: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > limit || !response.body) throw new Error('Invalid response size');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Invalid response size');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class GdsBankLookupProvider {
  constructor(private readonly config: AppConfigService) {}

  isAvailable(): boolean {
    const settings = this.config.bankVerification;
    return Boolean(settings.enabled && settings.clientId && settings.apiKey && settings.supportedBins.length);
  }

  available(bin: string): boolean {
    const settings = this.config.bankVerification;
    return this.isAvailable() && settings.supportedBins.includes(bin);
  }

  async lookup(bin: string, accountNumber: string): Promise<{ accountHolder: string; provider: 'vietqr'; providerReference?: string }> {
    if (!this.available(bin)) throw new ServiceUnavailableException('Dịch vụ xác minh ngân hàng chưa sẵn sàng.');
    if (!/^\d{6}$/.test(bin) || !/^\d{6,30}$/.test(accountNumber)) throw new BadRequestException('Thông tin tài khoản không hợp lệ.');
    let body: { code?: unknown; data?: { accountName?: unknown; accountNumber?: unknown; bin?: unknown } };
    try {
      const response = await fetch('https://api.vietqr.io/v2/lookup', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'x-client-id': this.config.bankVerification.clientId!, 'x-api-key': this.config.bankVerification.apiKey! },
        body: JSON.stringify({ bin, accountNumber }),
      });
      if (!response.ok) throw new Error('Upstream unavailable');
      body = JSON.parse((await readBankResponse(response, 16 * 1024)).toString('utf8'));
      if (!body || typeof body !== 'object' || typeof body.code !== 'string') throw new Error('Invalid upstream response');
    } catch {
      throw new ServiceUnavailableException('Dịch vụ xác minh ngân hàng tạm thời không khả dụng.');
    }
    const name = body.data?.accountName;
    if (body.code !== '00' || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 160 || /[\x00-\x1f\x7f]/.test(name) ||
      (body.data?.accountNumber !== undefined && body.data.accountNumber !== accountNumber) ||
      (body.data?.bin !== undefined && body.data.bin !== bin)) {
      throw new BadRequestException('Không xác minh được tài khoản ngân hàng.');
    }
    return { accountHolder: name.trim().replace(/\s+/g, ' '), provider: 'vietqr' };
  }
}
