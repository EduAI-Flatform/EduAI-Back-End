export const DEMO_ASSETS = {
  avatar: '/demo-assets/avatar-placeholder.svg',
  certificate: '/demo-assets/certificate-preview.svg',
  course: '/demo-assets/course-placeholder.svg',
  courseThumbnails: [
    '/demo-assets/course-ai-01.svg',
    '/demo-assets/course-ai-02.svg',
    '/demo-assets/course-ai-03.svg',
    '/demo-assets/course-ai-04.svg',
    '/demo-assets/course-ai-05.svg',
    '/demo-assets/course-ai-06.svg',
    '/demo-assets/course-ai-07.svg',
    '/demo-assets/course-ai-08.svg',
    '/demo-assets/course-ai-09.svg',
    '/demo-assets/course-ai-10.svg',
  ],
  document: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
  lesson: '/demo-assets/dashboard-preview.svg',
  video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
} as const;

export const DEMO_ACCOUNTS = {
  student: 'student.demo@eduai.local',
  instructor: 'instructor.demo@eduai.local',
  admin: 'admin.demo@eduai.local',
} as const;

export const DEMO_EXPECTED_COUNTS = {
  roles: 3,
  users: 13,
  profiles: 13,
  userRoles: 13,
  skills: 8,
  portfolios: 2,
  courses: 10,
  lessons: 40,
  enrollments: 53,
  primaryStudentProgress: 16,
  reviews: 51,
  quizzes: 3,
  questions: 12,
  quizAttempts: 2,
  assignments: 3,
  submissions: 2,
  classroomSessions: 4,
  classroomAttendance: 2,
  classroomRecordings: 1,
  libraryCategories: 3,
  libraryTags: 5,
  libraryResources: 6,
  resourceTags: 10,
  savedResources: 2,
  communityPosts: 4,
  communityComments: 6,
  communityReactions: 7,
  certificateTemplates: 1,
  certificates: 2,
} as const;

export function fixtureUuid(namespace: number, index: number): string {
  const prefix = namespace.toString(16).padStart(8, '0');
  const suffix = index.toString(16).padStart(12, '0');
  return `${prefix}-0000-4000-8000-${suffix}`;
}

export const demoUsers = [
  {
    id: fixtureUuid(0x10, 1),
    email: 'kevin.hart@eduai.local',
    fullName: 'Kevin Hart',
    role: 'instructor',
    headline: 'Machine Learning Engineer tại EduAI',
    bio: 'Chuyên gia Machine Learning với hơn 10 năm kinh nghiệm triển khai sản phẩm AI.',
  },
  {
    id: fixtureUuid(0x10, 2),
    email: 'alex.rivers@eduai.local',
    fullName: 'Alex Rivers',
    role: 'instructor',
    headline: 'Tiến sĩ Khoa học Dữ liệu',
    bio: 'Giảng viên khoa học dữ liệu, thống kê ứng dụng và Prompt Engineering.',
  },
  {
    id: fixtureUuid(0x10, 3),
    email: DEMO_ACCOUNTS.instructor,
    fullName: 'Sarah Nguyen',
    role: 'instructor',
    headline: 'AI Research Scientist tại EduAI',
    bio: 'Chuyên gia AI ứng dụng, marketing và phân tích dữ liệu doanh nghiệp.',
  },
  {
    id: fixtureUuid(0x10, 4),
    email: 'minh.tran@eduai.local',
    fullName: 'Minh Tran',
    role: 'instructor',
    headline: 'AI Strategy Consultant',
    bio: 'Tư vấn chiến lược AI và chuyển đổi số cho đội ngũ quản lý.',
  },
  {
    id: fixtureUuid(0x10, 5),
    email: DEMO_ACCOUNTS.student,
    fullName: 'An Nguyen',
    role: 'student',
    headline: 'Data Analyst đang phát triển kỹ năng AI',
    bio: 'Học viên EduAI tập trung vào Machine Learning và phân tích dữ liệu.',
  },
  {
    id: fixtureUuid(0x10, 6),
    email: 'lan.pham@eduai.local',
    fullName: 'Lan Pham',
    role: 'student',
    headline: 'Marketing Specialist',
    bio: 'Quan tâm đến ứng dụng AI trong marketing.',
  },
  {
    id: fixtureUuid(0x10, 7),
    email: 'bao.le@eduai.local',
    fullName: 'Bao Le',
    role: 'student',
    headline: 'Junior Data Engineer',
    bio: 'Đang xây dựng nền tảng dữ liệu và Python.',
  },
  {
    id: fixtureUuid(0x10, 8),
    email: 'mai.hoang@eduai.local',
    fullName: 'Mai Hoang',
    role: 'student',
    headline: 'Product Designer',
    bio: 'Khám phá cách AI hỗ trợ thiết kế sản phẩm.',
  },
  {
    id: fixtureUuid(0x10, 9),
    email: 'quang.vo@eduai.local',
    fullName: 'Quang Vo',
    role: 'student',
    headline: 'Business Analyst',
    bio: 'Ứng dụng dữ liệu để cải thiện quyết định kinh doanh.',
  },
  {
    id: fixtureUuid(0x10, 10),
    email: 'thao.do@eduai.local',
    fullName: 'Thao Do',
    role: 'student',
    headline: 'Content Creator',
    bio: 'Sáng tạo nội dung với các công cụ Generative AI.',
  },
  {
    id: fixtureUuid(0x10, 11),
    email: 'nam.bui@eduai.local',
    fullName: 'Nam Bui',
    role: 'student',
    headline: 'Software Developer',
    bio: 'Phát triển ứng dụng dữ liệu và AI.',
  },
  {
    id: fixtureUuid(0x10, 12),
    email: 'linh.nguyen@eduai.local',
    fullName: 'Linh Nguyen',
    role: 'student',
    headline: 'Project Coordinator',
    bio: 'Học AI để điều phối dự án hiệu quả hơn.',
  },
  {
    id: fixtureUuid(0x10, 13),
    email: DEMO_ACCOUNTS.admin,
    fullName: 'EduAI Admin',
    role: 'platform_admin',
    headline: 'Quản trị nền tảng EduAI',
    bio: 'Tài khoản quản trị demo dùng để kiểm tra phân quyền API.',
  },
] as const;

