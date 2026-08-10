import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { AssignmentStorageService } from './assignment-storage.service';

@Module({
  imports: [AuthModule, AuditModule, CoursesModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AssignmentStorageService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
