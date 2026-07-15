import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import { StoredLibraryFile, UploadedLibraryFile } from './types/library-upload.types';

export const MAX_LIBRARY_FILE_SIZE_BYTES = 50 * 1024 * 1024;

const MIME_TYPES_BY_RESOURCE_TYPE: Record<string, string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  video: ['video/mp4'],
  image: ['image/jpeg', 'image/png', 'image/webp'],
};

const EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'video/mp4': 'mp4',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class LibraryR2StorageService {
  private client?: S3Client;

  constructor(private readonly appConfig: AppConfigService) {}

  async uploadResource(
    file: UploadedLibraryFile | undefined,
    resourceType: string,
  ): Promise<StoredLibraryFile> {
    this.validateFile(file, resourceType);

    const mimetype = file!.mimetype!;
    const key = `documents/${randomUUID()}.${EXTENSIONS_BY_MIME_TYPE[mimetype]}`;
    const r2 = this.appConfig.r2;

    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey || !r2.bucketName) {
      if (this.appConfig.app.nodeEnv === 'production') {
        throw new InternalServerErrorException('R2 storage is not configured');
      }
      return { key, url: `${this.getPublicBaseUrl()}/${key}` };
    }

    await this.getClient(r2.accountId, r2.accessKeyId, r2.secretAccessKey).send(
      new PutObjectCommand({
        Bucket: r2.bucketName,
        Key: key,
        Body: file!.buffer,
        ContentLength: file!.size,
        ContentType: mimetype,
      }),
    );

    return { key, url: `${this.getPublicBaseUrl()}/${key}` };
  }

  private validateFile(file: UploadedLibraryFile | undefined, resourceType: string): void {
    if (!file?.buffer?.length || !file.size) {
      throw new BadRequestException('Resource file is required');
    }

    if (file.size > MAX_LIBRARY_FILE_SIZE_BYTES) {
      throw new BadRequestException('Resource file must be 50MB or smaller');
    }

    const allowedMimeTypes = MIME_TYPES_BY_RESOURCE_TYPE[resourceType];
    if (!allowedMimeTypes || !file.mimetype || !allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Resource file type is not supported');
    }
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

  private getPublicBaseUrl(): string {
    const publicUrl = this.appConfig.r2.publicUrl?.replace(/\/+$/, '');

    if (publicUrl) return publicUrl;
    if (this.appConfig.app.nodeEnv === 'production') {
      throw new InternalServerErrorException('R2 public URL is required for resource uploads');
    }

    return 'https://storage.local';
  }
}
