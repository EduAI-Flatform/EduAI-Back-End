import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackendConfig } from './configuration';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get app(): BackendConfig['app'] {
    return this.getConfigValue('app');
  }

  get port(): number {
    return this.app.port;
  }

  get database(): BackendConfig['database'] {
    return this.getConfigValue('database');
  }

  get redis(): BackendConfig['redis'] {
    return this.getConfigValue('redis');
  }

  get jwt(): BackendConfig['jwt'] {
    return this.getConfigValue('jwt');
  }

  get r2(): BackendConfig['r2'] {
    return this.getConfigValue('r2');
  }

  get openai(): BackendConfig['openai'] {
    return this.getConfigValue('openai');
  }

  private getConfigValue<T extends keyof BackendConfig>(key: T): BackendConfig[T] {
    const value = this.configService.get<BackendConfig[T]>(key);

    if (!value) {
      throw new Error(`Missing config section: ${key}`);
    }

    return value;
  }
}