export const DEMO_IDS = {
  instructors: demoUsers.slice(0, 4).map((user) => user.id),
  primaryInstructor: demoUsers[2].id,
  primaryStudent: demoUsers[4].id,
  supportingStudents: demoUsers.slice(5, 12).map((user) => user.id),
  admin: demoUsers[12].id,
} as const;

export const demoProfiles = demoUsers.map((user, index) => ({
  id: fixtureUuid(0x11, index + 1),
  userId: user.id,
  bio: user.bio,
  headline: user.headline,
  location: index % 2 === 0 ? 'Hồ Chí Minh, Việt Nam' : 'Hà Nội, Việt Nam',
  websiteUrl:
    user.role === 'instructor' ? `https://eduai.local/giang-vien/${index + 1}` : null,
  publicSlug: `demo-${user.email.split('@')[0].replaceAll('.', '-')}`,
  isPublic: user.role !== 'platform_admin',
}));

export const demoUserRoles = demoUsers.map((user, index) => ({
  id: fixtureUuid(0x14, index + 1),
  userId: user.id,
  roleName: user.role,
}));

const primarySkills = [
  ['Python', 'advanced', 'Lập trình'],
  ['SQL', 'advanced', 'Dữ liệu'],
  ['Machine Learning', 'intermediate', 'AI'],
  ['Data Visualization', 'advanced', 'Dữ liệu'],
  ['Prompt Engineering', 'intermediate', 'AI'],
  ['Statistics', 'intermediate', 'Dữ liệu'],
  ['Pandas', 'advanced', 'Lập trình'],
  ['Teamwork', 'advanced', 'Kỹ năng mềm'],
] as const;

export const demoSkills = primarySkills.map(([name, level, category], index) => ({
  id: fixtureUuid(0x12, index + 1),
  userId: DEMO_IDS.primaryStudent,
  name,
  level,
  category,
}));

