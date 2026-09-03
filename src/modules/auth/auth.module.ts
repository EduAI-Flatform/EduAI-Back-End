import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule } from '../../config/app-config.module';
import { RedisModule } from '../../config/redis.module';
import { AuditModule } from '../../common/audit/audit.module';
import { FirebaseAdminModule } from '../firebase/firebase-admin.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthController } from './oauth/oauth.controller';
import { OAuthProviderService } from './oauth/oauth-provider.service';
import { OAuthService } from './oauth/oauth.service';
import { OAuthTransactionStore } from './oauth/oauth-transaction.store';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PasswordService } from './password.service';

@Module({
  imports: [
    AppConfigModule,
    RedisModule,
    AuditModule,
    FirebaseAdminModule,
    JwtModule.register({}),
  ],
  controllers: [AuthController, OAuthController],
  providers: [
    AuthService,
    OAuthProviderService,
    OAuthService,
    OAuthTransactionStore,
    PasswordService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    JwtModule,
    AuthService,
    PasswordService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
