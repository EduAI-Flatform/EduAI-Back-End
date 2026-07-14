import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClassroomsController } from './classrooms.controller';
import { ClassroomsService } from './classrooms.service';
import { JitsiRoomService } from './jitsi-room.service';

@Module({
  imports: [AuthModule],
  controllers: [ClassroomsController],
  providers: [ClassroomsService, JitsiRoomService],
  exports: [ClassroomsService],
})
export class ClassroomsModule {}
