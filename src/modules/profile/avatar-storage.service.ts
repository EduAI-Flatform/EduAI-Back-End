import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import { createPublicMediaUrl } from '../media/public-media-url.util';
import { StoredAvatar, UploadedAvatarFile } from './types/avatar-upload.types';

export const MAX_AVATAR_FILE_SIZE_BYTES = 2 * 1024 * 1024;
export const MAX_PORTFOLIO_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class AvatarStorageService {
  private client?: S3Client;

  constructor(private readonly appConfig: AppConfigService) {}

  uploadAvatar(file: UploadedAvatarFile): Promise<StoredAvatar> {
    return this.uploadImage(file, 'avatars', MAX_AVATAR_FILE_SIZE_BYTES);
  }

  uploadPortfolioImage(file: UploadedAvatarFile): Promise<StoredAvatar> {
    return this.uploadImage(file, 'portfolio-images', MAX_PORTFOLIO_IMAGE_SIZE_BYTES);
  }

  async delete(key: string): Promise<void> {
    const r2 = this.requireStorage();
    await this.getClient(r2.accountId, r2.accessKeyId, r2.secretAccessKey).send(
      new DeleteObjectCommand({ Bucket: r2.bucketName, Key: key }),
    );
  }

  private async uploadImage(
    file: UploadedAvatarFile,
    prefix: 'avatars' | 'portfolio-images',
    maxSize: number,
  ): Promise<StoredAvatar> {
    this.validateFile(file, maxSize);
    const extension = IMAGE_EXTENSIONS_BY_MIME_TYPE[file.mimetype as string];
    const key = `${prefix}/${randomUUID()}.${extension}`;
    const r2 = this.requireStorage();

    await this.getClient(r2.accountId, r2.accessKeyId, r2.secretAccessKey).send(
      new PutObjectCommand({
        Bucket: r2.bucketName,
        Key: key,
        Body: file.buffer,
        ContentLength: file.size,
        ContentType: file.mimetype,
      }),
    );

    return { key, url: createPublicMediaUrl(key) };
  }

  private validateFile(file: UploadedAvatarFile, maxSize: number): void {
    if (!file?.buffer?.length || !file.size) {
      throw new BadRequestException('Image file is required');
    }
    if (file.size > maxSize) {
      throw new BadRequestException(`Image file must be ${maxSize / 1024 / 1024}MB or smaller`);
    }
    if (!file.mimetype || !IMAGE_EXTENSIONS_BY_MIME_TYPE[file.mimetype]) {
      throw new BadRequestException('Image file type is not supported');
    }
    if (!this.hasValidImageSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException('Image file content is invalid');
    }
  }

  private hasValidImageSignature(buffer: Buffer, mimetype: string): boolean {
    if (mimetype === 'image/jpeg') {
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimetype === 'image/png') {
      return buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }

  private requireStorage() {
    const r2 = this.appConfig.r2;
    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey || !r2.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured for public image uploads');
    }
    return {
      accountId: r2.accountId,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      bucketName: r2.bucketName,
    };
  }

  private getClient(accountId: string, accessKeyId: string, secretAccessKey: string): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        region: 'auto',
        credentials: { accessKeyId, secretAccessKey },
      });
    }
    return this.client;
  }
}
