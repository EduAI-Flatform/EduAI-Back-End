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
    corsAllowedOrigins: string[];
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
  oauth: {
    stateSecret?: string;
    frontendCallbackUrl?: string;
    stateTtlSeconds: number;
    ticketTtlSeconds: number;
    httpTimeoutMs: number;
    facebook: {
      enabled: boolean;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      graphApiVersion?: string;
    };
    zalo: {
      enabled: boolean;
      appId?: string;
      appSecret?: string;
      redirectUri?: string;
      authVersion?: string;
      graphApiVersion: string;
      scopes: string[];
    };
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
  commerce: {
    idempotencySecret?: string;
  };
  payos: {
    environment: ValidatedEnv['PAYOS_ENVIRONMENT'];
    clientId?: string;
    apiKey?: string;
    checksumKey?: string;
    apiBaseUrl: string;
    returnUrl?: string;
    cancelUrl?: string;
    webhookUrl?: string;
    timeoutMs: number;
  };
}

export default function configuration(): BackendConfig {
  const env = loadBackendEnv();

  return {
    app: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      publicAppUrl: env.PUBLIC_APP_URL,
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
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
    oauth: {
      stateSecret: env.OAUTH_STATE_SECRET,
      frontendCallbackUrl: env.OAUTH_FRONTEND_CALLBACK_URL,
      stateTtlSeconds: env.OAUTH_STATE_TTL_SECONDS,
      ticketTtlSeconds: env.OAUTH_TICKET_TTL_SECONDS,
      httpTimeoutMs: env.OAUTH_HTTP_TIMEOUT_MS,
      facebook: {
        enabled: env.FACEBOOK_OAUTH_ENABLED,
        clientId: env.FACEBOOK_CLIENT_ID,
        clientSecret: env.FACEBOOK_CLIENT_SECRET,
        redirectUri: env.FACEBOOK_REDIRECT_URI,
        graphApiVersion: env.FACEBOOK_GRAPH_API_VERSION,
      },
      zalo: {
        enabled: env.ZALO_OAUTH_ENABLED,
        appId: env.ZALO_APP_ID,
        appSecret: env.ZALO_APP_SECRET,
        redirectUri: env.ZALO_REDIRECT_URI,
        authVersion: env.ZALO_AUTH_VERSION,
        graphApiVersion: env.ZALO_GRAPH_API_VERSION,
        scopes: env.ZALO_OAUTH_SCOPES,
      },
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
    commerce: {
      idempotencySecret: env.COMMERCE_IDEMPOTENCY_SECRET,
    },
    payos: {
      environment: env.PAYOS_ENVIRONMENT,
      clientId: env.PAYOS_CLIENT_ID,
      apiKey: env.PAYOS_API_KEY,
      checksumKey: env.PAYOS_CHECKSUM_KEY,
      apiBaseUrl: env.PAYOS_API_BASE_URL,
      returnUrl: env.PAYOS_RETURN_URL,
      cancelUrl: env.PAYOS_CANCEL_URL,
      webhookUrl: env.PAYOS_WEBHOOK_URL,
      timeoutMs: env.PAYOS_TIMEOUT_MS,
    },
  };
}
