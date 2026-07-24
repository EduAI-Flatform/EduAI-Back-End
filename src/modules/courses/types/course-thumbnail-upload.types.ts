export interface UploadedCourseThumbnail {
  buffer?: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

export interface StoredCourseThumbnail {
  key: string;
  url: string;
}
