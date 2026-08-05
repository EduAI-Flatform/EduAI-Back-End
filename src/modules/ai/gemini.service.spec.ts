import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { GeminiService } from './gemini.service';

function createConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  return {
    gemini: {
      apiKey: 'gemini-secret',
      model: 'gemini-model',
      embeddingModel: 'gemini-embedding-model',
    },
    ai: { provider: 'gemini', timeoutMs: 60000, maxRetries: 0 },
    ...overrides,
  } as AppConfigService;
}

function createClient() {
  return {
    models: {
      generateContent: jest.fn(),
      embedContent: jest.fn(),
    },
  };
}

describe('GeminiService', () => {
  it('reads the Gemini key and model from config and reuses one client', () => {
    const service = new GeminiService(createConfig());

    expect(service.isConfigured()).toBe(true);
    expect(service.getModel()).toBe('gemini-model');
    expect(service.getEmbeddingModel()).toBe('gemini-embedding-model');
    expect(service.getClient()).toBe(service.getClient());
  });

  it('fails without a Gemini key or model without exposing secrets', () => {
    const missingKey = new GeminiService(
      createConfig({ gemini: { model: 'gemini-model' } }),
    );
    const missingModel = new GeminiService(
      createConfig({ gemini: { apiKey: 'gemini-secret' } }),
    );

    expect(() => missingKey.getClient()).toThrow(ServiceUnavailableException);
    expect(() => missingKey.getClient()).not.toThrow('gemini-secret');
    expect(() => missingModel.getModel()).toThrow(ServiceUnavailableException);
  });

  it('maps a successful text request to the existing provider contract', async () => {
    const service = new GeminiService(createConfig());
    const client = createClient();
    client.models.generateContent.mockResolvedValue({
      text: 'Hello from Gemini',
      usageMetadata: { totalTokenCount: 12 },
    });
    jest.spyOn(service, 'getClient').mockReturnValue(client as never);

    await expect(
      service.complete({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    ).resolves.toEqual({ content: 'Hello from Gemini', totalTokens: 12 });

    expect(client.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-model',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: expect.objectContaining({
          systemInstruction: 'Be concise.',
        }),
      }),
    );
  });

  it('uses Gemini structured output settings and maps embeddings', async () => {
    const service = new GeminiService(createConfig());
    const client = createClient();
    client.models.generateContent.mockResolvedValue({ text: '{"items":[]}' });
    client.models.embedContent.mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
    });
    jest.spyOn(service, 'getClient').mockReturnValue(client as never);

    await service.complete({
      json: true,
      responseSchema: { type: 'object', properties: { items: { type: 'array' } } },
      messages: [{ role: 'user', content: 'Return JSON.' }],
    });
    await expect(service.embed(['one', 'two'])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    expect(client.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          responseSchema: expect.any(Object),
        }),
      }),
    );
    expect(client.models.embedContent).toHaveBeenCalledWith({
      model: 'gemini-embedding-model',
      contents: ['one', 'two'],
      config: { abortSignal: expect.any(AbortSignal) },
    });
  });

  it('retries rate limits and then returns a safe 429 exception', async () => {
    const service = new GeminiService(
      createConfig({ ai: { provider: 'gemini', timeoutMs: 60000, maxRetries: 1 } }),
    );
    const client = createClient();
    client.models.generateContent.mockRejectedValue({ status: 429, message: 'secret response' });
    jest.spyOn(service, 'getClient').mockReturnValue(client as never);

    const error = await service.complete({ messages: [{ role: 'user', content: 'Hi' }] }).catch((value) => value);

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(error.message).not.toContain('secret response');
    expect(client.models.generateContent).toHaveBeenCalledTimes(2);
  });

  it('maps timeout, upstream 5xx, invalid key, and safety errors without raw details', async () => {
    const cases = [
      {
        error: { status: 401, message: 'gemini-secret invalid key' },
        expected: ServiceUnavailableException,
      },
      { error: { status: 500, message: 'private upstream body' }, expected: BadGatewayException },
      { error: { status: 400, message: 'SAFETY policy blocked content' }, expected: BadRequestException },
    ];

    for (const testCase of cases) {
      const service = new GeminiService(createConfig());
      const client = createClient();
      client.models.generateContent.mockRejectedValue(testCase.error);
      jest.spyOn(service, 'getClient').mockReturnValue(client as never);

      const error = await service.complete({ messages: [{ role: 'user', content: 'Hi' }] }).catch((value) => value);
      expect(error).toBeInstanceOf(testCase.expected);
      expect(error.message).not.toContain('gemini-secret');
      expect(error.message).not.toContain('private upstream body');
    }

    const timeoutService = new GeminiService(
      createConfig({ ai: { provider: 'gemini', timeoutMs: 5, maxRetries: 0 } }),
    );
    const timeoutClient = createClient();
    timeoutClient.models.generateContent.mockImplementation(() => new Promise(() => undefined));
    jest.spyOn(timeoutService, 'getClient').mockReturnValue(timeoutClient as never);

    await expect(
      timeoutService.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('logs only sanitized provider metadata', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new GeminiService(createConfig());
    const client = createClient();
    client.models.generateContent.mockRejectedValue({ status: 401, message: 'gemini-secret' });
    jest.spyOn(service, 'getClient').mockReturnValue(client as never);

    await service.complete({ messages: [{ role: 'user', content: 'Hi' }] }).catch(() => undefined);

    expect(warning.mock.calls.flat().join(' ')).not.toContain('gemini-secret');
    warning.mockRestore();
  });
});
