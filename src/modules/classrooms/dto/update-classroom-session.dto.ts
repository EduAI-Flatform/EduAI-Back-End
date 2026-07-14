import { PartialType } from '@nestjs/swagger';
import { CreateClassroomSessionDto } from './create-classroom-session.dto';

export class UpdateClassroomSessionDto extends PartialType(
  CreateClassroomSessionDto,
) {}
