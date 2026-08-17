export interface LearningSkillGapResponse {
  id: string;
  name: string;
  currentLevel: string | null;
  targetLevel: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearningProfileResponse {
  id: string;
  userId: string;
  learningGoal: string | null;
  currentLevel: string | null;
  weeklyAvailabilityHours: number | null;
  createdAt: Date;
  updatedAt: Date;
  skillGaps: LearningSkillGapResponse[];
}
