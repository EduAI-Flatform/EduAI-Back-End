import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { loadBackendEnv } from './src/config/env.validation';

const env = loadBackendEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: env.DATABASE_URL,
  },
});
