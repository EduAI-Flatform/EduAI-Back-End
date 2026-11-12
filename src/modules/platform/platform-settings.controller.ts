import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Allow, IsISO8601, IsString, MaxLength } from "class-validator";
import { RoleName } from "../../../generated/prisma/client";
import { Public } from "../../common/security/public.decorator";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/roles.decorator";
import { PlatformSettingsService } from "./platform-settings.service";
class CreatePlatformPolicyDto {
  @IsString() @MaxLength(40) group!: string;
  // Navigation is an array; shape/size is validated by the domain validator.
  @Allow() content!: unknown;
}
class SchedulePlatformPolicyDto {
  @IsISO8601() effectiveAt!: string;
}

@ApiTags("Platform")
@Controller("platform")
export class PublicPlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}
  @Public() @Get("settings") current() {
    return this.settings.publicSettings();
  }
}
@ApiTags("Admin Platform")
@ApiBearerAuth()
@Controller("admin/platform")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class AdminPlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}
  @Get("settings") state() {
    return this.settings.state();
  }
  @Post("revisions") create(
    @CurrentUser("id") actor: string,
    @Body() body: CreatePlatformPolicyDto,
  ) {
    return this.settings.create(actor, body.group, body.content);
  }
  @Get("revisions/:id/preview") preview(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.settings.preview(id);
  }
  @Post("revisions/:id/approve") approve(
    @CurrentUser("id") actor: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.settings.approve(actor, id);
  }
  @Post("revisions/:id/schedule") schedule(
    @CurrentUser("id") actor: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: SchedulePlatformPolicyDto,
  ) {
    return this.settings.schedule(actor, id, new Date(body.effectiveAt));
  }
  @Post("revisions/:id/cancel") cancel(
    @CurrentUser("id") actor: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.settings.cancel(actor, id);
  }
}
