import { Global, Module } from '@nestjs/common';
import { AppLoggerService, LOG_WRITER } from './app-logger.service';

@Global()
@Module({
  providers: [
    {
      provide: LOG_WRITER,
      useValue: console.log,
    },
    AppLoggerService,
  ],
  exports: [AppLoggerService],
})
export class LoggingModule {}
