import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, RoleName } from '../generated/prisma/client';
import { loadBackendEnv } from '../src/config/env.validation';

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
  for (const role of defaultRoles) {
    await prisma.role.upsert({
      where: { name: role.name },
      create: role,
      update: { description: role.description },
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
