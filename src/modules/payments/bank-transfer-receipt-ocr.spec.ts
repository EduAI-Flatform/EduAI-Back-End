import { AppConfigService } from '../../config/app-config.service';
import { EventEmitter } from 'events';
import { runInNewContext } from 'vm';
import { join } from 'path';
import { tmpdir } from 'os';
import { BankReceiptOcrService, parseReceiptOcrText } from './bank-transfer-receipt-ocr.service';

jest.mock('fs/promises', () => ({
  stat: jest.fn(async () => ({ isFile: () => true, size: 10 })),
  readFile: jest.fn(async () => Buffer.from('local-model')),
}));
jest.mock('worker_threads', () => ({ Worker: jest.fn() }));

const text = `Ngân hàng thụ hưởng: MB
Số tài khoản nhận: 000123456789
Tên người nhận: CONG TY GIAO DUC
Số tiền: 150.000 VND
Nội dung chuyển khoản: EDUAI TEST123
Thời gian giao dịch: 23/10/2026 13:05:06 +07:00
Mã giao dịch: SYNTHETIC-123`;

describe('strict receipt OCR parser', () => {
  it('extracts only explicit labelled recipient fields and canonical VND', () => {
    expect(parseReceiptOcrText(text)).toEqual({ fields: {
      bankBin: '970422', accountNumber: '000123456789', beneficiaryName: 'CONG TY GIAO DUC',
      amountMinor: '150000', transferContent: 'EDUAI TEST123',
      occurredAt: '2026-10-23T13:05:06+07:00', transactionId: 'SYNTHETIC-123',
    }, warnings: [] });
  });
  it.each(['150,000 VND', '150000 VND', '150 000 VNĐ', '150.000 đ'])(
    'accepts unambiguous whole VND: %s', (amount) => {
      expect(parseReceiptOcrText(text.replace('150.000 VND', amount)).fields.amountMinor).toBe('150000');
    });
  it.each(['150.00 VND', '150,50 VND', '150.000,00 VND', '-150000 VND', '0 VND', '150000', '1e5 VND', '0150000 VND', '150000 USD'])(
    'does not guess amount: %s', (amount) => {
      expect(parseReceiptOcrText(text.replace('150.000 VND', amount)).fields.amountMinor).toBeNull();
    });
  it('treats repeated labels as ambiguous even when values agree', () => {
    const result = parseReceiptOcrText(`${text}\nSố tiền: 150.000 VND`);
    expect(result.fields.amountMinor).toBeNull();
    expect(result.warnings).toContain('OCR_AMBIGUOUS_AMOUNT');
  });
  it.each([
    ['Ngân hàng nhận: MB', 'bankBin'], ['Recipient account: 000123456789', 'accountNumber'],
    ['Recipient name: CONG TY GIAO DUC', 'beneficiaryName'], ['Transfer content: EDUAI TEST123', 'transferContent'],
    ['Transaction time: 2026-10-23T13:05:06+07:00', 'occurredAt'], ['Transaction ID: SYNTHETIC-123', 'transactionId'],
  ] as const)('rejects duplicate aliases for %s', (line, field) => {
    expect(parseReceiptOcrText(`${text}\n${line}`).fields[field]).toBeNull();
  });
  it('never takes sender bank/account or an unlabelled number as recipient', () => {
    const result = parseReceiptOcrText('Ngân hàng chuyển: MB\nTài khoản gửi: 000123456789\n150000 VND');
    expect(result.fields.bankBin).toBeNull();
    expect(result.fields.accountNumber).toBeNull();
    expect(result.fields.amountMinor).toBeNull();
  });
  it('requires a single-line exact content rather than joining possible OCR fragments', () => {
    expect(parseReceiptOcrText(text.replace('EDUAI TEST123', '\nEDUAI TEST123')).fields.transferContent).toBeNull();
  });
  it.each(['23/10/2026 13:05:06', '31/02/2026 13:05:06 +07:00', '23/10/2026 25:05:06 +07:00', '23/10/2026 13:05:06 +08:00'])(
    'fails closed for missing bank-local offset or invalid date: %s', (timestamp) => {
      expect(parseReceiptOcrText(text.replace('23/10/2026 13:05:06 +07:00', timestamp)).fields.occurredAt).toBeNull();
    });
  it('supports strict bank-local ISO timestamps', () => {
    expect(parseReceiptOcrText(text.replace('23/10/2026 13:05:06 +07:00', '2026-10-23T13:05:06+07:00')).fields.occurredAt)
      .toBe('2026-10-23T13:05:06+07:00');
  });
  it('does not correct OCR account digits or unknown bank names', () => {
    const result = parseReceiptOcrText(text.replace('MB\n', 'UNKNOWN\n').replace('000123456789', 'OOO123456789'));
    expect(result.fields.bankBin).toBeNull();
    expect(result.fields.accountNumber).toBeNull();
  });
});

