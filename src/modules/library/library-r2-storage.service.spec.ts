import { BadRequestException } from '@nestjs/common';
import { LibraryR2StorageService } from './library-r2-storage.service';

function createService() {
  return new LibraryR2StorageService({
    app: { nodeEnv: 'test' },
    r2: { publicUrl: 'https://cdn.example.com' },
  } as never);
}

describe('LibraryR2StorageService', () => {
  it('generates a server-side document key and public URL', async () => {
    const service = createService();

    await expect(
      service.uploadResource(
        {
          buffer: Buffer.from('pdf'),
          mimetype: 'application/pdf',
          originalname: '../../unsafe.pdf',
          size: 3,
        },
        'pdf',
      ),
    ).resolves.toEqual({
      key: expect.stringMatching(/^documents\/[0-9a-f-]{36}\.pdf$/),
      url: expect.stringMatching(/^https:\/\/cdn\.example\.com\/documents\/[0-9a-f-]{36}\.pdf$/),
    });
  });

  it('rejects a MIME type that does not match the declared resource type', async () => {
    const service = createService();

    await expect(
      service.uploadResource(
        { buffer: Buffer.from('script'), mimetype: 'application/javascript', size: 6 },
        'pdf',
      ),
    ).rejects.toEqual(new BadRequestException('Resource file type is not supported'));
  });

  it('rejects oversized files', async () => {
    const service = createService();

    await expect(
      service.uploadResource(
        { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', size: 50 * 1024 * 1024 + 1 },
        'pdf',
      ),
    ).rejects.toEqual(new BadRequestException('Resource file must be 50MB or smaller'));
  });
});
