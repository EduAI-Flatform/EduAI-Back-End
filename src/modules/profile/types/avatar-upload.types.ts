export interface UploadedAvatarFile {
  buffer?: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

export interface AvatarUploadResponse {
  avatarUrl: string;
}

export interface StoredAvatar {
  key: string;
  url: string;
}
