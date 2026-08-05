export const AI_PROVIDER = Symbol('AI_PROVIDER');

export type AiProviderMessageRole = 'system' | 'user' | 'assistant';

export interface AiProviderMessage {
  role: AiProviderMessageRole;
  content: string;
}

export interface AiCompletionRequest {
  messages: AiProviderMessage[];
  json?: boolean;
  responseSchema?: Record<string, unknown>;
}

export interface AiCompletionResult {
  content: string | null;
  totalTokens?: number;
}

export interface AiProvider {
  getModel(): string;
  getEmbeddingModel(): string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
  embed(input: string | string[]): Promise<number[][]>;
}