export const demoPortfolios = [
  {
    id: fixtureUuid(0x13, 1),
    userId: DEMO_IDS.primaryStudent,
    title: 'Dashboard dự báo doanh thu',
    description: 'Mô hình dự báo và dashboard theo dõi doanh thu theo khu vực.',
    projectUrl: 'https://eduai.local/portfolio/revenue-forecast',
    imageUrl: DEMO_ASSETS.course,
  },
  {
    id: fixtureUuid(0x13, 2),
    userId: DEMO_IDS.primaryStudent,
    title: 'Phân tích hành vi khách hàng',
    description: 'Phân cụm khách hàng và đề xuất chiến dịch giữ chân.',
    projectUrl: 'https://eduai.local/portfolio/customer-analysis',
    imageUrl: DEMO_ASSETS.lesson,
  },
] as const;

export const demoCourses = [
  {
    id: fixtureUuid(0x20, 1),
    instructorId: demoUsers[0].id,
    title: 'Làm chủ Machine Learning với Python',
    slug: 'machine-learning-python',
    description:
      'Xây dựng nền tảng vững chắc về thuật toán học máy và ứng dụng thực tế trong doanh nghiệp.',
    level: 'advanced',
    status: 'published',
    visibility: 'public',
    badge: 'Bán chạy nhất',
    featuredRank: 1,
    priceAmountMinor: 1299000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 2),
    instructorId: demoUsers[1].id,
    title: 'Data Science và phân tích dữ liệu với AI',
    slug: 'data-science-2024',
    description:
      'Học cách xử lý dữ liệu lớn, phân tích thống kê và trực quan hóa dữ liệu với các công cụ hàng đầu.',
    level: 'intermediate',
    status: 'published',
    visibility: 'public',
    badge: null,
    featuredRank: 2,
    priceAmountMinor: 899000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 3),
    instructorId: demoUsers[2].id,
    title: 'AI Marketing & Tối ưu hóa chuyển đổi',
    slug: 'ai-marketing',
    description:
      'Ứng dụng Generative AI để tối ưu hóa chiến dịch marketing, tự động hóa nội dung và tăng tỷ lệ chuyển đổi.',
    level: 'beginner',
    status: 'published',
    visibility: 'public',
    badge: 'AI thực chiến',
    featuredRank: 3,
    priceAmountMinor: 750000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 4),
    instructorId: demoUsers[3].id,
    title: 'Nhập môn Trí tuệ nhân tạo',
    slug: 'ai-for-managers',
    description:
      'Hiểu rõ các khái niệm AI để đưa ra quyết định kinh doanh chiến lược và dẫn dắt đội ngũ.',
    level: 'beginner',
    status: 'published',
    visibility: 'public',
    badge: null,
    featuredRank: 4,
    priceAmountMinor: 850000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 5),
    instructorId: demoUsers[0].id,
    title: 'Xây dựng Mạng Nơ-ron từ con số 0',
    slug: 'neural-networks-from-zero',
    description:
      'Khám phá kiến trúc Deep Learning và tự tay triển khai các mô hình nơ-ron cơ bản bằng Python.',
    level: 'advanced',
    status: 'published',
    visibility: 'public',
    badge: null,
    featuredRank: 5,
    priceAmountMinor: 1150000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 6),
    instructorId: demoUsers[2].id,
    title: 'Xây dựng ứng dụng với OpenAI API',
    slug: 'sql-python-data-analysis',
    description:
      'Bộ kỹ năng thiết yếu để trở thành Data Analyst thực thụ trong môi trường doanh nghiệp hiện đại.',
    level: 'intermediate',
    status: 'published',
    visibility: 'public',
    badge: null,
    featuredRank: 6,
    priceAmountMinor: 950000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 7),
    instructorId: demoUsers[1].id,
    title: 'Generative AI và Prompt Engineering',
    slug: 'prompt-engineering-content',
    description:
      'Làm chủ nghệ thuật đặt câu lệnh để khai thác tối đa sức mạnh của các công cụ Generative AI.',
    level: 'beginner',
    status: 'published',
    visibility: 'public',
    badge: 'Nổi bật',
    featuredRank: 7,
    priceAmountMinor: 690000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 8),
    instructorId: demoUsers[2].id,
    title: 'Computer Vision thực chiến',
    slug: 'computer-vision-thuc-chien',
    description: 'Xây dựng pipeline Computer Vision từ xử lý ảnh đến triển khai mô hình nhận diện.',
    level: 'advanced',
    status: 'published',
    visibility: 'public',
    badge: null,
    featuredRank: 8,
    priceAmountMinor: 1390000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 9),
    instructorId: demoUsers[3].id,
    title: 'Natural Language Processing thực chiến',
    slug: 'natural-language-processing-thuc-chien',
    description: 'Khám phá biểu diễn văn bản, phân loại, tìm kiếm ngữ nghĩa và trợ lý ngôn ngữ.',
    level: 'beginner',
    status: 'published',
    visibility: 'public',
    badge: null,
    featuredRank: 9,
    priceAmountMinor: 1190000,
    priceCurrency: 'VND',
  },
  {
    id: fixtureUuid(0x20, 10),
    instructorId: demoUsers[0].id,
    title: 'AI Automation cho doanh nghiệp',
    slug: 'ai-automation-doanh-nghiep',
    description: 'Thiết kế quy trình tự động hóa có kiểm soát bằng AI, workflow và tích hợp dữ liệu doanh nghiệp.',
    level: 'intermediate',
    status: 'published',
    visibility: 'public',
    badge: 'Mới',
    featuredRank: 10,
    priceAmountMinor: 1290000,
    priceCurrency: 'VND',
  },
] as const;

