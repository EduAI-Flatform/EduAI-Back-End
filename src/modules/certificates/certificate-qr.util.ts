import * as QRCode from 'qrcode';

export function generateCertificateQrCode(verificationUrl: string): Promise<string> {
  return QRCode.toDataURL(verificationUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    type: 'image/png',
  });
}
