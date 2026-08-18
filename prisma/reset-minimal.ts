import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { loadBackendEnv } from '../src/config/env.validation';
import {
  assertMinimalFixtureEnvironment,
  resetMinimalCourseFixtures,
} from './minimal-course-fixtures';

assertMinimalFixtureEnvironment(process.env);
const env = loadBackendEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

resetMinimalCourseFixtures(prisma)
  .then(() => process.stdout.write('Minimal Sprint 21 fixtures reset.\n'))
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
