import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class StorageHealthService {
  constructor(private readonly config: AppConfigService) {}

  async checkHealth(): Promise<'ok' | 'disabled' | 'error'> {
    const { accountId, accessKeyId, secretAccessKey, bucketName } = this.config.r2;
    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) return 'disabled';
    let client: S3Client | undefined;
    try {
      client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return 'ok';
    } catch {
      return 'error';
    } finally {
      client?.destroy();
    }
  }
}
