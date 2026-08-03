import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, RoleName } from '../generated/prisma/client';
import { loadBackendEnv } from '../src/config/env.validation';
import { requireDemoSeedPassword } from './demo-contract';
import { seedDemoData } from './demo-seed';

const env = loadBackendEnv();
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const defaultRoles: Array<{ name: RoleName; description: string }> = [
  {
    name: 'student',
    description: 'Default learner role',
  },
  {
    name: 'instructor',
    description: 'Course creator and classroom host role',
  },
  {
    name: 'platform_admin',
    description: 'Platform administration role',
  },
];

async function main(): Promise<void> {
  const demoPassword = process.argv.includes('--demo')
    ? requireDemoSeedPassword(process.env)
    : undefined;

  for (const role of defaultRoles) {
    await prisma.role.upsert({
      where: { name: role.name },
      create: role,
      update: { description: role.description },
    });
  }

  if (demoPassword) {
    await seedDemoData(prisma, demoPassword);
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
