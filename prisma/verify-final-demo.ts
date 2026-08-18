import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { loadBackendEnv } from '../src/config/env.validation';
import { requireDemoSeedPassword } from './demo-contract';
import { verifyFinalDemoData } from './final-demo-contract';

const env = loadBackendEnv();
requireDemoSeedPassword(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

verifyFinalDemoData(prisma)
  .then((counts) => process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`))
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
