import { GUARDS_METADATA } from '@nestjs/common/constants';
import { QuestionType, RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { QuizzesController } from './quizzes.controller';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const student = { id: 'student-id', roles: [RoleName.student] };

describe('QuizzesController', () => {
  function createController() {
    const service = {
      createQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      listQuizzes: jest.fn().mockResolvedValue([]),
      getQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      updateQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      publishQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id' }),
      listStudentQuizzes: jest.fn().mockResolvedValue([]),
      getStudentQuiz: jest.fn().mockResolvedValue({ id: 'quiz-id', questions: [] }),
      deleteQuiz: jest.fn().mockResolvedValue({ deleted: true }),
      createQuestion: jest.fn().mockResolvedValue({ id: 'question-id' }),
      listQuestions: jest.fn().mockResolvedValue([]),
      listMyAttempts: jest.fn().mockResolvedValue([]),
      submitAttempt: jest.fn().mockResolvedValue({ id: 'attempt-id' }),
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

  it('uses the authenticated student id for submit and history routes', async () => {
    const { controller, service } = createController();
    const input = {
      answers: [
        {
          questionId: '11111111-1111-4111-8111-111111111111',
          answer: true,
        },
      ],
    };

    await controller.submitAttempt(student, 'quiz-id', input);
    await controller.listMyAttempts(student, 'quiz-id');

    expect(service.submitAttempt).toHaveBeenCalledWith(student.id, 'quiz-id', input);
    expect(service.listMyAttempts).toHaveBeenCalledWith(student.id, 'quiz-id');
  });

  it('uses the authenticated student id for student quiz reads', async () => {
    const { controller, service } = createController();

    await controller.listStudentQuizzes(student, 'course-id');
    await controller.getStudentQuiz(student, 'quiz-id');

    expect(service.listStudentQuizzes).toHaveBeenCalledWith(student.id, 'course-id');
    expect(service.getStudentQuiz).toHaveBeenCalledWith(student.id, 'quiz-id');
  });

  it('requires student role for attempt routes', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, QuizzesController.prototype.listStudentQuizzes),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(ROLES_KEY, QuizzesController.prototype.getStudentQuiz),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(ROLES_KEY, QuizzesController.prototype.submitAttempt),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(ROLES_KEY, QuizzesController.prototype.listMyAttempts),
    ).toEqual([RoleName.student]);
  });
});
