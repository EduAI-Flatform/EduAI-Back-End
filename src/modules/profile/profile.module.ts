import { Module } from '@nestjs/common';
import { AvatarStorageService } from './avatar-storage.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  controllers: [ProfileController],
  providers: [AvatarStorageService, ProfileService],
})
export class ProfileModule {}
