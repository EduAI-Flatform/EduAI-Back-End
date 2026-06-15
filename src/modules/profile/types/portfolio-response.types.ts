export interface PortfolioResponse {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  projectUrl: string | null;
  imageUrl: string | null;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DeletePortfolioResponse {
  deleted: true;
}
