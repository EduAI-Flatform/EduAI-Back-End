import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CourseLevel, CourseStatus, CourseVisibility } from '../../../../generated/prisma/enums';
import { CreateCourseDto } from './create-course.dto';
import { ListInstructorCoursesQueryDto } from './list-instructor-courses-query.dto';
import { UpdateCourseDto } from './update-course.dto';

async function validationMessages(dtoClass: new () => object, payload: object) {
  const instance = plainToInstance(dtoClass, payload);
  const errors = await validate(instance);

  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('Course DTO validation', () => {
  it('accepts valid create course input', async () => {
    const input = plainToInstance(CreateCourseDto, {
      title: 'AI Foundations',
      slug: 'ai-foundations',
      description: 'Introductory AI course.',
      thumbnailUrl: 'https://example.com/course.png',
      badge: '  Bestseller  ',
      priceAmountMinor: '1499000',
      priceCurrency: 'vnd',
      level: CourseLevel.beginner,
      visibility: CourseVisibility.public,
    });
    const errors = await validate(input);

    expect(errors).toEqual([]);
    expect(input).toEqual(
      expect.objectContaining({
        badge: 'Bestseller',
        priceAmountMinor: 1499000,
        priceCurrency: 'VND',
      }),
    );
  });

  it('rejects negative prices and invalid currencies', async () => {
    const messages = await validationMessages(CreateCourseDto, {
      title: 'AI Foundations',
      level: CourseLevel.beginner,
      priceAmountMinor: -1,
      priceCurrency: 'dong',
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('priceAmountMinor'),
        expect.stringContaining('priceCurrency'),
      ]),
    );
  });

  it('accepts safe repository-local demo thumbnails', async () => {
    const messages = await validationMessages(CreateCourseDto, {
      title: 'AI Foundations',
      level: CourseLevel.beginner,
      thumbnailUrl: '/demo-assets/course-placeholder.svg',
    });

    expect(messages).toEqual([]);
  });

  it('rejects unsafe relative thumbnail paths', async () => {
    const messages = await validationMessages(CreateCourseDto, {
      title: 'AI Foundations',
      level: CourseLevel.beginner,
      thumbnailUrl: '/demo-assets/../private.env',
    });

    expect(messages).toEqual([
      expect.stringContaining('thumbnailUrl must be an http(s) URL'),
    ]);
  });

  it('requires create course title and level while allowing the server to generate slug', async () => {
    const messages = await validationMessages(CreateCourseDto, {});

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('title'),
        expect.stringContaining('level'),
      ]),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([expect.stringContaining('slug')]),
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

  it('normalizes instructor course status aliases', async () => {
    const instance = plainToInstance(ListInstructorCoursesQueryDto, {
      page: '1',
      pageSize: '20',
      status: 'Published',
      search: ' React ',
    });
    const errors = await validate(instance);

    expect(errors).toEqual([]);
    expect(instance).toEqual(
      expect.objectContaining({
        page: 1,
        pageSize: 20,
        status: CourseStatus.published,
        search: 'React',
      }),
    );
  });
});
