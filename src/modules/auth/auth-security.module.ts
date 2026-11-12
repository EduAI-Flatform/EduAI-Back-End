import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { FirebaseAdminModule } from '../firebase/firebase-admin.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthSecurityController } from './auth-security.controller';
import { AuthSecurityService } from './auth-security.service';
@Module({ imports: [PrismaModule, AuthModule, FirebaseAdminModule], controllers: [AuthSecurityController], providers: [AuthSecurityService] })
export class AuthSecurityModule {}
