import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import { StoredAvatar, UploadedAvatarFile } from './types/avatar-upload.types';

export const MAX_AVATAR_FILE_SIZE_BYTES = 2 * 1024 * 1024;

const AVATAR_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class AvatarStorageService {
  constructor(private readonly appConfig: AppConfigService) {}

  async uploadAvatar(file: UploadedAvatarFile): Promise<StoredAvatar> {
    this.validateFile(file);

    const extension = AVATAR_EXTENSIONS_BY_MIME_TYPE[file.mimetype as string];
    const key = `avatars/${randomUUID()}.${extension}`;
    const publicUrl = this.getPublicBaseUrl();

    return {
      key,
      url: `${publicUrl}/${key}`,
    };
  }

  private validateFile(file: UploadedAvatarFile): void {
    if (!file?.buffer?.length || !file.size) {
      throw new BadRequestException('Avatar file is required');
    }

    if (file.size > MAX_AVATAR_FILE_SIZE_BYTES) {
      throw new BadRequestException('Avatar file must be 2MB or smaller');
    }

    if (!file.mimetype || !AVATAR_EXTENSIONS_BY_MIME_TYPE[file.mimetype]) {
      throw new BadRequestException('Avatar file type is not supported');
    }
  }

  private getPublicBaseUrl(): string {
    const publicUrl = this.appConfig.r2.publicUrl?.replace(/\/+$/, '');

    if (publicUrl) {
      return publicUrl;
    }

    if (this.appConfig.app.nodeEnv === 'production') {
      throw new InternalServerErrorException(
        'R2 public URL is required for avatar uploads',
      );
    }

    return 'https://storage.local';
  }
}
