import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { loadBackendEnv } from '../src/config/env.validation';
import { verifyDemoData } from './demo-contract';

const env = loadBackendEnv();
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const result = await verifyDemoData(prisma);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
