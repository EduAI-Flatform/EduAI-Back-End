import type { Request } from 'express';

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

export function safeRequestPath(request: Request): string {
  return (request.originalUrl ?? request.url).split('?', 1)[0];
}
