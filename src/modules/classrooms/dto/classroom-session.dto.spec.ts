import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateClassroomSessionDto } from './create-classroom-session.dto';
import { RecordAttendanceDto } from './record-attendance.dto';
import { UpdateClassroomSessionDto } from './update-classroom-session.dto';

async function validationMessages(dtoClass: new () => object, payload: object) {
  const errors = await validate(plainToInstance(dtoClass, payload));
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('Classroom session DTO validation', () => {
  it('accepts valid create and partial update payloads', async () => {
    await expect(
      validationMessages(CreateClassroomSessionDto, {
        title: 'Live AI Workshop',
        description: 'Weekly classroom session',
        scheduledStart: '2026-07-10T08:00:00.000Z',
        scheduledEnd: '2026-07-10T09:00:00.000Z',
      }),
    ).resolves.toEqual([]);

    await expect(
      validationMessages(UpdateClassroomSessionDto, {
        title: 'Updated live session',
      }),
    ).resolves.toEqual([]);
  });

  it('rejects blank text and invalid dates', async () => {
    await expect(
      validationMessages(CreateClassroomSessionDto, {
        title: '',
        scheduledStart: 'not-a-date',
        scheduledEnd: '2026-07-10T09:00:00.000Z',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('title'),
        expect.stringContaining('scheduledStart'),
      ]),
    );
  });

  it('accepts only supported attendance events', async () => {
    await expect(
      validationMessages(RecordAttendanceDto, { event: 'join' }),
    ).resolves.toEqual([]);
    await expect(
      validationMessages(RecordAttendanceDto, { event: 'leave' }),
    ).resolves.toEqual([]);
    await expect(
      validationMessages(RecordAttendanceDto, { event: 'arrive' }),
    ).resolves.toEqual([expect.stringContaining('event')]);
  });
});
