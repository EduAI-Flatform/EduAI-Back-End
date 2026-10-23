const sharp: typeof import('sharp').default = require('sharp');
import { decodeReceiptImage } from './bank-transfer-receipt-image';

describe('isolated receipt image decoding', () => {
  const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).png().toBuffer();
  it('decodes/re-encodes PNG and records byte/canonical hashes', async () => {
    const buffer = await png();
    const result = await decodeReceiptImage({ buffer, size: buffer.length, mimetype: 'image/png' });
    expect(result.width).toBe(40); expect(result.height).toBe(30);
    expect(result.originalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.imageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await sharp(result.buffer).metadata()).format).toBe('png');
  });
  it('canonicalizes PNG recompression for replay detection', async () => {
    const first = await png(); const second = await sharp(first).png({ compressionLevel: 0 }).toBuffer();
    const a = await decodeReceiptImage({ buffer: first, size: first.length, mimetype: 'image/png' });
    const b = await decodeReceiptImage({ buffer: second, size: second.length, mimetype: 'image/png' });
    expect(a.originalSha256).not.toBe(b.originalSha256); expect(a.imageSha256).toBe(b.imageSha256);
  });
  it('accepts a real JPEG and removes metadata/trailing payload', async () => {
    const jpeg = await sharp(await png()).jpeg().withExif({ IFD0: { Artist: 'SYNTHETIC' } }).toBuffer();
    const buffer = Buffer.concat([jpeg, Buffer.from('<script>synthetic</script>')]);
    const result = await decodeReceiptImage({ buffer, size: buffer.length, mimetype: 'image/jpeg' });
    expect(result.buffer.includes(Buffer.from('<script>'))).toBe(false);
    expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
  });
  it('rejects MIME spoofing before the decoder', async () => {
    const buffer = await png();
    await expect(decodeReceiptImage({ buffer, size: buffer.length, mimetype: 'image/jpeg' })).rejects.toThrow('RECEIPT_IMAGE_INVALID');
  });
  it('rejects truncated images even with a correct signature', async () => {
    const buffer = (await png()).subarray(0, 32);
    await expect(decodeReceiptImage({ buffer, size: buffer.length, mimetype: 'image/png' })).rejects.toThrow('RECEIPT_IMAGE_INVALID');
  });
  it('rejects SVG, empty, size mismatch, and files above 5 MiB', async () => {
    for (const file of [undefined, {buffer:Buffer.from('<svg/>'),size:6,mimetype:'image/svg+xml'},
      {buffer:Buffer.alloc(1),size:2,mimetype:'image/png'}, {buffer:Buffer.alloc(5*1024*1024+1),size:5*1024*1024+1,mimetype:'image/png'}]) {
      await expect(decodeReceiptImage(file)).rejects.toThrow();
    }
  });
  it('rejects pixel bombs before rasterization', async () => {
    const buffer = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await expect(decodeReceiptImage({ buffer, size: buffer.length, mimetype: 'image/png' })).rejects.toThrow('RECEIPT_IMAGE_INVALID');
  });
});
