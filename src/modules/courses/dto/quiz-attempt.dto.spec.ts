import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitQuizAttemptDto } from './submit-quiz-attempt.dto';

async function validationMessages(payload: object) {
  const errors = await validate(plainToInstance(SubmitQuizAttemptDto, payload));
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...(error.children ?? []).flatMap((child) =>
      (child.children ?? []).flatMap((nested) =>
        Object.values(nested.constraints ?? {}),
      ),
    ),
  ]);
}

describe('Quiz attempt DTO validation', () => {
  it('accepts JSON primitive answers with UUID question ids', async () => {
    await expect(
      validationMessages({
        answers: [
          {
            questionId: '11111111-1111-4111-8111-111111111111',
            answer: false,
          },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it('rejects empty answer sets and malformed question ids', async () => {
    await expect(validationMessages({ answers: [] })).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('at least 1')]),
    );
    await expect(
      validationMessages({ answers: [{ questionId: 'bad-id' }] }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('questionId must be a UUID'),
        expect.stringContaining('answer should not be null or undefined'),
      ]),
    );
  });
});
