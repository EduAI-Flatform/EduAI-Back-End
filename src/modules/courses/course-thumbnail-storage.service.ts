import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import {
  StoredCourseThumbnail,
  UploadedCourseThumbnail,
} from './types/course-thumbnail-upload.types';

export const MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class CourseThumbnailStorageService {
  private client?: S3Client;

  constructor(private readonly appConfig: AppConfigService) {}

  async uploadThumbnail(
    file: UploadedCourseThumbnail | undefined,
  ): Promise<StoredCourseThumbnail> {
    this.validateFile(file);

    const r2 = this.appConfig.r2;
    if (
      !r2.accountId ||
      !r2.accessKeyId ||
      !r2.secretAccessKey ||
      !r2.bucketName ||
      !r2.publicUrl
    ) {
      throw new InternalServerErrorException(
        'R2 storage is not configured for course thumbnails',
      );
    }

    const mimetype = file!.mimetype!;
    const key = `course-thumbnails/${randomUUID()}.${
      EXTENSIONS_BY_MIME_TYPE[mimetype]
    }`;

    await this.getClient(
      r2.accountId,
      r2.accessKeyId,
      r2.secretAccessKey,
    ).send(
      new PutObjectCommand({
        Bucket: r2.bucketName,
        Key: key,
        Body: file!.buffer,
        ContentLength: file!.size,
        ContentType: mimetype,
      }),
    );

    return {
      key,
      url: `${r2.publicUrl.replace(/\/+$/, '')}/${key}`,
    };
  }

  private validateFile(file: UploadedCourseThumbnail | undefined): void {
    if (!file?.buffer?.length || !file.size) {
      throw new BadRequestException('Course thumbnail file is required');
    }

    if (file.size > MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        'Course thumbnail file must be 5MB or smaller',
      );
    }

    if (!file.mimetype || !EXTENSIONS_BY_MIME_TYPE[file.mimetype]) {
      throw new BadRequestException(
        'Course thumbnail file type is not supported',
      );
    }

    if (!this.hasValidImageSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException(
        'Course thumbnail file content is invalid',
      );
    }
  }

  private hasValidImageSignature(buffer: Buffer, mimetype: string): boolean {
    if (mimetype === 'image/jpeg') {
      return (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      );
    }

    if (mimetype === 'image/png') {
      return (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
      );
    }

    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }

  private getClient(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
  ): S3Client {
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
