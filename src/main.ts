import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.setup';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  configureApp(app, config.app.nodeEnv);

  await app.listen(config.port);
}

void bootstrap();
