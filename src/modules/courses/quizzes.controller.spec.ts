import { GUARDS_METADATA } from '@nestjs/common/constants';
import { QuestionType, RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { QuizzesController } from './quizzes.controller';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };

describe('QuizzesController', () => {
  function createController() {
    const service = {
      createQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      listQuizzes: jest.fn().mockResolvedValue([]),
      getQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      updateQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      publishQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      deleteQuiz: jest.fn().mockResolvedValue({ deleted: true }),
      createQuestion: jest.fn().mockResolvedValue({ id: 'question-id' }),
      listQuestions: jest.fn().mockResolvedValue([]),
      updateQuestion: jest.fn().mockResolvedValue({ id: 'question-id' }),
      deleteQuestion: jest.fn().mockResolvedValue({ deleted: true }),
    };
    return { controller: new QuizzesController(service as never), service };
  }

  it('delegates quiz and question creation with the authenticated user', async () => {
    const { controller, service } = createController();
    const quizInput = { title: 'Quiz', passingScore: 70 };
    const questionInput = {
      type: QuestionType.true_false,
      questionText: 'AI luôn đúng?',
      correctAnswerJson: false,
      points: 1,
      orderIndex: 1,
    };

    await controller.createQuiz(instructor, 'course-id', quizInput);
    await controller.createQuestion(instructor, 'quiz-id', questionInput);

    expect(service.createQuiz).toHaveBeenCalledWith(
      instructor,
      'course-id',
      quizInput,
    );
    expect(service.createQuestion).toHaveBeenCalledWith(
      instructor,
      'quiz-id',
      questionInput,
    );
  });

  it('requires instructor or admin role and authentication guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, QuizzesController)).toEqual([
      RoleName.instructor,
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, QuizzesController)).toBeDefined();
  });
});
