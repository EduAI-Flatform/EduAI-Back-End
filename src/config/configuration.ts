import {
  loadBackendEnv,
  NodeEnvironment,
  ValidatedEnv,
} from './env.validation';

export interface BackendConfig {
  app: {
    nodeEnv: NodeEnvironment;
    port: number;
    publicAppUrl?: string;
  };
  database: {
    url: string;
  };
  redis: {
    url?: string;
  };
  jwt: {
    accessSecret?: string;
    refreshSecret?: string;
  };
  firebase: {
    projectId?: string;
    clientEmail?: string;
    privateKey?: string;
  };
  r2: {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucketName?: string;
    publicUrl?: string;
    maxVideoUploadSize: number;
    maxDocumentUploadSize: number;
  };
  openai: {
    apiKey?: string;
    model?: string;
    embeddingModel?: string;
  };
  gemini: {
    apiKey?: string;
    model?: string;
    embeddingModel?: string;
  };
  ai: {
    provider: ValidatedEnv['AI_PROVIDER'];
    timeoutMs: number;
    maxRetries: number;
  };
  email: {
    provider: ValidatedEnv['EMAIL_PROVIDER'];
    from?: string;
    resendApiKey?: string;
  };
  monitoring: {
    enabled: boolean;
    endpoint?: string;
  };
}

export default function configuration(): BackendConfig {
  const env = loadBackendEnv();

  return {
    app: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      publicAppUrl: env.PUBLIC_APP_URL,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
    },
    firebase: {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY,
    },
    r2: {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucketName: env.R2_BUCKET_NAME,
      publicUrl: env.R2_PUBLIC_URL,
      maxVideoUploadSize: env.MAX_VIDEO_UPLOAD_SIZE,
      maxDocumentUploadSize: env.MAX_DOCUMENT_UPLOAD_SIZE,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
    },
    gemini: {
      apiKey:
        env.GEMINI_API_KEY ??
        (env.AI_PROVIDER === 'gemini' ? env.AI_API_KEY : undefined),
      model:
        env.GEMINI_MODEL ??
        (env.AI_PROVIDER === 'gemini' ? env.AI_MODEL : undefined),
      embeddingModel:
        env.GEMINI_EMBEDDING_MODEL ??
        (env.AI_PROVIDER === 'gemini' ? env.AI_EMBEDDING_MODEL : undefined),
    },
    ai: {
      provider: env.AI_PROVIDER,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxRetries: env.AI_MAX_RETRIES,
    },
    email: {
      provider: env.EMAIL_PROVIDER,
      from: env.EMAIL_FROM,
      resendApiKey: env.RESEND_API_KEY,
    },
    monitoring: {
      enabled: env.MONITORING_ENABLED,
      endpoint: env.MONITORING_ENDPOINT,
    },
  };
}
