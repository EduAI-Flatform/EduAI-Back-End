import { generateCertificateQrCode } from './certificate-qr.util';

describe('generateCertificateQrCode', () => {
  it('returns a PNG data URL for the verification route', async () => {
    const result = await generateCertificateQrCode(
      '/api/v1/certificates/verify/CERT-abc123',
    );

    expect(result).toMatch(/^data:image\/png;base64,/);
  });
});
