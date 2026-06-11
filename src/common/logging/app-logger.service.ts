import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose';
type LogWriter = (entry: string) => void;

type LogMetadata = Record<string, unknown>;

interface StructuredLogEntry extends LogMetadata {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  trace?: string;
}

const SENSITIVE_KEY_PATTERN = /password|secret|token|api[_-]?key|authorization|cookie|credential/i;
export const LOG_WRITER = Symbol('LOG_WRITER');

@Injectable()
export class AppLoggerService implements LoggerService {
  constructor(
    @Optional()
    @Inject(LOG_WRITER)
    private readonly writer: LogWriter = console.log,
  ) {}

  log(message: string, context?: string, metadata?: LogMetadata): void {
    this.write('log', message, context, metadata);
  }

  error(
    message: string,
    traceOrContext?: string,
    contextOrMetadata?: string | LogMetadata,
    metadata?: LogMetadata,
  ): void {
    const { trace, context, meta } = this.normalizeErrorArgs(
      traceOrContext,
      contextOrMetadata,
      metadata,
    );

    this.write('error', message, context, meta, trace);
  }

  warn(message: string, context?: string, metadata?: LogMetadata): void {
    this.write('warn', message, context, metadata);
  }

  debug(message: string, context?: string, metadata?: LogMetadata): void {
    this.write('debug', message, context, metadata);
  }

  verbose(message: string, context?: string, metadata?: LogMetadata): void {
    this.write('verbose', message, context, metadata);
  }

  private write(
    level: LogLevel,
    message: string,
    context?: string,
    metadata: LogMetadata = {},
    trace?: string,
  ): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(context ? { context } : {}),
      ...this.redactObject(metadata),
      ...(trace ? { trace } : {}),
    };

    this.writer(JSON.stringify(entry));
  }

  private normalizeErrorArgs(
    traceOrContext?: string,
    contextOrMetadata?: string | LogMetadata,
    metadata?: LogMetadata,
  ): { trace?: string; context?: string; meta?: LogMetadata } {
    if (typeof contextOrMetadata === 'object' && contextOrMetadata !== null) {
      return {
        context: traceOrContext,
        meta: contextOrMetadata,
      };
    }

    return {
      trace: traceOrContext,
      context: contextOrMetadata,
      meta: metadata,
    };
  }

  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (typeof value !== 'object' || value === null) {
      return value;
    }

    return Object.entries(value).reduce<LogMetadata>((safe, [key, item]) => {
      safe[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : this.redact(item);
      return safe;
    }, {});
  }

  private redactObject(metadata: LogMetadata): LogMetadata {
    return this.redact(metadata) as LogMetadata;
  }
}
