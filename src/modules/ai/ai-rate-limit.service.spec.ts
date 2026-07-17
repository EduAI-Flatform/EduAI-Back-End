import { HttpException, HttpStatus } from '@nestjs/common';
import { AiRateLimitService } from './ai-rate-limit.service';

describe('AiRateLimitService', () => {
  it('enforces the daily limit when Redis is unavailable', async () => {
    const service = new AiRateLimitService({ getClient: () => undefined } as never);
    for (let index = 0; index < 30; index += 1) await service.assertChatAllowed('rate-limit-test-user');
    try {
      await service.assertChatAllowed('rate-limit-test-user');
      fail('Expected the daily AI chat limit to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });
});