const publicLessonTopics = [
  'Tổng quan và mục tiêu',
  'Khái niệm nền tảng',
  'Thực hành theo tình huống',
  'Tổng kết và bước tiếp theo',
] as const;

export const demoLessons = [
  ...demoCourses.flatMap((course, courseIndex) =>
    publicLessonTopics.map((topic, lessonIndex) => ({
      id: fixtureUuid(0x21, courseIndex * 4 + lessonIndex + 1),
      courseId: course.id,
      title: `${lessonIndex + 1}. ${topic}`,
      slug: `bai-${lessonIndex + 1}-${course.slug}`,
      type: (['video', 'article', 'video', 'pdf'] as const)[lessonIndex],
      content: `Nội dung demo đầy đủ cho “${course.title}” — ${topic}.`,
      videoUrl: lessonIndex === 0 || lessonIndex === 2 ? DEMO_ASSETS.video : null,
      documentUrl: lessonIndex === 3 ? DEMO_ASSETS.document : null,
      orderIndex: lessonIndex + 1,
      durationMinutes: [45, 35, 50, 30][lessonIndex],
      isPreview: lessonIndex === 0,
    })),
  ),
] as const;

const enrollmentPairs = [
  ...demoCourses.slice(0, 4).map((course) => ({
    userId: DEMO_IDS.primaryStudent,
    courseId: course.id,
  })),
  ...DEMO_IDS.supportingStudents.flatMap((userId) =>
    demoCourses.slice(0, 7).map((course) => ({ userId, courseId: course.id })),
  ),
];

export const demoEnrollments = enrollmentPairs.map((pair, index) => ({
  id: fixtureUuid(0x30, index + 1),
  ...pair,
  status:
    pair.userId === DEMO_IDS.primaryStudent &&
    (pair.courseId === demoCourses[0].id || pair.courseId === demoCourses[1].id)
      ? 'completed'
      : 'active',
}));

export const demoProgress = demoCourses.slice(0, 4).flatMap((course, courseIndex) =>
  demoLessons
    .filter((lesson) => lesson.courseId === course.id)
    .map((lesson, lessonIndex) => {
      const completed =
        courseIndex < 2 ||
        (courseIndex === 2 && lessonIndex < 2) ||
        (courseIndex === 3 && lessonIndex < 1);
      const inProgress =
        (courseIndex === 2 && lessonIndex === 2) ||
        (courseIndex === 3 && lessonIndex === 1);
      return {
        id: fixtureUuid(0x31, courseIndex * 4 + lessonIndex + 1),
        userId: DEMO_IDS.primaryStudent,
        courseId: course.id,
        lessonId: lesson.id,
        status: completed ? 'completed' : inProgress ? 'in_progress' : 'not_started',
        progressPercent: completed ? 100 : inProgress ? 60 : 0,
        completed,
        lastAccessOffsetDays: courseIndex * 2 + lessonIndex,
      };
    }),
);