describe('local bounded receipt OCR adapter', () => {
  const { Worker } = jest.requireMock('worker_threads');
  const fs = jest.requireMock('fs/promises');
  let worker: EventEmitter & { terminate: jest.Mock };
  const localModelPath = join(tmpdir(), 'synthetic-models');
  const originalEnv = { ...process.env };
  const service = (path = localModelPath, nodeEnv = 'test') => {
    process.env.BANK_RECEIPT_OCR_DATA_PATH = path;
    return new BankReceiptOcrService({ app: { nodeEnv } } as AppConfigService);
  };
  beforeEach(() => {
    process.env.BANK_TRANSFER_SANDBOX_ENABLED = 'true';
    process.env.BANK_RECEIPT_SANDBOX_ENABLED = 'true';
    jest.clearAllMocks();
    fs.stat.mockResolvedValue({ isFile: () => true, size: 10 });
    fs.readFile.mockResolvedValue(Buffer.from('local-model'));
    worker = Object.assign(new EventEmitter(), { terminate: jest.fn(async () => 0) });
    Worker.mockImplementation(() => worker);
  });
  afterAll(() => { process.env = originalEnv; });
  it('refuses production before model or engine IO', async () => {
    await expect(service(localModelPath, 'production').assess(Buffer.from('image'))).rejects.toThrow('OCR');
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });
  it('is default OFF before model IO', async () => {
    delete process.env.BANK_RECEIPT_SANDBOX_ENABLED;
    await expect(service().assess(Buffer.from('image'))).rejects.toThrow('OCR');
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  const start = async () => { const pending = service().assess(Buffer.from('canonical-image')); await new Promise(setImmediate); return { pending }; };
  it.each(['', './models', 'https://example.test/models', '//server/models', '\\\\server\\models'])('rejects nonlocal model paths without starting OCR: %s', async (path) => {
    await expect(service(path).assess(Buffer.from('image'))).rejects.toThrow('OCR');
    expect(Worker).not.toHaveBeenCalled();
  });
  it('fails closed when either local model is missing', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('private-path-must-not-leak'));
    await expect(service().assess(Buffer.from('image'))).rejects.toThrow('OCR');
    expect(Worker).not.toHaveBeenCalled();
  });
  it('uses string language names with explicit local path to avoid Tesseract 7 object-language initialization bug', async () => {
    const { pending } = await start();
    const [script, options] = Worker.mock.calls[0];
    expect(options.workerData.languages).toEqual(['eng', 'vie']);
    expect(options.workerData.modelPath).toBe(localModelPath);
    expect(script).toContain("cacheMethod: 'none'");
    expect(script).toContain('createWorker(workerData.languages');
    expect(script).toContain('langPath: workerData.modelPath');
    expect(script).not.toContain('https://');
    worker.emit('message', { text, confidence: 95 });
    await expect(pending).resolves.toMatchObject({ fields: { amountMinor: '150000' }, confidence: 95 });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('engine program uses only supplied local language configuration and terminates after recognition', async () => {
    const { pending } = await start();
    const [script, options] = Worker.mock.calls[0];
    let signal!: () => void;
    const complete = new Promise<void>((resolve) => { signal = resolve; });
    const engine = { recognize: jest.fn(async () => ({ data: { text, confidence: 95 } })), terminate: jest.fn(async () => { signal(); }) };
    const createWorker = jest.fn(async () => engine);
    const postMessage = jest.fn((message) => worker.emit('message', message));
    runInNewContext(script, { Buffer, require: (name: string) => {
      if (name === 'worker_threads') return { parentPort: { postMessage }, workerData: options.workerData };
      if (name === options.workerData.modulePath) return { createWorker, OEM: { LSTM_ONLY: 1 } };
      throw new Error('Unexpected module or network access');
    }, fetch: () => { throw new Error('Network forbidden'); } });
    await pending;
    await complete;
    expect(createWorker).toHaveBeenCalledWith(['eng', 'vie'], 1, expect.objectContaining({ cacheMethod: 'none', gzip: false, langPath: localModelPath }));
    expect(engine.terminate).toHaveBeenCalledTimes(1);
  });
  it('accepts bounded canonical PNG data larger than the upload cap', async () => {
    const pending = service().assess(Buffer.alloc(6 * 1024 * 1024));
    await new Promise(setImmediate);
    worker.emit('message', { text, confidence: 95 });
    await expect(pending).resolves.toMatchObject({ confidence: 95 });
  });
  it('rejects canonical image data exceeding 12 MiB before model IO', async () => {
    await expect(service().assess(Buffer.alloc(12 * 1024 * 1024 + 1))).rejects.toThrow('OCR');
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });
  it('rejects oversized local models before loading them', async () => {
    fs.stat.mockResolvedValueOnce({ isFile: () => true, size: 65 * 1024 * 1024 });
    await expect(service().assess(Buffer.from('image'))).rejects.toThrow('OCR');
    expect(Worker).not.toHaveBeenCalled();
  });
  it.each([{ text, confidence: 84 }, { text, confidence: NaN }, { text: 'x'.repeat(16385), confidence: 99 }, { error: true }])(
    'fails closed on bad OCR output', async (output) => {
      const { pending } = await start();
      worker.emit('message', output);
      await expect(pending).rejects.toThrow('OCR');
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });
  it('refuses parallel requests across service instances immediately', async () => {
    const { pending } = await start();
    await expect(service().assess(Buffer.from('image'))).rejects.toThrow('OCR');
    worker.emit('message', { text, confidence: 95 });
    await pending;
  });
  it('terminates an unresponsive initializer on timeout and allows the next job', async () => {
    jest.useFakeTimers();
    try {
      const pending = service().assess(Buffer.from('image'));
      const rejection = expect(pending).rejects.toThrow('OCR');
      await jest.advanceTimersByTimeAsync(15001);
      await rejection;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
    const { pending } = await start();
    worker.emit('message', { text, confidence: 95 });
    await expect(pending).resolves.toMatchObject({ confidence: 95 });
  });
  it('hides engine errors and terminates on worker failure', async () => {
    const { pending } = await start();
    worker.emit('error', new Error('sensitive-image-text'));
    await expect(pending).rejects.toThrow('Không thể kiểm tra ảnh bằng OCR');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
