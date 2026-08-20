import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisConfigService } from '../../config/redis-config.service';
import { FirebaseAdminService } from '../firebase/firebase-admin.service';
import { OpenAiService } from '../ai/openai.service';
import { GeminiService } from '../ai/gemini.service';
import { StorageHealthService } from './storage-health.service';

type DependencyStatus = 'ok' | 'disabled' | 'error';
const DEPENDENCY_TIMEOUT_MS = 5_000;

export interface DependencyHealthResponse {
  status: 'ok' | 'degraded';
  dependencies: Record<'database' | 'redis' | 'r2' | 'firebase' | 'openai' | 'gemini', { status: DependencyStatus }>;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisConfigService,
    private readonly storage: StorageHealthService,
    private readonly firebase: FirebaseAdminService,
    private readonly openai: OpenAiService,
    private readonly gemini: GeminiService,
  ) {}

  async checkDependencies(): Promise<DependencyHealthResponse> {
    const [database, redis, r2, firebase, openai, gemini] = await Promise.all([
      this.withTimeout(this.checkDatabase()),
      this.withTimeout(this.redis.checkHealth().then((result) => result.status)),
      this.withTimeout(this.storage.checkHealth()),
      this.withTimeout(this.firebase.checkHealth()),
      this.withTimeout(this.openai.checkHealth()),
      this.withTimeout(this.gemini.checkHealth()),
    ]);
    const statuses = { database, redis, r2, firebase, openai, gemini };
    return {
      status: Object.values(statuses).includes('error') ? 'degraded' : 'ok',
      dependencies: Object.fromEntries(
        Object.entries(statuses).map(([name, status]) => [name, { status }]),
      ) as DependencyHealthResponse['dependencies'],
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async withTimeout(check: Promise<DependencyStatus>): Promise<DependencyStatus> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        check,
        new Promise<DependencyStatus>((resolve) => {
          timeout = setTimeout(() => resolve('error'), DEPENDENCY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
