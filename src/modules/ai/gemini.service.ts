import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { AppConfigService } from '../../config/app-config.service';
import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from './ai-provider';

class GeminiTimeoutError extends Error {
  constructor() {
    super('Gemini request timed out');
    this.name = 'GeminiTimeoutError';
  }
}

@Injectable()
export class GeminiService implements AiProvider {
  private readonly logger = new Logger(GeminiService.name);
  private client?: GoogleGenAI;

  constructor(private readonly appConfig: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.appConfig.gemini.apiKey);
  }

  getModel(): string {
    const model = this.appConfig.gemini.model;
    if (!model) {
      throw new ServiceUnavailableException('Gemini service is not configured');
    }

    return model;
  }

  getEmbeddingModel(): string {
    const model = this.appConfig.gemini.embeddingModel;
    if (!model) {
      throw new ServiceUnavailableException('Gemini embedding service is not configured');
    }

    return model;
  }

  getClient(): GoogleGenAI {
    const apiKey = this.appConfig.gemini.apiKey;
    if (!apiKey) {
      throw new ServiceUnavailableException('Gemini service is not configured');
    }

    this.client ??= new GoogleGenAI({ apiKey });
    return this.client;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const systemInstruction = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const response = await this.withRetry('generateContent', (abortSignal) =>
      this.getClient().models.generateContent({
        model: this.getModel(),
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
          ...(request.responseSchema
            ? { responseSchema: request.responseSchema as never }
            : {}),
          abortSignal,
        },
      }),
    );

    return {
      content: response.text ?? null,
      totalTokens: response.usageMetadata?.totalTokenCount,
    };
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const contents = Array.isArray(input) ? input : [input];
    const response = await this.withRetry('embedContent', (abortSignal) =>
      this.getClient().models.embedContent({
        model: this.getEmbeddingModel(),
        contents,
        config: { abortSignal },
      }),
    );

    return (response.embeddings ?? []).map((embedding) => embedding.values ?? []);
  }

  private async withRetry<T>(
    operation: string,
    request: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const { timeoutMs, maxRetries } = this.appConfig.ai;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const response = request(controller.signal);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new GeminiTimeoutError());
          }, timeoutMs);
        });

        return await Promise.race([response, timeout]);
      } catch (error) {
        const status = this.getStatus(error);
        const retryable = this.isRetryable(error, status);

        if (retryable && attempt < maxRetries) {
          await this.delay(attempt);
          continue;
        }

        this.logFailure(operation, status, this.getFailureType(error, status));
        throw this.toHttpException(error, status);
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    }

    throw new ServiceUnavailableException('Gemini service is unavailable');
  }

  private isRetryable(error: unknown, status?: number): boolean {
    if (error instanceof HttpException) return false;

    return (
      error instanceof GeminiTimeoutError ||
      status === undefined ||
      status === 429 ||
      status >= 500
    );
  }

  private toHttpException(error: unknown, status?: number): HttpException {
    if (error instanceof GeminiTimeoutError) {
      return new GatewayTimeoutException('Gemini request timed out');
    }

    if (status === 429) {
      return new HttpException('AI provider rate limit exceeded', 429);
    }

    if (status === 401 || status === 403) {
      return new ServiceUnavailableException('Gemini provider authentication failed');
    }

    if (status === 404) {
      return new BadRequestException('Gemini model was not found');
    }

    if (status === 400) {
      return this.isSafetyError(error)
        ? new BadRequestException('AI request was blocked by Gemini safety policy')
        : new BadRequestException('Invalid AI request');
    }

    if (status !== undefined && status >= 500) {
      return new BadGatewayException('Gemini provider is temporarily unavailable');
    }

    return new ServiceUnavailableException('Gemini provider is unavailable');
  }

  private getStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object' || !('status' in error)) return undefined;

    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  private getFailureType(error: unknown, status?: number): string {
    if (error instanceof GeminiTimeoutError) return 'timeout';
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'authentication';
    if (status === 400 && this.isSafetyError(error)) return 'safety_block';
    if (status !== undefined && status >= 500) return 'upstream';
    return 'request';
  }

  private isSafetyError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('message' in error)) return false;

    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && /safety|blocked|policy|harm|prohibited/i.test(message);
  }

  private logFailure(operation: string, status: number | undefined, type: string): void {
    this.logger.warn(
      `AI provider failure provider=gemini model=${this.safeModel()} operation=${operation} type=${type} status=${status ?? 'unknown'}`,
    );
  }

  private safeModel(): string {
    return this.appConfig.gemini.model ?? 'unconfigured';
  }

  private delay(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
}
