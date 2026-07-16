import { Injectable } from '@nestjs/common';

@Injectable()
export class AiRateLimitService {
  /**
   * Hook for the documented per-user AI quota. Redis-backed enforcement belongs
   * to the rate-limit slice and is intentionally not implemented here.
   */
  async assertChatAllowed(_userId: string): Promise<void> {
    return undefined;
  }
}
