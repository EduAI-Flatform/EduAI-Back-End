export interface UploadedAssignmentFile {
  buffer?: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

export interface StoredAssignmentFile {
  key: string;
  url: string;
}
