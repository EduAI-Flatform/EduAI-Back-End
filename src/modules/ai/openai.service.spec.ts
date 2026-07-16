import { ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { OpenAiService } from './openai.service';

function createConfig(apiKey?: string, model?: string): AppConfigService {
  return {
    openai: { apiKey, model },
  } as AppConfigService;
}

describe('OpenAiService', () => {
  it('reads the API key and model from application config', () => {
    const service = new OpenAiService(createConfig('test-key', 'test-model'));

    expect(service.isConfigured()).toBe(true);
    expect(service.getModel()).toBe('test-model');
  });

  it('uses a cost-conscious default model when no model is configured', () => {
    const service = new OpenAiService(createConfig('test-key'));

    expect(service.getModel()).toBe('gpt-5.4-mini');
  });

  it('does not expose the API key when the provider is unavailable', () => {
    const service = new OpenAiService(createConfig());

    expect(() => service.getClient()).toThrow(ServiceUnavailableException);
    expect(() => service.getClient()).toThrow('OpenAI service is not configured');
  });

  it('creates and reuses one configured client', () => {
    const service = new OpenAiService(createConfig('test-key'));

    expect(service.getClient()).toBe(service.getClient());
  });
});
