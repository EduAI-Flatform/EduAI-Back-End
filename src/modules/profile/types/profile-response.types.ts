export interface ProfileResponse {
  id: string;
  userId: string;
  phoneNumber: string | null;
  dateOfBirth: Date | null;
  bio: string | null;
  headline: string | null;
  location: string | null;
  websiteUrl: string | null;
  publicSlug: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}
