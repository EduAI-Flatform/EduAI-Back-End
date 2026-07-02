import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QuestionType } from '../../../../generated/prisma/enums';
import { CreateQuestionDto } from './create-question.dto';
import { CreateQuizDto } from './create-quiz.dto';
import { UpdateQuizDto } from './update-quiz.dto';

async function validationMessages(dtoClass: new () => object, payload: object) {
  const errors = await validate(plainToInstance(dtoClass, payload));
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('Quiz DTO validation', () => {
  it('accepts valid quiz and JSON question inputs', async () => {
    await expect(
      validationMessages(CreateQuizDto, {
        title: 'Quiz AI',
        passingScore: 70,
        timeLimitMinutes: 30,
      }),
    ).resolves.toEqual([]);
    await expect(
      validationMessages(CreateQuestionDto, {
        type: QuestionType.multiple_choice,
        questionText: 'AI là gì?',
        optionsJson: ['A', 'B'],
        correctAnswerJson: 'A',
        points: 1,
        orderIndex: 1,
      }),
    ).resolves.toEqual([]);
  });

  it('rejects invalid score, question type, and missing answer', async () => {
    await expect(
      validationMessages(CreateQuizDto, { title: 'Quiz', passingScore: 101 }),
    ).resolves.toEqual(expect.arrayContaining([expect.stringContaining('passingScore')]));
    await expect(
      validationMessages(CreateQuestionDto, {
        type: 'essay',
        questionText: 'Question',
        points: 1,
        orderIndex: 1,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('type must be one of the following values'),
        expect.stringContaining('correctAnswerJson'),
      ]),
    );
  });

  it('accepts partial quiz updates without status mutation', async () => {
    await expect(
      validationMessages(UpdateQuizDto, { title: 'Tên mới' }),
    ).resolves.toEqual([]);
  });
});
