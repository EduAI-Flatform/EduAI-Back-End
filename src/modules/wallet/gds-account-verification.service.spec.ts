import * as QRCode from 'qrcode';
import { GdsAccountVerificationService } from './gds-account-verification.service';

jest.mock('qrcode', () => ({ toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,dGVzdA==') }));

const requestId = '12345678-1234-4234-8234-123456789abc';
const now = new Date('2026-11-04T08:00:00.000Z');
function setup() {
  const bank = { code: 'TPB', bin: '970423', name: 'Ngân hàng Tiên Phong', shortName: 'TPBank', lookupSupported: true };
  const row = { id: requestId, ownerId: 'owner', status: 'PROCESSING', processingAdminId: 'admin', bankCode: 'TPB', bankBin: '970423', accountNumber: '00123456789', accountHolder: 'NGUYỄN VĂN A', amountMinor: 123456n };
  const proof = { id: 'proof-id', ownerId: row.ownerId, actorId: 'admin', bankCode: row.bankCode, bankBin: bank.bin, bankName: bank.name, bankShortName: bank.shortName,
    accountNumber: row.accountNumber, accountHolder: 'NGUYEN VAN A', verifiedAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000), purpose: 'TRANSFER', withdrawalId: requestId };
  const prisma = { gdsWithdrawal: { findUnique: jest.fn().mockResolvedValue(row), findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
    gdsAccountVerification: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-proof', ...data })), findUnique: jest.fn().mockResolvedValue({ ...proof, actorId: 'owner', purpose: 'CREATE', withdrawalId: null }), findFirst: jest.fn().mockResolvedValue(proof) } };
  const banks = { get: jest.fn().mockResolvedValue(bank) };
  const provider = { isAvailable: jest.fn().mockReturnValue(true), available: jest.fn().mockReturnValue(true), lookup: jest.fn().mockResolvedValue({ accountHolder: 'NGUYEN VAN A', provider: 'vietqr' }) };
  return { row, proof, prisma, banks, provider, service: new GdsAccountVerificationService(prisma as never, banks as never, provider as never) };
}

/** Independent EMV TLV reader: inspect the encoder input rather than reproducing its builder. */
function tlv(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (let offset = 0; offset < input.length;) {
    const tag = input.slice(offset, offset + 2);
    const length = Number(input.slice(offset + 2, offset + 4));
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(length) || length <= 0 || offset + 4 + length > input.length) throw new Error('Invalid TLV');
    result[tag] = input.slice(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  return result;
}

describe('GDS account verification service trust boundaries', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(now); jest.clearAllMocks(); });
  afterEach(() => jest.useRealTimers());

  it('stores canonical bank facts and provider name with exactly fifteen minutes validity', async () => {
    const { service, prisma, provider } = setup();
    const result = await service.verify('owner', 'TPBank', '00123456789');
    expect(provider.lookup).toHaveBeenCalledWith('970423', '00123456789');
    expect(prisma.gdsAccountVerification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'owner', actorId: 'owner', bankCode: 'TPB', bankBin: '970423', accountNumber: '00123456789', accountHolder: 'NGUYEN VAN A', normalizedAccountHolder: 'NGUYEN VAN A', purpose: 'CREATE', verifiedAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000) }) });
    expect(result).toMatchObject({ verificationId: 'new-proof', bankCode: 'TPB', accountHolder: 'NGUYEN VAN A', verifiedAt: now.toISOString(), expiresAt: '2026-11-04T08:15:00.000Z' });
    expect(result).not.toHaveProperty('providerReference');
  });

  it.each(['provider', 'bank'])('creates no proof when %s does not support lookup', async (unavailable) => {
    const { service, prisma, provider, banks } = setup();
    if (unavailable === 'provider') provider.available.mockReturnValue(false);
    else banks.get.mockResolvedValue({ code: 'TPB', bin: '970423', name: 'Bank', shortName: 'TPBank', lookupSupported: false });
    await expect(service.verify('owner', 'TPB', '00123456789')).rejects.toMatchObject({ status: 503 });
    expect(provider.lookup).not.toHaveBeenCalled();
    expect(prisma.gdsAccountVerification.create).not.toHaveBeenCalled();
  });

  it('does not persist failed provider responses', async () => {
    const { service, prisma, provider } = setup();
    provider.lookup.mockRejectedValue(new Error('service unavailable'));
    await expect(service.verify('owner', 'TPB', '00123456789')).rejects.toThrow('service unavailable');
    expect(prisma.gdsAccountVerification.create).not.toHaveBeenCalled();
  });

  it('resolves only the requested owner/bank/account binding without calling the provider', async () => {
    const { service, prisma, provider } = setup();
    await expect(service.resolve(prisma as never, 'owner', 'TPB', '00123456789', 'proof-id')).resolves.toMatchObject({ purpose: 'CREATE' });
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: 'another-owner' }, { bankCode: 'MB' }, { accountNumber: '99123456789' },
    { purpose: 'TRANSFER' }, { withdrawalId: requestId }, { expiresAt: now },
  ])('rejects an expired or mismatched proof: %j', async (changed) => {
    const { service, prisma, proof } = setup();
    prisma.gdsAccountVerification.findUnique.mockResolvedValue({ ...proof, purpose: 'CREATE', withdrawalId: null, ...changed });
    await expect(service.resolve(prisma as never, 'owner', 'TPB', '00123456789', 'proof-id')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a missing proof', async () => {
    const { service, prisma } = setup();
    prisma.gdsAccountVerification.findUnique.mockResolvedValue(null);
    await expect(service.resolve(prisma as never, 'owner', 'TPB', '00123456789', 'missing')).rejects.toMatchObject({ status: 409 });
  });

  it('compares transfer names without rewriting the original withdrawal', async () => {
    const { service, prisma, row } = setup();
    await expect(service.verifyTransfer('admin', requestId)).resolves.toMatchObject({ status: 'VERIFIED', withdrawalId: requestId, accountHolder: 'NGUYEN VAN A' });
    expect(prisma.gdsAccountVerification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'admin', ownerId: 'owner', purpose: 'TRANSFER', withdrawalId: requestId, bankCode: row.bankCode }) });
    expect(row.accountHolder).toBe('NGUYỄN VĂN A');
  });

  it('rejects a changed beneficiary name without creating transfer evidence', async () => {
    const { service, prisma, provider } = setup();
    provider.lookup.mockResolvedValue({ accountHolder: 'TRAN VAN B', provider: 'vietqr' });
    await expect(service.verifyTransfer('admin', requestId)).rejects.toMatchObject({ status: 409, message: 'GDS_ACCOUNT_HOLDER_MISMATCH' });
    expect(prisma.gdsAccountVerification.create).not.toHaveBeenCalled();
  });

  it.each([{ actor: 'owner', claimant: 'admin' }, { actor: 'admin', claimant: 'another-admin' }])('blocks self or another claimant before lookup: %j', async ({ actor, claimant }) => {
    const { service, row, provider } = setup(); row.processingAdminId = claimant;
    await expect(service.verifyTransfer(actor, requestId)).rejects.toMatchObject({ status: 403 });
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it('rejects unsupported long destination before new or transfer lookup', async () => {
    const { service, row, provider, prisma } = setup();
    row.accountNumber = '0'.repeat(20);
    await expect(service.verify('owner', 'TPB', row.accountNumber)).rejects.toMatchObject({ status: 400, message: 'GDS_ACCOUNT_QR_UNSUPPORTED' });
    await expect(service.verifyTransfer('admin', requestId)).rejects.toMatchObject({ status: 400, message: 'GDS_ACCOUNT_QR_UNSUPPORTED' });
    expect(provider.lookup).not.toHaveBeenCalled();
    expect(prisma.gdsAccountVerification.create).not.toHaveBeenCalled();
  });

  it.each([{ status: 'APPROVED', actor: 'admin' }, { status: 'PAID', actor: 'admin' }, { status: 'PROCESSING', actor: 'other-admin' }, { status: 'PROCESSING', actor: 'owner' }])('does not expose QR for incorrect state or actor: %j', async ({ status, actor }) => {
    const { service, row, prisma } = setup(); row.status = status;
    await expect(service.qr(actor, requestId)).rejects.toMatchObject({ status: 403 });
    expect(prisma.gdsAccountVerification.findFirst).not.toHaveBeenCalled();
    expect(QRCode.toDataURL).not.toHaveBeenCalled();
  });

  it('requires a fresh matching transfer proof for the same claimant and destination', async () => {
    const { service, prisma } = setup();
    prisma.gdsAccountVerification.findFirst.mockResolvedValue(null);
    await expect(service.qr('admin', requestId)).rejects.toMatchObject({ status: 409 });
    expect(prisma.gdsAccountVerification.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { withdrawalId: requestId, actorId: 'admin', ownerId: 'owner', bankCode: 'TPB', accountNumber: '00123456789', purpose: 'TRANSFER', expiresAt: { gt: now } } }));
    expect(QRCode.toDataURL).not.toHaveBeenCalled();
  });

  it('encodes the persisted BIN, account with leading zeroes, exact amount and stable request reference', async () => {
    const { service, row, proof } = setup();
    const result = await service.qr('admin', requestId);
    const payload = (QRCode.toDataURL as jest.Mock).mock.calls[0][0] as string;
    const tags = tlv(payload);
    const merchant = tlv(tags['38']);
    const destination = tlv(merchant['01']);
    expect(destination).toEqual({ '00': proof.bankBin, '01': row.accountNumber });
    expect(merchant['00']).toBe('A000000727');
    expect(merchant['02']).toBe('QRIBFTTA');
    expect(tags['54']).toBe('123456');
    expect(tags['53']).toBe('704');
    expect(tlv(tags['62'])['08']).toBe('GDSW123456781234423482341');
    expect(result).toMatchObject({ withdrawalId: requestId, accountNumber: row.accountNumber, amountMinor: '123456', currency: 'VND', bankBin: proof.bankBin, transferContent: 'GDSW123456781234423482341' });
    expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('withholds a QR if the request becomes terminal while encoding', async () => {
    const { service, prisma, row } = setup();
    prisma.gdsWithdrawal.findUniqueOrThrow.mockResolvedValue({ ...row, status: 'PAID' });
    await expect(service.qr('admin', requestId)).rejects.toMatchObject({ status: 409, message: 'GDS_WITHDRAWAL_QR_EXPIRED' });
  });

  it('withholds a QR if proof expires while encoding', async () => {
    const { service, proof } = setup();
    (QRCode.toDataURL as jest.Mock).mockImplementationOnce(async () => { jest.setSystemTime(proof.expiresAt); return 'data:image/png;base64,dGVzdA=='; });
    await expect(service.qr('admin', requestId)).rejects.toMatchObject({ status: 409, message: 'GDS_WITHDRAWAL_QR_EXPIRED' });
  });
});
