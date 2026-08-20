export interface CareerSkillProjection {
  name: string;
  level: string | null;
  category: string | null;
}

export interface CareerPortfolioProjection {
  title: string;
  description: string | null;
  projectUrl: string | null;
  imageUrl: string | null;
  startDate: Date | null;
  endDate: Date | null;
}

export interface CareerCourseProjection {
  title: string;
  slug: string;
  thumbnailUrl: string | null;
  completedAt: Date;
}

export interface CareerCertificateProjection {
  title: string;
  courseTitle: string;
  courseSlug: string;
  issuedAt: Date;
  verificationUrl: string | null;
}

export interface PublicCareerProfileResponse {
  fullName: string;
  avatarUrl: string | null;
  bio: string | null;
  headline: string | null;
  location: string | null;
  websiteUrl: string | null;
  publicSlug: string;
  careerGoal: string | null;
  preferredRoles: string[];
  preferredWorkModes: string[];
  availabilityStatus: string | null;
  availableFrom: Date | null;
  skills: CareerSkillProjection[];
  portfolio: CareerPortfolioProjection[];
  completedCourses: CareerCourseProjection[];
  certificates: CareerCertificateProjection[];
}

export interface CareerProfileResponse extends Omit<PublicCareerProfileResponse, 'publicSlug'> {
  email: string;
  publicSlug: string | null;
  isPublic: boolean;
}