export const demoReviews = [
  ...DEMO_IDS.supportingStudents.flatMap((userId, studentIndex) =>
    demoCourses.slice(0, 7).map((course, courseIndex) => ({
      userId,
      courseId: course.id,
      rating: 3 + ((studentIndex + courseIndex) % 3),
      comment:
        (studentIndex + courseIndex) % 3 === 0
          ? 'Nội dung rõ ràng, ví dụ thực tế và dễ áp dụng.'
          : null,
    })),
  ),
  {
    userId: DEMO_IDS.primaryStudent,
    courseId: demoCourses[0].id,
    rating: 5,
    comment: 'Khóa học có lộ trình tốt và bài tập sát thực tế.',
  },
  {
    userId: DEMO_IDS.primaryStudent,
    courseId: demoCourses[1].id,
    rating: 5,
    comment: 'Phần trực quan hóa dữ liệu rất hữu ích.',
  },
].map((review, index) => ({
  id: fixtureUuid(0x32, index + 1),
  ...review,
}));

export const demoQuizzes = demoCourses.slice(0, 3).map((course, index) => ({
  id: fixtureUuid(0x40, index + 1),
  courseId: course.id,
  lessonId: demoLessons[index * 4 + 3].id,
  title: `Đánh giá kiến thức: ${course.title}`,
  description: 'Bài kiểm tra tổng hợp gồm bốn câu hỏi.',
  passingScore: 70,
  timeLimitMinutes: 20,
  status: 'published',
}));

export const demoQuestions = demoQuizzes.flatMap((quiz, quizIndex) => [
  {
    id: fixtureUuid(0x41, quizIndex * 4 + 1),
    quizId: quiz.id,
    type: 'multiple_choice',
    questionText: 'Bước đầu tiên khi giải quyết một bài toán dữ liệu là gì?',
    optionsJson: ['Xác định mục tiêu', 'Chọn mô hình', 'Triển khai', 'Tối ưu giao diện'],
    correctAnswerJson: 'Xác định mục tiêu',
    explanation: 'Mục tiêu rõ ràng quyết định dữ liệu và phương pháp phù hợp.',
    points: 1,
    orderIndex: 1,
  },
  {
    id: fixtureUuid(0x41, quizIndex * 4 + 2),
    quizId: quiz.id,
    type: 'true_false',
    questionText: 'Cần đánh giá chất lượng dữ liệu trước khi huấn luyện mô hình.',
    optionsJson: null,
    correctAnswerJson: true,
    explanation: 'Dữ liệu đầu vào ảnh hưởng trực tiếp đến kết quả.',
    points: 1,
    orderIndex: 2,
  },
  {
    id: fixtureUuid(0x41, quizIndex * 4 + 3),
    quizId: quiz.id,
    type: 'multiple_choice',
    questionText: 'Cách tốt nhất để kiểm tra khả năng tổng quát hóa là gì?',
    optionsJson: ['Dùng tập kiểm thử', 'Tăng số epoch', 'Bỏ dữ liệu lỗi', 'Chỉ xem loss train'],
    correctAnswerJson: 'Dùng tập kiểm thử',
    explanation: 'Tập kiểm thử độc lập giúp đo khả năng tổng quát hóa.',
    points: 1,
    orderIndex: 3,
  },
  {
    id: fixtureUuid(0x41, quizIndex * 4 + 4),
    quizId: quiz.id,
    type: 'short_answer',
    questionText: 'Từ khóa mô tả quá trình cải thiện mô hình dựa trên kết quả đánh giá?',
    optionsJson: null,
    correctAnswerJson: 'lặp',
    explanation: 'Quy trình dữ liệu hiệu quả luôn có tính lặp.',
    points: 1,
    orderIndex: 4,
  },
]);

export const demoQuizAttempts = demoQuizzes.slice(0, 2).map((quiz, index) => ({
  id: fixtureUuid(0x42, index + 1),
  quizId: quiz.id,
  userId: DEMO_IDS.primaryStudent,
  score: index === 0 ? 4 : 1,
  maxScore: 4,
  passed: index === 0,
  answersJson: demoQuestions
    .filter((question) => question.quizId === quiz.id)
    .map((question) => ({
      questionId: question.id,
      answer: question.correctAnswerJson,
    })),
  offsetDays: index + 2,
}));

