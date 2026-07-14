import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export type AttendanceEvent = 'join' | 'leave';

export class RecordAttendanceDto {
  @ApiProperty({ enum: ['join', 'leave'] })
  @IsIn(['join', 'leave'])
  event!: AttendanceEvent;
}
