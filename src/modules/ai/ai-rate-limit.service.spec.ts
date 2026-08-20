import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { AiRateLimitService } from './ai-rate-limit.service';

describe('AiRateLimitService', () => {
  it('enforces the daily limit when Redis is unavailable', async () => {
    const service = new AiRateLimitService(
      { getClient: () => undefined } as never,
      { app: { nodeEnv: 'test' } } as never,
    );
    for (let index = 0; index < 30; index += 1) await service.assertChatAllowed('rate-limit-test-user');
    try {
      await service.assertChatAllowed('rate-limit-test-user');
      fail('Expected the daily AI chat limit to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('fails closed without Redis in production', async () => {
    const service = new AiRateLimitService(
      { getClient: () => undefined } as never,
      { app: { nodeEnv: 'production' } } as never,
    );

    await expect(service.assertChatAllowed('user-id')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('uses an atomic Redis increment with expiry', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) };
    const service = new AiRateLimitService(
      { getClient: () => redis } as never,
      { app: { nodeEnv: 'production' } } as never,
    );

    await expect(service.assertSummaryAllowed('user-id')).resolves.toBeUndefined();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/^ai:summary:[a-f0-9]{64}:\d{4}-\d{2}-\d{2}$/),
      expect.any(Number),
    );
  });
});
