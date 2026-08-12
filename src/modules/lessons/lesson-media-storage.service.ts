import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import {
  LessonMediaReference,
  UploadedLessonDocument,
  VideoUploadAuthorization,
} from './types/lesson-media-upload.types';

export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
export const MAX_VIDEO_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_LESSON_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;
const VIDEO_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const VIDEO_UPLOAD_EXPIRY_SECONDS = 15 * 60;
const MEDIA_DOWNLOAD_EXPIRY_SECONDS = 5 * 60;

@Injectable()
export class LessonMediaStorageService {
  private client?: S3Client;

  constructor(private readonly appConfig: AppConfigService) {}

  async authorizeVideoUpload(
    courseId: string,
    mimeType: string,
    size: number,
  ): Promise<VideoUploadAuthorization> {
    this.validateVideo(mimeType, size);
    const key = `lessons/${courseId}/videos/${randomUUID()}.${VIDEO_EXTENSIONS[mimeType]}`;
    const { bucketName, client } = this.requireStorage();
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentLength: size,
        ContentType: mimeType,
      }),
      { expiresIn: VIDEO_UPLOAD_EXPIRY_SECONDS },
    );

    return {
      storageKey: key,
      uploadUrl,
      expiresInSeconds: VIDEO_UPLOAD_EXPIRY_SECONDS,
      requiredHeaders: { 'Content-Type': mimeType },
    };
  }

  async finalizeVideoUpload(
    courseId: string,
    storageKey: string,
    mimeType: string,
    size: number,
  ): Promise<LessonMediaReference> {
    this.validateVideo(mimeType, size);
    this.assertOwnedKey(courseId, storageKey, 'videos');
    await this.assertObject(storageKey, mimeType, size);
    return { storageKey };
  }

  async uploadDocument(
    courseId: string,
    file: UploadedLessonDocument | undefined,
  ): Promise<LessonMediaReference> {
    this.validateDocument(file);
    const key = `lessons/${courseId}/documents/${randomUUID()}.pdf`;
    const { bucketName, client } = this.requireStorage();
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: file!.buffer,
        ContentLength: file!.size,
        ContentType: 'application/pdf',
      }),
    );
    return { storageKey: key };
  }

  async assertLessonMedia(
    courseId: string,
    storageKey: string,
    kind: 'videos' | 'documents',
  ): Promise<void> {
    this.assertOwnedKey(courseId, storageKey, kind);
    const expectedType = kind === 'documents' ? 'application/pdf' : undefined;
    await this.assertObject(storageKey, expectedType);
  }

  async createDownloadUrl(storageKey: string): Promise<string> {
    const { bucketName, client } = this.requireStorage();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucketName, Key: storageKey }),
      { expiresIn: MEDIA_DOWNLOAD_EXPIRY_SECONDS },
    );
  }

  async delete(storageKey: string): Promise<void> {
    const { bucketName, client } = this.requireStorage();
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: storageKey }));
  }

  async discard(courseId: string, storageKey: string): Promise<void> {
    const kind = storageKey.includes('/videos/') ? 'videos' : 'documents';
    this.assertOwnedKey(courseId, storageKey, kind);
    await this.delete(storageKey);
  }

  private validateVideo(mimeType: string, size: number): void {
    if (!VIDEO_MIME_TYPES.includes(mimeType as (typeof VIDEO_MIME_TYPES)[number])) {
      throw new BadRequestException('Lesson video type is not supported');
    }
    const configuredMax = Math.min(
      this.appConfig.r2.maxVideoUploadSize ?? MAX_VIDEO_UPLOAD_SIZE_BYTES,
      MAX_VIDEO_UPLOAD_SIZE_BYTES,
    );
    if (!Number.isSafeInteger(size) || size < 1 || size > configuredMax) {
      throw new BadRequestException('Lesson video exceeds the maximum upload size');
    }
  }

  private validateDocument(file: UploadedLessonDocument | undefined): void {
    if (!file?.buffer?.length || !file.size) {
      throw new BadRequestException('Lesson document file is required');
    }
    const configuredMax = Math.min(
      this.appConfig.r2.maxDocumentUploadSize ?? MAX_LESSON_DOCUMENT_SIZE_BYTES,
      MAX_LESSON_DOCUMENT_SIZE_BYTES,
    );
    if (file.size > configuredMax) {
      throw new BadRequestException('Lesson document must be 50MB or smaller');
    }
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Lesson document must be a PDF');
    }
    if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new BadRequestException('Lesson document content is invalid');
    }
  }

  private assertOwnedKey(courseId: string, storageKey: string, kind: string): void {
    const pattern = new RegExp(
      `^lessons/${courseId}/${kind}/[0-9a-f-]{36}\\.(?:mp4|webm|mov|pdf)$`,
    );
    if (!pattern.test(storageKey)) {
      throw new BadRequestException('Lesson media key is invalid');
    }
  }

  private async assertObject(
    storageKey: string,
    expectedType?: string,
    expectedSize?: number,
  ): Promise<void> {
    const { bucketName, client } = this.requireStorage();
    try {
      const object = await client.send(
        new HeadObjectCommand({ Bucket: bucketName, Key: storageKey }),
      );
      if (
        (expectedType && object.ContentType !== expectedType) ||
        (expectedSize !== undefined && object.ContentLength !== expectedSize)
      ) {
        throw new BadRequestException('Uploaded lesson media does not match authorization');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Uploaded lesson media was not found');
    }
  }

  private requireStorage(): { bucketName: string; client: S3Client } {
    const r2 = this.appConfig.r2;
    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey || !r2.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured');
    }
    if (!this.client) {
      this.client = new S3Client({
        endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
        region: 'auto',
        credentials: {
          accessKeyId: r2.accessKeyId,
          secretAccessKey: r2.secretAccessKey,
        },
      });
    }
    return { bucketName: r2.bucketName, client: this.client };
  }
}
