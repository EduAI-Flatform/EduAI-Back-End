import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import {
  AdminPlatformSettingsController,
  PublicPlatformSettingsController,
} from "./platform-settings.controller";
import { PlatformSettingsService } from "./platform-settings.service";
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    AdminPlatformSettingsController,
    PublicPlatformSettingsController,
  ],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformModule {}
