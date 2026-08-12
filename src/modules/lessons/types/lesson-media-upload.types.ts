export interface UploadedLessonDocument {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
  size: number;
}

export interface LessonMediaReference {
  storageKey: string;
}

export interface VideoUploadAuthorization extends LessonMediaReference {
  uploadUrl: string;
  expiresInSeconds: number;
  requiredHeaders: { 'Content-Type': string };
}