export const demoAssignments = demoCourses.slice(0, 3).map((course, index) => ({
  id: fixtureUuid(0x50, index + 1),
  courseId: course.id,
  lessonId: demoLessons[index * 4 + 2].id,
  title: [
    'Xây dựng mô hình dự báo đầu tiên',
    'Phân tích bộ dữ liệu bán hàng',
    'Thiết kế chiến dịch AI Marketing',
  ][index],
  description: 'Nộp báo cáo ngắn kèm mã nguồn hoặc liên kết sản phẩm.',
  dueOffsetDays: index === 2 ? -2 : index + 1,
  maxScore: 100,
  status: 'published',
}));

export const demoSubmissions = [
  {
    id: fixtureUuid(0x51, 1),
    assignmentId: demoAssignments[2].id,
    userId: DEMO_IDS.primaryStudent,
    content: 'Kế hoạch chiến dịch AI Marketing và bộ prompt nội dung thử nghiệm.',
    score: null,
    feedback: null,
    status: 'submitted',
    gradedById: null,
    submittedOffsetDays: 1,
  },
  {
    id: fixtureUuid(0x51, 2),
    assignmentId: demoAssignments[1].id,
    userId: DEMO_IDS.supportingStudents[0],
    content: 'Báo cáo phân tích doanh thu theo sản phẩm và khu vực.',
    score: 88,
    feedback: 'Phân tích tốt, cần bổ sung giải thích cho các ngoại lệ.',
    status: 'graded',
    gradedById: demoUsers[1].id,
    submittedOffsetDays: 2,
  },
] as const;

export const demoClassroomSessions = [
  {
    id: fixtureUuid(0x60, 1),
    courseId: demoCourses[0].id,
    instructorId: demoCourses[0].instructorId,
    title: 'Hỏi đáp trực tiếp về Machine Learning',
    description: 'Giải đáp bài tập và các lỗi thường gặp.',
    roomName: 'eduai-demo-machine-learning',
    startOffsetHours: 26,
    durationMinutes: 90,
    status: 'scheduled',
  },
  {
    id: fixtureUuid(0x60, 2),
    courseId: demoCourses[3].id,
    instructorId: demoCourses[3].instructorId,
    title: 'Workshop Nhập môn AI',
    description: 'Thực hành nhận diện cơ hội ứng dụng AI trong công việc.',
    roomName: 'eduai-demo-ai-foundations',
    startOffsetHours: -1,
    durationMinutes: 120,
    status: 'live',
  },
  {
    id: fixtureUuid(0x60, 3),
    courseId: demoCourses[1].id,
    instructorId: demoCourses[1].instructorId,
    title: 'Chữa bài Data Science',
    description: 'Xem lại bài phân tích dữ liệu bán hàng.',
    roomName: 'eduai-demo-data-science-ended',
    startOffsetHours: -48,
    durationMinutes: 75,
    status: 'ended',
  },
  {
    id: fixtureUuid(0x60, 4),
    courseId: demoCourses[7].id,
    instructorId: demoCourses[7].instructorId,
    title: 'Phòng thực hành Computer Vision',
    description: 'Buổi học thuộc khóa chưa đăng ký để kiểm thử quyền truy cập.',
    roomName: 'eduai-demo-computer-vision-restricted',
    startOffsetHours: 48,
    durationMinutes: 90,
    status: 'scheduled',
  },
] as const;

export const demoAttendance = DEMO_IDS.supportingStudents.slice(0, 2).map(
  (userId, index) => ({
    id: fixtureUuid(0x61, index + 1),
    sessionId: demoClassroomSessions[2].id,
    userId,
    joinedOffsetMinutes: index * 5,
    durationSeconds: 3600 - index * 300,
  }),
);

export const demoClassroomRecordings = [
  {
    id: fixtureUuid(0x62, 1),
    sessionId: demoClassroomSessions[2].id,
    recordingUrl: DEMO_ASSETS.lesson,
    durationSeconds: 4200,
  },
] as const;

export const demoLibraryCategories = [
  {
    id: fixtureUuid(0x70, 1),
    name: 'Tài liệu học tập',
    slug: 'tai-lieu-hoc-tap',
    description: 'Giáo trình và ghi chú cho các khóa học.',
  },
  {
    id: fixtureUuid(0x70, 2),
    name: 'Mẫu dự án',
    slug: 'mau-du-an',
    description: 'Notebook, báo cáo và mẫu triển khai.',
  },
  {
    id: fixtureUuid(0x70, 3),
    name: 'Video chuyên đề',
    slug: 'video-chuyen-de',
    description: 'Các buổi chia sẻ theo chủ đề.',
  },
] as const;

