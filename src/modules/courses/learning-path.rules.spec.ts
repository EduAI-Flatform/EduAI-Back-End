import {
  buildLearningPathSteps,
  calculateLearningPathProgress,
  type LearningStepCandidate,
} from './learning-path.rules';

function candidate(
  overrides: Partial<LearningStepCandidate> = {},
): LearningStepCandidate {
  return {
    id: 'step-1',
    type: 'LESSON',
    title: 'Bài học',
    position: 1,
    completed: false,
    inProgress: false,
    ...overrides,
  };
}

describe('learning path rules', () => {
  it('orders lesson, assignment and quiz by lesson position', () => {
    const steps = buildLearningPathSteps([
      candidate({ id: 'quiz-2', type: 'QUIZ', title: 'Quiz 2', position: 2 }),
      candidate({ id: 'lesson-1', title: 'Bài 1', position: 1 }),
      candidate({ id: 'assignment-1', type: 'ASSIGNMENT', title: 'Bài tập 1', position: 1 }),
    ]);

    expect(steps.map((step) => step.id)).toEqual([
      'lesson-1',
      'assignment-1',
      'quiz-2',
    ]);
  });

  it('locks every step after the first incomplete step and exposes the reason', () => {
    const steps = buildLearningPathSteps([
      candidate({ id: 'lesson-1', completed: true }),
      candidate({ id: 'lesson-2', title: 'Bài 2' }),
      candidate({ id: 'quiz-1', type: 'QUIZ', title: 'Kiểm tra 1', position: 2 }),
    ]);

    expect(steps.map((step) => step.status)).toEqual([
      'COMPLETED',
      'AVAILABLE',
      'LOCKED',
    ]);
    expect(steps[2].lockedReason).toContain('Bài 2');
  });

  it('keeps in-progress as the current step and calculates percentage from all steps', () => {
    const steps = buildLearningPathSteps([
      candidate({ id: 'lesson-1', completed: true }),
      candidate({ id: 'lesson-2', inProgress: true, position: 2 }),
      candidate({ id: 'lesson-3', position: 3 }),
    ]);

    expect(steps[1].status).toBe('IN_PROGRESS');
    expect(calculateLearningPathProgress(steps)).toEqual({
      completedSteps: 1,
      totalSteps: 3,
      progressPercent: 33,
      completed: false,
    });
  });
});
