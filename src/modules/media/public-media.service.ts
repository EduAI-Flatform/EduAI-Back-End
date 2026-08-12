import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { parsePublicMediaToken } from './public-media-url.util';

const PUBLIC_MEDIA_URL_EXPIRY_SECONDS = 5 * 60;

@Injectable()
export class PublicMediaService {
  private client?: S3Client;

  constructor(private readonly appConfig: AppConfigService) {}

  async createRedirectUrl(token: string): Promise<string> {
    const storageKey = parsePublicMediaToken(token);
    if (!storageKey) throw new NotFoundException('Public media not found');
    const { bucketName, client } = this.requireStorage();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucketName, Key: storageKey }),
      { expiresIn: PUBLIC_MEDIA_URL_EXPIRY_SECONDS },
    );
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
