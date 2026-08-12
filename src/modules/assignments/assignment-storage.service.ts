import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import {
  StoredAssignmentFile,
  UploadedAssignmentFile,
} from './types/assignment-upload.types';

export const MAX_ASSIGNMENT_FILE_SIZE_BYTES = 20 * 1024 * 1024;

const FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface AssignmentFilePolicy {
  allowedMimeTypes?: string[];
  maxFileSizeBytes?: number;
}

@Injectable()
export class AssignmentStorageService {
  private client?: S3Client;

  constructor(private readonly appConfig: AppConfigService) {}

  async upload(
    file: UploadedAssignmentFile | undefined,
    policy?: AssignmentFilePolicy,
  ): Promise<StoredAssignmentFile> {
    this.validate(file, policy);
    const mimetype = file!.mimetype!;
    const key = `assignments/${randomUUID()}.${FILE_TYPES[mimetype]}`;
    const r2 = this.appConfig.r2;

    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey || !r2.bucketName) {
      if (this.appConfig.app.nodeEnv === 'production') {
        throw new InternalServerErrorException('R2 storage is not configured');
      }
      return { key };
    }

    await this.clientFor(r2.accountId, r2.accessKeyId, r2.secretAccessKey).send(
      new PutObjectCommand({
        Bucket: r2.bucketName,
        Key: key,
        Body: file!.buffer,
        ContentLength: file!.size,
        ContentType: mimetype,
      }),
    );

    return { key };
  }

  async createDownloadUrl(key: string): Promise<string> {
    const r2 = this.appConfig.r2;
    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey || !r2.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured');
    }
    return getSignedUrl(
      this.clientFor(r2.accountId, r2.accessKeyId, r2.secretAccessKey),
      new GetObjectCommand({ Bucket: r2.bucketName, Key: key }),
      { expiresIn: 300 },
    );
  }

  private validate(
    file: UploadedAssignmentFile | undefined,
    policy?: AssignmentFilePolicy,
  ): void {
    if (!file?.buffer?.length || !file.size) {
      throw new BadRequestException('Assignment file is required');
    }
    const maxFileSizeBytes = Math.min(
      policy?.maxFileSizeBytes ?? MAX_ASSIGNMENT_FILE_SIZE_BYTES,
      MAX_ASSIGNMENT_FILE_SIZE_BYTES,
    );
    if (file.size > maxFileSizeBytes) {
      throw new BadRequestException('Assignment file must be 20MB or smaller');
    }
    if (
      !file.mimetype ||
      !FILE_TYPES[file.mimetype] ||
      (policy?.allowedMimeTypes?.length && !policy.allowedMimeTypes.includes(file.mimetype))
    ) {
      throw new BadRequestException('Assignment file type is not supported');
    }
    if (!this.hasValidSignature(file.buffer, file.mimetype)) {
      throw new BadRequestException('Assignment file content is invalid');
    }
  }

  private hasValidSignature(buffer: Buffer, mimetype: string): boolean {
    if (mimetype === 'application/pdf') {
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    }
    if (mimetype === 'image/jpeg') {
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimetype === 'image/png') {
      return buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    return buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'PK\x03\x04';
  }

  private clientFor(accountId: string, accessKeyId: string, secretAccessKey: string): S3Client {
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
