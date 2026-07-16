import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { OpenAiService } from './openai.service';

@Module({
  imports: [AppConfigModule],
  providers: [OpenAiService],
  exports: [OpenAiService],
})
export class AiModule {}
