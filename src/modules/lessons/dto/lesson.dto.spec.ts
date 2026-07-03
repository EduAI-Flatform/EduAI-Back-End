import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LessonType } from '../../../../generated/prisma/enums';
import { CreateLessonDto } from './create-lesson.dto';
import { UpdateLessonDto } from './update-lesson.dto';

async function validationMessages(dtoClass: new () => object, payload: object) {
  const instance = plainToInstance(dtoClass, payload);
  const errors = await validate(instance);

  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('Lesson DTO validation', () => {
  it('accepts valid create lesson input', async () => {
    const messages = await validationMessages(CreateLessonDto, {
      title: 'Introduction',
      slug: 'introduction',
      type: LessonType.video,
      videoUrl: 'https://example.com/video.mp4',
      orderIndex: 0,
      durationMinutes: 12,
      isPreview: true,
    });

    expect(messages).toEqual([]);
  });

  it('requires title slug type and order index', async () => {
    const messages = await validationMessages(CreateLessonDto, {});

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('title'),
        expect.stringContaining('slug'),
        expect.stringContaining('type'),
        expect.stringContaining('orderIndex'),
      ]),
    );
  });

  it('rejects invalid lesson type', async () => {
    const messages = await validationMessages(CreateLessonDto, {
      title: 'Introduction',
      slug: 'introduction',
      type: 'audio',
      orderIndex: 0,
    });

    expect(messages).toEqual([
      expect.stringContaining('type must be one of the following values'),
    ]);
  });

  it('rejects negative order index', async () => {
    const messages = await validationMessages(CreateLessonDto, {
      title: 'Introduction',
      slug: 'introduction',
      type: LessonType.article,
      orderIndex: -1,
    });

    expect(messages).toEqual([
      expect.stringContaining('orderIndex must not be less than 0'),
    ]);
  });

  it('accepts partial update lesson input', async () => {
    const messages = await validationMessages(UpdateLessonDto, {
      orderIndex: 2,
    });

    expect(messages).toEqual([]);
  });
});
