import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { loadBackendEnv } from './src/config/env.validation';

const env = loadBackendEnv();
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: migrationDatabaseUrl || env.DATABASE_URL,
  },
});
