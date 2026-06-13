import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { configureApp } from './app.setup';
import { AppModule } from './app.module';
import { AppLoggerService } from './common/logging/app-logger.service';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);
  const logger = app.get(AppLoggerService);

  app.useLogger(logger);
  configureApp(app, config.app.nodeEnv, logger);
  configureSwagger(app);

  await app.listen(config.port);
}

function configureSwagger(app: Awaited<ReturnType<typeof NestFactory.create>>): void {
  const config = new DocumentBuilder()
    .setTitle('EduAI API')
    .setDescription('EduAI Platform API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document);
}

void bootstrap();
