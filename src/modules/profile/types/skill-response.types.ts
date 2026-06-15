export interface SkillResponse {
  id: string;
  userId: string;
  name: string;
  level: string | null;
  category: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeleteSkillResponse {
  deleted: true;
}