export const demoLibraryTags = ['Python', 'AI', 'Dữ liệu', 'Marketing', 'Cơ bản'].map(
  (name, index) => ({
    id: fixtureUuid(0x71, index + 1),
    name,
    slug: ['python', 'ai', 'du-lieu', 'marketing', 'co-ban'][index],
  }),
);

export const demoLibraryResources = [
  ['Cẩm nang Machine Learning với Python', 0, 'pdf', 0],
  ['Notebook phân tích dữ liệu bán hàng', 1, 'docx', 2],
  ['Slide tổng quan Generative AI', 0, 'pptx', 1],
  ['Video xây dựng chiến dịch AI Marketing', 2, 'video', 2],
  ['Infographic quy trình Data Science', 0, 'image', 1],
  ['Mẫu báo cáo đánh giá mô hình', 1, 'docx', 0],
].map(([title, categoryIndex, type, ownerIndex], index) => ({
  id: fixtureUuid(0x72, index + 1),
  ownerId: demoUsers[Number(ownerIndex)].id,
  categoryId: demoLibraryCategories[Number(categoryIndex)].id,
  title: String(title),
  description: `Tài nguyên demo có thể chọn làm nguồn AI: ${title}.`,
  type: String(type),
  fileUrl: type === 'pdf' ? DEMO_ASSETS.document : type === 'video' ? null : DEMO_ASSETS.lesson,
  externalUrl: type === 'video' ? DEMO_ASSETS.video : null,
  visibility: 'public',
}));

const resourceTagPairs = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 2],
  [2, 1],
  [2, 4],
  [3, 1],
  [3, 3],
  [4, 2],
  [5, 2],
] as const;

export const demoResourceTags = resourceTagPairs.map(
  ([resourceIndex, tagIndex], index) => ({
    id: fixtureUuid(0x73, index + 1),
    resourceId: demoLibraryResources[resourceIndex].id,
    tagId: demoLibraryTags[tagIndex].id,
  }),
);

export const demoSavedResources = demoLibraryResources.slice(0, 2).map(
  (resource, index) => ({
    id: fixtureUuid(0x74, index + 1),
    userId: DEMO_IDS.primaryStudent,
    resourceId: resource.id,
  }),
);

export const demoCommunityPosts = [
  {
    id: fixtureUuid(0x80, 1),
    authorId: DEMO_IDS.primaryStudent,
    title: 'Chia sẻ cách học Machine Learning hiệu quả',
    content: 'Mình chia nhỏ mỗi bài học, thực hành ngay và ghi lại câu hỏi để trao đổi.',
  },
  {
    id: fixtureUuid(0x80, 2),
    authorId: demoUsers[2].id,
    title: 'Tài nguyên mới: Bộ mẫu Prompt Marketing',
    content: 'Bộ mẫu đã có trong thư viện, mọi người có thể dùng trực tiếp trong công cụ AI.',
  },
  {
    id: fixtureUuid(0x80, 3),
    authorId: DEMO_IDS.supportingStudents[2],
    title: 'Hỏi về cách đánh giá mô hình',
    content: 'Khi dữ liệu lệch lớp, mọi người ưu tiên chỉ số nào ngoài accuracy?',
  },
  {
    id: fixtureUuid(0x80, 4),
    authorId: demoUsers[1].id,
    title: 'Lịch workshop Data Science tuần này',
    content: 'Workshop tập trung vào trực quan hóa và diễn giải kết quả cho người dùng kinh doanh.',
  },
] as const;

