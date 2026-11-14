export const PLATFORM_GROUPS = [
  "branding",
  "navigation",
  "membership",
  "points",
  "partners",
  "affiliate",
  "courses",
  "operations",
] as const;
export type PlatformGroup = (typeof PLATFORM_GROUPS)[number];
export const PARTNER_CONNECTION_STATUSES = ['unconfigured', 'preparing', 'testing', 'connected', 'suspended'] as const;
export type PartnerConnectionStatus = (typeof PARTNER_CONNECTION_STATUSES)[number];
export function withPartnerConnectionDefaults(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const value = content as Record<string, unknown>;
  return { ...value, items: Array.isArray(value.items) ? value.items.map(item =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? { ...item, connectionStatus: item.connectionStatus === undefined ? 'unconfigured' : item.connectionStatus }
      : item) : value.items };
}
export const DEFAULT_QUIZ_DEFAULTS = {
  passingScore: 70, timeLimitMinutes: 30, maxAttempts: 0,
  randomizeQuestions: false, randomizeOptions: false, showCorrectAnswers: true,
  isRequired: true, allowInstructorOverrides: true,
};
export function withCourseQuizDefaults(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const value = content as Record<string, unknown>;
  return { ...value, quizDefaults: value.quizDefaults === undefined ? { ...DEFAULT_QUIZ_DEFAULTS } : value.quizDefaults };
}
export const DEFAULT_PLATFORM_SETTINGS = {
  branding: {
    name: "GDS",
    logoUrl: "/gds-logo.png",
    heroImageUrl: "/gds-hero.webp",
    mascotUrl: "/gds-assistant.webp",
    pointImageUrl: "/gds-point.webp",
    supportEmail: "",
    supportUrl: "",
    colors: {
      magenta: "#E71F69",
      violet: "#4700F4",
      teal: "#00A89F",
      gray: "#D9D9D9",
      periwinkle: "#7A8AD9",
      mint: "#6EEDC7",
      pink: "#FFA7C8",
      lavender: "#A97DFF",
    },
    heroTitle: {
      vi: "GDS - LEARN WITHOUT LIMITS",
      en: "GDS - LEARN WITHOUT LIMITS",
    },
    heroDescription: {
      vi: "Phát triển tương lai với hơn 10.000 trải nghiệm học tập, chứng chỉ và chương trình đào tạo từ các nhà giáo dục và chuyên gia hàng đầu – tất cả trên GDS.",
      en: "Empower your future with 10,000+ learning experiences, certificates, and degrees from top educators and industry leaders – all on GDS.",
    },
  },
  navigation: [
    {
      id: "courses",
      label: { vi: "Khóa học", en: "Courses" },
      path: "/courses",
      enabled: true,
    },
    {
      id: "learning",
      label: { vi: "Học tập", en: "Learning" },
      path: "/dashboard",
      enabled: true,
    },
    {
      id: "library",
      label: { vi: "Thư viện", en: "Library" },
      path: "/library",
      enabled: true,
    },
    { id: "ai", label: { vi: "AI", en: "AI" }, path: "/ai", enabled: true },
    {
      id: "jobs",
      label: { vi: "Việc làm", en: "Jobs" },
      path: "/jobs",
      enabled: true,
    },
    {
      id: "activities",
      label: { vi: "Hoạt động", en: "Activities" },
      path: "/activities",
      enabled: true,
    },
    {
      id: "certificates",
      label: { vi: "Chứng chỉ", en: "Certificates" },
      path: "/dashboard/certificates",
      enabled: true,
    },
    {
      id: "partners",
      label: { vi: "Liên kết với GDS", en: "Partner with GDS" },
      path: "/partners",
      enabled: true,
    },
  ],
  membership: {
    enabled: false,
    basis: "spend",
    currency: "VND",
    cycleMode: "rolling",
    cycleMonths: 12,
    tiers: [
      {
        code: "member",
        name: { vi: "Thẻ Member", en: "Member Card" },
        threshold: 0,
        benefits: [] as Array<{ vi: string; en: string }>,
      },
      {
        code: "gold",
        name: { vi: "Thẻ Hạng Vàng", en: "Golden Member" },
        threshold: 0,
        benefits: [] as Array<{ vi: string; en: string }>,
      },
      {
        code: "platinum",
        name: { vi: "Thẻ Đen", en: "Platinum Member" },
        threshold: 0,
        benefits: [] as Array<{ vi: string; en: string }>,
      },
    ],
  },
  points: {
    enabled: false,
    expireAfterMonths: 12,
    maxDaily: 0,
    rules: [] as Array<{ event: string; points: number }>,
  },
  partners: {
    enabled: false,
    items: [] as Array<{
      name: string;
      logoUrl: string;
      url: string;
      category: string;
      connectionStatus?: PartnerConnectionStatus;
    }>,
  },
  affiliate: {
    enabled: false,
    currency: "VND",
    commissionBase: "net_paid_after_recorded_refunds",
    attributionModel: "first_touch",
    fundingSource: "unconfigured",
    allocationPrecedence: "seller_entitlements_first",
    commissionBps: 0,
    attributionDays: 30,
    holdDays: 30,
    minimumWithdrawal: 0,
    subAffiliateEnabled: false,
  },
  courses: {
    quizDefaults: { ...DEFAULT_QUIZ_DEFAULTS },
    postVideoQuizEnabled: true,
    descriptionMaxLength: 4000,
    categories: [
      { vi: "Khóa học trực tuyến", en: "Online courses" },
      { vi: "Mầm non & K12", en: "Preschool & K12" },
      {
        vi: "Học nghề Sơ cấp - Trung cấp - Cao cấp",
        en: "Vocational training",
      },
      { vi: "Học Cao đẳng - Đại học", en: "College & university" },
      {
        vi: "Chương trình liên kết - Du học",
        en: "Joint programs & study abroad",
      },
      { vi: "Chương trình khuyến học", en: "Scholarship programs" },
    ],
  },
  operations: {
    supportEnabled: false,
    partnerApplicationsEnabled: false,
    invoiceRequestsEnabled: false,
    maxAttachmentMb: 5,
    invoiceInstructions: { vi: "", en: "" },
    activities: [] as Array<{
      kind: string;
      title: { vi: string; en: string };
      description: { vi: string; en: string };
      startsAt: string;
      url: string;
      enabled: boolean;
    }>,
  },
};
