import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAssignmentDto } from './create-assignment.dto';
import { GradeSubmissionDto } from './grade-submission.dto';
import { SubmitAssignmentDto } from './submit-assignment.dto';

async function validationMessages(dtoClass: new () => object, payload: object) {
  const errors = await validate(plainToInstance(dtoClass, payload));
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('Assignment DTO validation', () => {
  it('accepts valid assignment, text, and HTTPS file inputs', async () => {
    await expect(
      validationMessages(CreateAssignmentDto, {
        title: 'Bài tập',
        maxScore: 10,
        dueDate: '2026-07-10T00:00:00.000Z',
      }),
    ).resolves.toEqual([]);
    await expect(
      validationMessages(SubmitAssignmentDto, {
        content: 'Bài làm',
        fileUrl: 'https://files.example.com/submission.pdf',
      }),
    ).resolves.toEqual([]);
  });

  it('rejects invalid scores, dates, and non-HTTPS file references', async () => {
    await expect(
      validationMessages(CreateAssignmentDto, {
        title: 'Bài tập',
        maxScore: 0,
        dueDate: 'not-a-date',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('maxScore'),
        expect.stringContaining('dueDate'),
      ]),
    );
    await expect(
      validationMessages(SubmitAssignmentDto, {
        fileUrl: 'http://files.example.com/submission.pdf',
      }),
    ).resolves.toEqual([expect.stringContaining('fileUrl must be a URL')]);
  });

  it('validates manual grade payloads', async () => {
    await expect(
      validationMessages(GradeSubmissionDto, {
        score: 9.5,
        feedback: 'Good work',
      }),
    ).resolves.toEqual([]);
    await expect(
      validationMessages(GradeSubmissionDto, {
        score: -1,
      }),
    ).resolves.toEqual([expect.stringContaining('score')]);
  });
});
