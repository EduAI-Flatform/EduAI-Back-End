import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { loadBackendEnv } from '../src/config/env.validation';
import {
  assertMinimalFixtureEnvironment,
  seedMinimalCourseFixtures,
} from './minimal-course-fixtures';

assertMinimalFixtureEnvironment(process.env);
const env = loadBackendEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

seedMinimalCourseFixtures(prisma)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
