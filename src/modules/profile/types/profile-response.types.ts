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
  careerGoal: string | null;
  preferredRoles: string[];
  preferredWorkModes: string[];
  availabilityStatus: string | null;
  availableFrom: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
