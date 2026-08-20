import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

export interface MonitoringEvent {
  code: string;
  correlationId?: string;
  path: string;
  statusCode: number;
}

@Injectable()
export class MonitoringService {
  constructor(private readonly config: AppConfigService) {}

  capture(event: MonitoringEvent): void {
    const { enabled, endpoint } = this.config.monitoring;
    if (!enabled || !endpoint) return;
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...event,
        environment: this.config.app.nodeEnv,
        occurredAt: new Date().toISOString(),
      }),
    }).catch(() => undefined);
  }
}
