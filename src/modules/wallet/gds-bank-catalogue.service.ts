import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { readBankResponse } from './gds-bank-provider';
import { GDS_BANK_CATALOGUE_SNAPSHOT } from './gds-bank-catalogue.snapshot';

export interface GdsBank {
  code: string;
  bin: string;
  shortName: string;
  name: string;
  logoUrl: string;
  lookupSupported: boolean;
  transferSupported: boolean;
}
type CatalogueBank = GdsBank & { sourceLogo: string };
const TTL = 24 * 60 * 60 * 1000;

function canonicalCode(value: string): string { return value.toUpperCase().replace(/[ -]/g, ''); }
function logoSource(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid logo');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['cdn.vietqr.io', 'api.vietqr.io'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/img\/[A-Za-z0-9_%-]+\.png$/.test(url.pathname) || !/^\/img\/[A-Za-z0-9_ -]+\.png$/.test(decodeURIComponent(url.pathname))) throw new Error('Invalid logo');
  return url.href;
}
function parseBanks(data: unknown): CatalogueBank[] {
  if (!Array.isArray(data) || !data.length || data.length > 500) throw new Error('Invalid catalogue');
  const codes = new Set<string>();
  const bins = new Set<string>();
  return data.map((record: unknown) => {
    if (!record || typeof record !== 'object') throw new Error('Invalid bank');
    const bank = record as Record<string, unknown>;
    if (typeof bank.code !== 'string' || !/^[A-Za-z0-9 -]{2,24}$/.test(bank.code) || typeof bank.bin !== 'string' || !/^\d{6}$/.test(bank.bin) ||
      typeof bank.name !== 'string' || !bank.name.trim() || bank.name.length > 300 || typeof bank.shortName !== 'string' || !bank.shortName.trim() || bank.shortName.length > 80 ||
      /[\x00-\x1f\x7f]/.test(bank.name + bank.shortName) || ![null, 0, 1].includes(bank.lookupSupported as number) || ![0, 1].includes(bank.transferSupported as number)) throw new Error('Invalid bank');
    const code = canonicalCode(bank.code);
    if (codes.has(code) || bins.has(bank.bin)) throw new Error('Duplicate bank');
    codes.add(code); bins.add(bank.bin);
    return { code, bin: bank.bin, name: bank.name.trim(), shortName: bank.shortName.trim(), sourceLogo: logoSource(bank.logo),
      logoUrl: `/api/v1/wallet/gds/banks/${code}/logo`, lookupSupported: bank.lookupSupported === 1, transferSupported: bank.transferSupported === 1 };
  });
}

@Injectable()
export class GdsBankCatalogueService {
  private banks: CatalogueBank[] = parseBanks(GDS_BANK_CATALOGUE_SNAPSHOT.data);
  private refreshedAt = 0;
  private stale = true;
  private refresh?: Promise<void>;
  private readonly logos = new Map<string, { data: Buffer; expires: number }>();
  constructor(private readonly config: AppConfigService) {}

  async list(required: boolean) {
    await this.load();
    const settings = this.config.bankVerification;
    const ready = Boolean(settings.enabled && settings.clientId && settings.apiKey && settings.supportedBins.length);
    return {
      banks: this.banks.map(({ sourceLogo: _source, lookupSupported, transferSupported: _transfer, ...bank }) => {
        const supported = ready && lookupSupported && settings.supportedBins.includes(bank.bin);
        return { ...bank, verificationSupported: supported, ...(!supported ? { verificationUnavailableReason: ready ? 'Ngân hàng chưa được hỗ trợ xác minh.' : 'Dịch vụ xác minh chưa được kích hoạt.' } : {}) };
      }), stale: this.stale, verificationRequired: required, verificationAvailable: ready,
    };
  }

  async get(codeOrBin: string): Promise<GdsBank> {
    const { sourceLogo: _source, ...bank } = await this.find(codeOrBin);
    return bank;
  }

  async logo(code: string): Promise<Buffer> {
    const bank = await this.find(code);
    const cached = this.logos.get(bank.code);
    if (cached && cached.expires > Date.now()) return cached.data;
    try {
      const response = await fetch(bank.sourceLogo, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png') throw new Error('Invalid image');
      const data = await readBankResponse(response, 256 * 1024);
      if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid image');
      this.logos.set(bank.code, { data, expires: Date.now() + TTL });
      return data;
    } catch {
      if (cached) return cached.data;
      throw new ServiceUnavailableException('Logo ngân hàng tạm thời không khả dụng.');
    }
  }

  private async find(codeOrBin: string): Promise<CatalogueBank> {
    await this.load();
    const bank = this.banks.find((item) => item.code === canonicalCode(codeOrBin) || canonicalCode(item.shortName) === canonicalCode(codeOrBin) || item.bin === codeOrBin);
    if (!bank) throw new NotFoundException('Không tìm thấy ngân hàng.');
    return bank;
  }

  private async load(): Promise<void> {
    if (Date.now() - this.refreshedAt < (this.stale ? 60_000 : TTL)) return;
    if (!this.refresh) this.refresh = this.refreshBanks().finally(() => { this.refresh = undefined; });
    await this.refresh;
  }

  private async refreshBanks(): Promise<void> {
    try {
      const response = await fetch('https://api.vietqr.io/v2/banks', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Unavailable catalogue');
      const body = JSON.parse((await readBankResponse(response, 1024 * 1024)).toString('utf8')) as { code?: string; data?: unknown };
      if (body.code !== '00') throw new Error('Invalid catalogue');
      this.banks = parseBanks(body.data);
      this.stale = false;
    } catch {
      this.stale = true;
    } finally {
      this.refreshedAt = Date.now();
    }
  }
}
