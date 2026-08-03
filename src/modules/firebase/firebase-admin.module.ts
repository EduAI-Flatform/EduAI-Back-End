import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { FIREBASE_ADMIN_SERVICE } from './firebase-admin.constants';
import { FirebaseAdminService } from './firebase-admin.service';

@Module({
  imports: [AppConfigModule],
  providers: [
    FirebaseAdminService,
    {
      provide: FIREBASE_ADMIN_SERVICE,
      useExisting: FirebaseAdminService,
    },
  ],
  exports: [FirebaseAdminService, FIREBASE_ADMIN_SERVICE],
})
export class FirebaseAdminModule {}
