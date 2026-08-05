export type LearningStepType = 'LESSON' | 'ASSIGNMENT' | 'QUIZ';
export type LearningStepStatus =
  | 'LOCKED'
  | 'AVAILABLE'
  | 'IN_PROGRESS'
  | 'COMPLETED';

export interface LearningStepCandidate {
  id: string;
  type: LearningStepType;
  title: string;
  position: number;
  completed: boolean;
  inProgress: boolean;
  lessonId?: string | null;
  isPreview?: boolean;
  progressPercent?: number;
  watchedSeconds?: number;
  durationSeconds?: number | null;
  lastPositionSeconds?: number;
  documentProgressPercent?: number;
  lockedReason?: string | null;
}

export interface LearningStep extends LearningStepCandidate {
  status: LearningStepStatus;
  lockedReason: string | null;
}

export interface LearningPathProgress {
  completedSteps: number;
  totalSteps: number;
  progressPercent: number;
  completed: boolean;
}

const typeOrder: Record<LearningStepType, number> = {
  LESSON: 0,
  ASSIGNMENT: 1,
  QUIZ: 2,
};

export function buildLearningPathSteps(
  candidates: LearningStepCandidate[],
): LearningStep[] {
  const sortedCandidates = [...candidates].sort((first, second) => {
    return (
      first.position - second.position ||
      typeOrder[first.type] - typeOrder[second.type] ||
      first.id.localeCompare(second.id)
    );
  });

  let previousStep: LearningStep | null = null;

  return sortedCandidates.map((candidate) => {
    let status: LearningStepStatus;
    let lockedReason: string | null = null;

    if (candidate.completed) {
      status = 'COMPLETED';
    } else if (previousStep && previousStep.status !== 'COMPLETED') {
      status = 'LOCKED';
      lockedReason = `Bạn cần hoàn thành "${previousStep.title}" trước.`;
    } else {
      status = candidate.inProgress ? 'IN_PROGRESS' : 'AVAILABLE';
    }

    const step: LearningStep = {
      ...candidate,
      status,
      lockedReason,
    };
    previousStep = step;
    return step;
  });
}

export function calculateLearningPathProgress(
  steps: LearningStep[],
): LearningPathProgress {
  const totalSteps = steps.length;
  const completedSteps = steps.filter((step) => step.status === 'COMPLETED').length;

  return {
    completedSteps,
    totalSteps,
    progressPercent:
      totalSteps === 0 ? 0 : Math.round((completedSteps / totalSteps) * 100),
    completed: totalSteps > 0 && completedSteps === totalSteps,
  };
}
