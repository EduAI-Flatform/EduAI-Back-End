import { Module } from '@nestjs/common';
import { PublicMediaController } from './public-media.controller';
import { PublicMediaService } from './public-media.service';

@Module({
  controllers: [PublicMediaController],
  providers: [PublicMediaService],
})
export class MediaModule {}