export const demoCommunityComments = [
  {
    id: fixtureUuid(0x81, 1),
    postId: demoCommunityPosts[0].id,
    authorId: DEMO_IDS.supportingStudents[0],
    parentId: null,
    content: 'Cách chia nhỏ bài học rất hữu ích, cảm ơn bạn.',
  },
  {
    id: fixtureUuid(0x81, 2),
    postId: demoCommunityPosts[0].id,
    authorId: DEMO_IDS.primaryStudent,
    parentId: fixtureUuid(0x81, 1),
    content: 'Mình sẽ chia sẻ thêm checklist thực hành.',
  },
  {
    id: fixtureUuid(0x81, 3),
    postId: demoCommunityPosts[1].id,
    authorId: DEMO_IDS.supportingStudents[1],
    parentId: null,
    content: 'Mình đã thử và tạo được outline chiến dịch rất nhanh.',
  },
  {
    id: fixtureUuid(0x81, 4),
    postId: demoCommunityPosts[2].id,
    authorId: demoUsers[0].id,
    parentId: null,
    content: 'Bạn nên xem thêm precision, recall, F1 và ma trận nhầm lẫn.',
  },
  {
    id: fixtureUuid(0x81, 5),
    postId: demoCommunityPosts[2].id,
    authorId: DEMO_IDS.supportingStudents[3],
    parentId: null,
    content: 'Mình thường chọn F1 khi cần cân bằng precision và recall.',
  },
  {
    id: fixtureUuid(0x81, 6),
    postId: demoCommunityPosts[3].id,
    authorId: DEMO_IDS.primaryStudent,
    parentId: null,
    content: 'Mình đã đăng ký, hẹn gặp mọi người trong workshop.',
  },
] as const;

const reactionPairs = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 3],
  [2, 4],
  [3, 0],
] as const;

export const demoCommunityReactions = reactionPairs.map(
  ([postIndex, studentIndex], index) => ({
    id: fixtureUuid(0x82, index + 1),
    postId: demoCommunityPosts[postIndex].id,
    userId: [DEMO_IDS.primaryStudent, ...DEMO_IDS.supportingStudents][studentIndex],
    type: 'like',
  }),
);

export const demoCertificateTemplates = [
  {
    id: fixtureUuid(0x90, 1),
    name: 'Chứng chỉ hoàn thành EduAI',
    description: 'Mẫu chứng chỉ chuẩn cho khóa học đã hoàn thành.',
    backgroundUrl: DEMO_ASSETS.certificate,
    layoutJson: {
      theme: 'eduai',
      accentColor: '#0f766e',
      orientation: 'landscape',
    },
  },
] as const;

export const demoCertificates = demoCourses.slice(0, 2).map((course, index) => ({
  id: fixtureUuid(0x91, index + 1),
  userId: DEMO_IDS.primaryStudent,
  courseId: course.id,
  certificateTemplateId: demoCertificateTemplates[0].id,
  certificateCode: `EDUAI-DEMO-2026-00${index + 1}`,
  title: `Chứng chỉ hoàn thành: ${course.title}`,
  metadataJson: { demo: true, version: 1 },
  issuedOffsetDays: 14 - index * 4,
}));

export const demoFixtureIds = {
  users: demoUsers.map(({ id }) => id),
  profiles: demoProfiles.map(({ id }) => id),
  userRoles: demoUserRoles.map(({ id }) => id),
  skills: demoSkills.map(({ id }) => id),
  portfolios: demoPortfolios.map(({ id }) => id),
  courses: demoCourses.map(({ id }) => id),
  lessons: demoLessons.map(({ id }) => id),
  enrollments: demoEnrollments.map(({ id }) => id),
  progress: demoProgress.map(({ id }) => id),
  reviews: demoReviews.map(({ id }) => id),
  quizzes: demoQuizzes.map(({ id }) => id),
  questions: demoQuestions.map(({ id }) => id),
  quizAttempts: demoQuizAttempts.map(({ id }) => id),
  assignments: demoAssignments.map(({ id }) => id),
  submissions: demoSubmissions.map(({ id }) => id),
  classroomSessions: demoClassroomSessions.map(({ id }) => id),
  classroomAttendance: demoAttendance.map(({ id }) => id),
  classroomRecordings: demoClassroomRecordings.map(({ id }) => id),
  libraryCategories: demoLibraryCategories.map(({ id }) => id),
  libraryTags: demoLibraryTags.map(({ id }) => id),
  libraryResources: demoLibraryResources.map(({ id }) => id),
  resourceTags: demoResourceTags.map(({ id }) => id),
  savedResources: demoSavedResources.map(({ id }) => id),
  communityPosts: demoCommunityPosts.map(({ id }) => id),
  communityComments: demoCommunityComments.map(({ id }) => id),
  communityReactions: demoCommunityReactions.map(({ id }) => id),
  certificateTemplates: demoCertificateTemplates.map(({ id }) => id),
  certificates: demoCertificates.map(({ id }) => id),
} as const;
