import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { QuizAttemptsController } from './quiz-attempts.controller';

const student = { id: 'student-id', roles: [RoleName.student] };

describe('QuizAttemptsController', () => {
  function createController() {
    const service = {
      submitAttempt: jest.fn().mockResolvedValue({ id: 'attempt-id' }),
      listMyAttempts: jest.fn().mockResolvedValue([]),
    };
    return { controller: new QuizAttemptsController(service as never), service };
  }

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

  it('requires student role and authentication guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, QuizAttemptsController)).toEqual([
      RoleName.student,
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, QuizAttemptsController),
    ).toBeDefined();
  });
});
