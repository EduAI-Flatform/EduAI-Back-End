import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { readFile, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { Worker } from 'worker_threads';
import { ReceiptClaimFields } from './bank-transfer-receipt-policy';
import { bankTransferEnabled } from './bank-transfer-policy';

const MAX_TEXT = 16_384;
const TIMEOUT_MS = 15_000;
let busy = false;

const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();
const labels: Record<keyof ReceiptClaimFields, string[]> = {
  bankBin: ['NGAN HANG THU HUONG', 'NGAN HANG NHAN', 'RECIPIENT BANK', 'BENEFICIARY BANK'],
  accountNumber: ['SO TAI KHOAN NHAN', 'TAI KHOAN THU HUONG', 'SO TAI KHOAN THU HUONG', 'RECIPIENT ACCOUNT', 'BENEFICIARY ACCOUNT'],
  beneficiaryName: ['TEN NGUOI NHAN', 'NGUOI THU HUONG', 'TEN THU HUONG', 'BENEFICIARY NAME', 'RECIPIENT NAME'],
  amountMinor: ['SO TIEN', 'SO TIEN CHUYEN', 'AMOUNT'],
  transferContent: ['NOI DUNG', 'NOI DUNG CHUYEN KHOAN', 'TRANSFER CONTENT', 'TRANSFER DESCRIPTION'],
  occurredAt: ['THOI GIAN', 'THOI GIAN GIAO DICH', 'NGAY GIAO DICH', 'TRANSACTION TIME'],
  transactionId: ['MA GIAO DICH', 'SO GIAO DICH', 'TRANSACTION ID'],
};
const fieldNames: Record<keyof ReceiptClaimFields, string> = {
  bankBin: 'BANK', accountNumber: 'ACCOUNT', beneficiaryName: 'BENEFICIARY', amountMinor: 'AMOUNT',
  transferContent: 'CONTENT', occurredAt: 'TIME', transactionId: 'TRANSACTION_ID',
};

function parseAmount(value: string): string | null {
  const match = value.match(/^([1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,2}(?: \d{3})+)\s*(?:VND|VNĐ|Đ)$/iu);
  const digits = match?.[1].replace(/[., ]/g, '');
  return digits && digits.length <= 15 ? digits : null;
}

function parseTime(value: string): string | null {
  // MB's bank-local zone must be visibly specified. Never attach a guessed zone.
  const match = value.match(/^(?:(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:UTC|GMT)?\+07:00|(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+07:00)$/i);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match[1]
    ? [match[3], match[2], match[1], match[4], match[5], match[6]] : match.slice(7, 13);
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(year) < 2000 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > lastDay
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+07:00`;
}

/** Deliberately conservative: unsupported layouts require a human; no expected-order data is accepted. */
export function parseReceiptOcrText(text: string): { fields: ReceiptClaimFields; warnings: string[] } {
  const fields: ReceiptClaimFields = { bankBin: null, accountNumber: null, beneficiaryName: null, amountMinor: null,
    transferContent: null, occurredAt: null, transactionId: null };
  const warnings: string[] = [];
  const candidates = new Map<keyof ReceiptClaimFields, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:：]{1,64})[:：]\s*(.*?)\s*$/u);
    if (!match) continue;
    const label = fold(match[1].trim()).replace(/\s+/g, ' ');
    for (const field of Object.keys(labels) as (keyof ReceiptClaimFields)[]) {
      if (labels[field].includes(label)) candidates.set(field, [...(candidates.get(field) ?? []), match[2]]);
    }
  }
  for (const field of Object.keys(fields) as (keyof ReceiptClaimFields)[]) {
    const values = candidates.get(field) ?? [];
    if (values.length !== 1) {
      warnings.push(`OCR_${values.length > 1 ? 'AMBIGUOUS' : 'MISSING'}_${fieldNames[field]}`);
      continue;
    }
    const value = values[0].trim().normalize('NFC');
    if (!value || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
      warnings.push(`OCR_INVALID_${fieldNames[field]}`); continue;
    }
    switch (field) {
      case 'bankBin': fields.bankBin = ['MB', 'MBBANK', 'MB BANK', 'NGAN HANG QUAN DOI', '970422'].includes(fold(value)) ? '970422' : null; break;
      case 'accountNumber': fields.accountNumber = /^\d{6,30}$/.test(value) ? value : null; break;
      case 'beneficiaryName': fields.beneficiaryName = /^[\p{L}\p{N} .&()-]{2,160}$/u.test(value) ? value.replace(/\s+/g, ' ').toUpperCase() : null; break;
      case 'amountMinor': fields.amountMinor = parseAmount(value); break;
      case 'transferContent': fields.transferContent = /^[A-Za-z0-9 ._:-]{1,100}$/.test(value) ? value.toUpperCase() : null; break;
      case 'occurredAt': fields.occurredAt = parseTime(value); break;
      case 'transactionId': fields.transactionId = /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value.toUpperCase() : null; break;
    }
    if (fields[field] === null) warnings.push(`OCR_INVALID_${fieldNames[field]}`);
  }
  return { fields, warnings };
}

// Fixed program only. User content is structured workerData, never executable source.
// Owning the host thread lets timeout terminate even a hung createWorker initialization.
const OCR_PROGRAM = `
const { parentPort, workerData } = require('worker_threads');
const { createWorker, OEM } = require(workerData.modulePath);
(async () => {
  let engine;
  try {
    // Version 7.0.0 initializes object languages using .data instead of .code.
    // String names + an explicit absolute local path avoid that upstream bug.
    engine = await createWorker(workerData.languages, OEM.LSTM_ONLY, {
      cacheMethod: 'none', gzip: false, langPath: workerData.modelPath,
      logger: () => {}, errorHandler: () => parentPort.postMessage({ error: true })
    });
    const result = await engine.recognize(Buffer.from(workerData.image), {}, { text: true });
    const text = result.data.text;
    if (typeof text !== 'string' || text.length > ${MAX_TEXT}) parentPort.postMessage({ error: true });
    else parentPort.postMessage({ text, confidence: result.data.confidence });
  } catch (_) { parentPort.postMessage({ error: true }); }
  finally { if (engine) await engine.terminate().catch(() => {}); }
})();`;

@Injectable()
export class BankReceiptOcrService {
  constructor(private readonly config: AppConfigService) {}

  async assess(buffer: Buffer): Promise<{ fields: ReceiptClaimFields; confidence: number; warnings: string[] }> {
    if (!bankTransferEnabled(this.config.app.nodeEnv, process.env.BANK_TRANSFER_SANDBOX_ENABLED)
      || process.env.BANK_RECEIPT_SANDBOX_ENABLED !== 'true') {
      throw new ServiceUnavailableException('OCR chứng từ chỉ được bật trong môi trường thử nghiệm.');
    }
    if (busy) throw new ServiceUnavailableException('OCR đang bận. Vui lòng thử lại sau.');
    busy = true;
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Uploads are capped at 5 MiB before decoding; canonical PNG may expand to 12 MiB.
      if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 12 * 1024 * 1024) throw new Error('invalid image');
      const modelPath = process.env.BANK_RECEIPT_OCR_DATA_PATH;
      if (!modelPath || !isAbsolute(modelPath) || /^(?:\\\\|\/\/)/.test(modelPath)) throw new Error('local models required');
      const languages = await Promise.all(['eng', 'vie'].map(async (code) => {
        const filename = join(modelPath, `${code}.traineddata`);
        const info = await stat(filename);
        if (!info.isFile() || info.size < 1 || info.size > 64 * 1024 * 1024) throw new Error('invalid model');
        const data = await readFile(filename);
        if (!data.length || data.length > 64 * 1024 * 1024) throw new Error('invalid model');
        return code;
      }));
      const output = await new Promise<{ text: string; confidence: number }>((resolve, reject) => {
        worker = new Worker(OCR_PROGRAM, { eval: true, workerData: {
          image: buffer, languages, modelPath, modulePath: require.resolve('tesseract.js'),
        }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
        // Keep native engine diagnostics (which may contain image text) out of application logs.
        worker.stdout?.resume();
        worker.stderr?.resume();
        timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        worker.once('error', () => reject(new Error('engine failed')));
        worker.once('exit', () => reject(new Error('engine exited')));
        worker.once('message', (message: unknown) => {
          if (!message || typeof message !== 'object') return reject(new Error('invalid OCR'));
          const data = message as { text?: unknown; confidence?: unknown; error?: unknown };
          if (data.error || typeof data.text !== 'string' || !data.text.trim() || data.text.length > MAX_TEXT
            || typeof data.confidence !== 'number' || !Number.isFinite(data.confidence) || data.confidence < 85 || data.confidence > 100) {
            return reject(new Error('invalid OCR'));
          }
          resolve({ text: data.text, confidence: data.confidence });
        });
      });
      return { ...parseReceiptOcrText(output.text), confidence: output.confidence };
    } catch {
      throw new ServiceUnavailableException('Không thể kiểm tra ảnh bằng OCR. Vui lòng yêu cầu Admin kiểm tra.');
    } finally {
      if (timer) clearTimeout(timer);
      try {
        if (worker) await worker.terminate();
        busy = false;
      } catch {
        // Do not admit another OCR job if termination could not be confirmed.
        throw new ServiceUnavailableException('OCR chưa dừng an toàn. Vui lòng liên hệ quản trị viên.');
      }
    }
  }
}
