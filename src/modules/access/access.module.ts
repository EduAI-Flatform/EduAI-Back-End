import { Global, Module } from '@nestjs/common';
import { CourseAccessService } from './course-access.service';

@Global()
@Module({
  providers: [CourseAccessService],
  exports: [CourseAccessService],
})
export class AccessModule {}
