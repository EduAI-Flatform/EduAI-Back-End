import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CourseLevel, CourseStatus, CourseVisibility } from '../../../../generated/prisma/enums';
import { CreateCourseDto } from './create-course.dto';
import { UpdateCourseDto } from './update-course.dto';

async function validationMessages(dtoClass: new () => object, payload: object) {
  const instance = plainToInstance(dtoClass, payload);
  const errors = await validate(instance);

  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('Course DTO validation', () => {
  it('accepts valid create course input', async () => {
    const messages = await validationMessages(CreateCourseDto, {
      title: 'AI Foundations',
      slug: 'ai-foundations',
      description: 'Introductory AI course.',
      thumbnailUrl: 'https://example.com/course.png',
      level: CourseLevel.beginner,
      visibility: CourseVisibility.public,
    });

    expect(messages).toEqual([]);
  });

  it('requires create course title slug and level', async () => {
    const messages = await validationMessages(CreateCourseDto, {});

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('title'),
        expect.stringContaining('slug'),
        expect.stringContaining('level'),
      ]),
    );
  });

  it('rejects invalid create course level', async () => {
    const messages = await validationMessages(CreateCourseDto, {
      title: 'AI Foundations',
      slug: 'ai-foundations',
      level: 'expert',
    });

    expect(messages).toEqual([
      expect.stringContaining('level must be one of the following values'),
    ]);
  });

  it('rejects invalid update course status', async () => {
    const messages = await validationMessages(UpdateCourseDto, {
      status: 'live',
    });

    expect(messages).toEqual([
      expect.stringContaining('status must be one of the following values'),
    ]);
  });

  it('accepts valid update course status', async () => {
    const messages = await validationMessages(UpdateCourseDto, {
      status: CourseStatus.published,
    });

    expect(messages).toEqual([]);
  });
});
