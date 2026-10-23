import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
const sharp: typeof import('sharp').default = require('sharp');

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const MAX_RECEIPT_PIXELS = 12_000_000;
export interface ReceiptImageUpload { buffer: Buffer; size: number; mimetype: string }
export interface DecodedReceiptImage { buffer: Buffer; originalSha256: string; imageSha256: string; width: number; height: number }
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Never serves the original upload. Only bounded, decoded, metadata-free PNG is retained. */
export async function decodeReceiptImage(file: ReceiptImageUpload | undefined): Promise<DecodedReceiptImage> {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.size !== file.buffer.length
      || file.size > MAX_RECEIPT_BYTES) throw new BadRequestException('RECEIPT_IMAGE_SIZE_INVALID');
  const isPng = file.mimetype === 'image/png' && file.buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg = file.mimetype === 'image/jpeg' && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  if (!isPng && !isJpeg) throw new BadRequestException('RECEIPT_IMAGE_INVALID');
  try {
    const image = sharp(file.buffer, { failOn: 'warning', limitInputPixels: MAX_RECEIPT_PIXELS, animated: false });
    const meta = await image.metadata();
    if (meta.format !== (isPng ? 'png' : 'jpeg') || !meta.width || !meta.height || (meta.pages ?? 1) !== 1
        || meta.width > 8192 || meta.height > 8192 || meta.width * meta.height > MAX_RECEIPT_PIXELS) throw new Error('invalid dimensions');
    const { data, info } = await image.rotate().flatten({ background: '#ffffff' }).toColourspace('srgb')
      .removeAlpha().png({ compressionLevel: 9, adaptiveFiltering: false }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    if (data.length > 12 * 1024 * 1024) throw new Error('canonical image too large');
    return { buffer: data, originalSha256: sha256(file.buffer), imageSha256: sha256(data), width: info.width, height: info.height };
  } catch {
    throw new BadRequestException('RECEIPT_IMAGE_INVALID');
  }
}
