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
  };
  openai: {
    apiKey?: string;
    model?: string;
    embeddingModel?: string;
  };
  ai: {
    provider: ValidatedEnv['AI_PROVIDER'];
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
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
    },
    ai: {
      provider: env.AI_PROVIDER,
    },
  };
}
