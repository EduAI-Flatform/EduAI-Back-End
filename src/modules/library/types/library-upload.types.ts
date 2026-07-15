export interface UploadedLibraryFile {
  buffer?: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

export interface StoredLibraryFile {
  key: string;
  url: string;
}
