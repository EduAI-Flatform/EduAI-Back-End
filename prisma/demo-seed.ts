import {
  Prisma,
  type AssignmentStatus,
  type ClassroomSessionStatus,
  type PrismaClient,
  type QuestionType,
  type QuizStatus,
  type RoleName,
  type SubmissionStatus,
} from '../generated/prisma/client';
import { PasswordService } from '../src/modules/auth/password.service';
import {
  DEMO_ASSETS,
  DEMO_IDS,
  demoAssignments,
  demoAttendance,
  demoCertificateTemplates,
  demoCertificates,
  demoClassroomRecordings,
  demoClassroomSessions,
  demoCommunityComments,
  demoCommunityPosts,
  demoCommunityReactions,
  demoCourses,
  demoEnrollments,
  demoLessons,
  demoLibraryCategories,
  demoLibraryResources,
  demoLibraryTags,
  demoPortfolios,
  demoProfiles,
  demoProgress,
  demoQuestions,
  demoQuizAttempts,
  demoQuizzes,
  demoResourceTags,
  demoReviews,
  demoSavedResources,
  demoSkills,
  demoSubmissions,
  demoUserRoles,
  demoUsers,
} from './demo-fixtures';
import {
  assertDemoFixtureContract,
  verifyDemoData,
} from './demo-contract';
import { seedFinalDemoData } from './final-demo-seed';

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function addMinutes(date: Date, minutes: number): Date {
  return addMilliseconds(date, minutes * 60 * 1000);
}

function addHours(date: Date, hours: number): Date {
  return addMinutes(date, hours * 60);
}

function addDays(date: Date, days: number): Date {
  return addHours(date, days * 24);
}

export async function seedDemoData(
  prisma: PrismaClient,
  password: string,
): Promise<void> {
  assertDemoFixtureContract();

  const seedNow = new Date();
  const passwordHash = await new PasswordService().hashPassword(password);
  const publicAppUrl = (
    process.env.PUBLIC_APP_URL?.trim() || 'http://localhost:5173'
  ).replace(/\/+$/, '');

  for (const user of demoUsers) {
    const data = {
      email: user.email,
      passwordHash,
      fullName: user.fullName,
      avatarUrl: DEMO_ASSETS.avatar,
      status: 'active' as const,
      deletedAt: null,
    };
    await prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, ...data },
      update: data,
    });
  }

  const roles = await prisma.role.findMany({
    where: {
      name: {
        in: ['student', 'instructor', 'platform_admin'],
      },
    },
    select: { id: true, name: true },
  });
  const roleIds = new Map(roles.map((role) => [role.name, role.id]));

  for (const userRole of demoUserRoles) {
    const roleId = roleIds.get(userRole.roleName as RoleName);
    if (!roleId) {
      throw new Error(`Missing seeded role: ${userRole.roleName}`);
    }
    await prisma.userRole.upsert({
      where: { id: userRole.id },
      create: {
        id: userRole.id,
        userId: userRole.userId,
        roleId,
      },
      update: {
        userId: userRole.userId,
        roleId,
      },
    });
  }

  for (const profile of demoProfiles) {
    const data = {
      userId: profile.userId,
      bio: profile.bio,
      headline: profile.headline,
      location: profile.location,
      websiteUrl: profile.websiteUrl,
      publicSlug: profile.publicSlug,
      isPublic: profile.isPublic,
    };
    await prisma.userProfile.upsert({
      where: { id: profile.id },
      create: { id: profile.id, ...data },
      update: data,
    });
  }

  for (const skill of demoSkills) {
    const data = {
      userId: skill.userId,
      name: skill.name,
      level: skill.level,
      category: skill.category,
    };
    await prisma.userSkill.upsert({
      where: { id: skill.id },
      create: { id: skill.id, ...data },
      update: data,
    });
  }

  for (const [index, portfolio] of demoPortfolios.entries()) {
    const data = {
      userId: portfolio.userId,
      title: portfolio.title,
      description: portfolio.description,
      projectUrl: portfolio.projectUrl,
      imageUrl: portfolio.imageUrl,
      startDate: addDays(seedNow, -120 - index * 60),
      endDate: addDays(seedNow, -30 - index * 15),
      deletedAt: null,
    };
    await prisma.portfolio.upsert({
      where: { id: portfolio.id },
      create: { id: portfolio.id, ...data },
      update: data,
    });
  }

  for (const [courseIndex, course] of demoCourses.entries()) {
    const data = {
      instructorId: course.instructorId,
      title: course.title,
      slug: course.slug,
      description: course.description,
      thumbnailUrl: DEMO_ASSETS.courseThumbnails[courseIndex],
      level: course.level,
      status: course.status,
      visibility: course.visibility,
      badge: course.badge,
      featuredRank: course.featuredRank,
      priceAmountMinor: course.priceAmountMinor,
      priceCurrency: course.priceCurrency,
      deletedAt: null,
    };
    await prisma.course.upsert({
      where: { id: course.id },
      create: { id: course.id, ...data },
      update: data,
    });
  }

  for (const lesson of demoLessons) {
    const data = {
      courseId: lesson.courseId,
      title: lesson.title,
      slug: lesson.slug,
      type: lesson.type,
      content: lesson.content,
      videoUrl: lesson.videoUrl,
      documentUrl: lesson.documentUrl,
      orderIndex: lesson.orderIndex,
      durationMinutes: lesson.durationMinutes,
      isPreview: lesson.isPreview,
      deletedAt: null,
    };
    await prisma.lesson.upsert({
      where: { id: lesson.id },
      create: { id: lesson.id, ...data },
      update: data,
    });
  }

  for (const [index, enrollment] of demoEnrollments.entries()) {
    const enrolledAt = addDays(seedNow, -45 + (index % 12));
    const completedAt =
      enrollment.status === 'completed' ? addDays(seedNow, -14 + index) : null;
    const data = {
      userId: enrollment.userId,
      courseId: enrollment.courseId,
      status: enrollment.status,
      enrolledAt,
      completedAt,
    };
    await prisma.enrollment.upsert({
      where: { id: enrollment.id },
      create: { id: enrollment.id, ...data },
      update: data,
    });
  }

  for (const progress of demoProgress) {
    const completedAt = progress.completed
      ? addDays(seedNow, -progress.lastAccessOffsetDays - 1)
      : null;
    const data = {
      userId: progress.userId,
      courseId: progress.courseId,
      lessonId: progress.lessonId,
      status: progress.status,
      progressPercent: progress.progressPercent,
      completedAt,
      lastAccessedAt: addDays(seedNow, -progress.lastAccessOffsetDays),
    };
    await prisma.learningProgress.upsert({
      where: { id: progress.id },
      create: { id: progress.id, ...data },
      update: data,
    });
  }

  for (const review of demoReviews) {
    const data = {
      userId: review.userId,
      courseId: review.courseId,
      rating: review.rating,
      comment: review.comment,
    };
    await prisma.courseReview.upsert({
      where: { id: review.id },
      create: { id: review.id, ...data },
      update: data,
    });
  }

  for (const quiz of demoQuizzes) {
    const data = {
      courseId: quiz.courseId,
      lessonId: quiz.lessonId,
      title: quiz.title,
      description: quiz.description,
      passingScore: quiz.passingScore,
      timeLimitMinutes: quiz.timeLimitMinutes,
      status: quiz.status as QuizStatus,
      deletedAt: null,
    };
    await prisma.quiz.upsert({
      where: { id: quiz.id },
      create: { id: quiz.id, ...data },
      update: data,
    });
  }

  for (const question of demoQuestions) {
    const optionsJson =
      question.optionsJson === null
        ? Prisma.DbNull
        : (question.optionsJson as Prisma.InputJsonArray);
    const data = {
      quizId: question.quizId,
      type: question.type as QuestionType,
      questionText: question.questionText,
      optionsJson,
      correctAnswerJson:
        question.correctAnswerJson as Prisma.InputJsonValue,
      explanation: question.explanation,
      points: question.points,
      orderIndex: question.orderIndex,
    };
    await prisma.question.upsert({
      where: { id: question.id },
      create: { id: question.id, ...data },
      update: data,
    });
  }

  for (const attempt of demoQuizAttempts) {
    const submittedAt = addDays(seedNow, -attempt.offsetDays);
    const data = {
      quizId: attempt.quizId,
      userId: attempt.userId,
      score: attempt.score,
      maxScore: attempt.maxScore,
      passed: attempt.passed,
      answersJson: attempt.answersJson as Prisma.InputJsonArray,
      startedAt: addMinutes(submittedAt, -15),
      submittedAt,
    };
    await prisma.quizAttempt.upsert({
      where: { id: attempt.id },
      create: { id: attempt.id, ...data },
      update: data,
    });
  }

  for (const assignment of demoAssignments) {
    const data = {
      courseId: assignment.courseId,
      lessonId: assignment.lessonId,
      title: assignment.title,
      description: assignment.description,
      dueDate: addDays(seedNow, assignment.dueOffsetDays),
      maxScore: assignment.maxScore,
      status: assignment.status as AssignmentStatus,
      deletedAt: null,
    };
    await prisma.assignment.upsert({
      where: { id: assignment.id },
      create: { id: assignment.id, ...data },
      update: data,
    });
  }

  for (const submission of demoSubmissions) {
    const submittedAt = addDays(seedNow, -submission.submittedOffsetDays);
    const gradedAt =
      submission.status === 'graded' ? addHours(submittedAt, 8) : null;
    const data = {
      assignmentId: submission.assignmentId,
      userId: submission.userId,
      content: submission.content,
      fileUrl: null,
      score: submission.score,
      feedback: submission.feedback,
      status: submission.status as SubmissionStatus,
      submittedAt,
      gradedAt,
      gradedById: submission.gradedById,
    };
    await prisma.submission.upsert({
      where: { id: submission.id },
      create: { id: submission.id, ...data },
      update: data,
    });
  }

  for (const session of demoClassroomSessions) {
    const scheduledStart = addHours(seedNow, session.startOffsetHours);
    const scheduledEnd = addMinutes(
      scheduledStart,
      session.durationMinutes,
    );
    const isEnded = session.status === 'ended';
    const isLive = session.status === 'live';
    const data = {
      courseId: session.courseId,
      instructorId: session.instructorId,
      title: session.title,
      description: session.description,
      provider: 'jitsi',
      meetingUrl: null,
      roomName: session.roomName,
      scheduledStart,
      scheduledEnd,
      actualStart: isEnded || isLive ? scheduledStart : null,
      actualEnd: isEnded ? scheduledEnd : null,
      status: session.status as ClassroomSessionStatus,
      deletedAt: null,
    };
    await prisma.classroomSession.upsert({
      where: { id: session.id },
      create: { id: session.id, ...data },
      update: data,
    });
  }

  const endedSession = demoClassroomSessions[2];
  const endedStart = addHours(seedNow, endedSession.startOffsetHours);
  for (const attendance of demoAttendance) {
    const joinedAt = addMinutes(
      endedStart,
      attendance.joinedOffsetMinutes,
    );
    const data = {
      sessionId: attendance.sessionId,
      userId: attendance.userId,
      joinedAt,
      leftAt: addMilliseconds(
        joinedAt,
        attendance.durationSeconds * 1000,
      ),
      durationSeconds: attendance.durationSeconds,
    };
    await prisma.classroomAttendance.upsert({
      where: { id: attendance.id },
      create: { id: attendance.id, ...data },
      update: data,
    });
  }

  for (const recording of demoClassroomRecordings) {
    const data = {
      sessionId: recording.sessionId,
      recordingUrl: recording.recordingUrl,
      durationSeconds: recording.durationSeconds,
    };
    await prisma.classroomRecording.upsert({
      where: { id: recording.id },
      create: { id: recording.id, ...data },
      update: data,
    });
  }

  for (const category of demoLibraryCategories) {
    const data = {
      name: category.name,
      slug: category.slug,
      description: category.description,
    };
    await prisma.libraryCategory.upsert({
      where: { id: category.id },
      create: { id: category.id, ...data },
      update: data,
    });
  }

  for (const tag of demoLibraryTags) {
    const data = {
      name: tag.name,
      slug: tag.slug,
    };
    await prisma.libraryTag.upsert({
      where: { id: tag.id },
      create: { id: tag.id, ...data },
      update: data,
    });
  }

  for (const resource of demoLibraryResources) {
    const data = {
      ownerId: resource.ownerId,
      categoryId: resource.categoryId,
      title: resource.title,
      description: resource.description,
      type: resource.type,
      fileUrl: resource.fileUrl,
      externalUrl: resource.externalUrl,
      visibility: resource.visibility,
      deletedAt: null,
    };
    await prisma.libraryResource.upsert({
      where: { id: resource.id },
      create: { id: resource.id, ...data },
      update: data,
    });
  }

  for (const resourceTag of demoResourceTags) {
    const data = {
      resourceId: resourceTag.resourceId,
      tagId: resourceTag.tagId,
    };
    await prisma.resourceTag.upsert({
      where: { id: resourceTag.id },
      create: { id: resourceTag.id, ...data },
      update: data,
    });
  }

  for (const savedResource of demoSavedResources) {
    const data = {
      userId: savedResource.userId,
      resourceId: savedResource.resourceId,
    };
    await prisma.savedResource.upsert({
      where: { id: savedResource.id },
      create: { id: savedResource.id, ...data },
      update: data,
    });
  }

  for (const [index, post] of demoCommunityPosts.entries()) {
    const data = {
      authorId: post.authorId,
      title: post.title,
      content: post.content,
      visibility: 'public',
      status: 'active',
      createdAt: addDays(seedNow, -index - 1),
      deletedAt: null,
    };
    await prisma.communityPost.upsert({
      where: { id: post.id },
      create: { id: post.id, ...data },
      update: data,
    });
  }

  for (const [index, comment] of demoCommunityComments.entries()) {
    const data = {
      postId: comment.postId,
      authorId: comment.authorId,
      parentId: comment.parentId,
      content: comment.content,
      status: 'active',
      createdAt: addHours(seedNow, -20 - index),
      deletedAt: null,
    };
    await prisma.communityComment.upsert({
      where: { id: comment.id },
      create: { id: comment.id, ...data },
      update: data,
    });
  }

  for (const reaction of demoCommunityReactions) {
    const data = {
      postId: reaction.postId,
      userId: reaction.userId,
      type: reaction.type,
    };
    await prisma.communityReaction.upsert({
      where: { id: reaction.id },
      create: { id: reaction.id, ...data },
      update: data,
    });
  }

  for (const template of demoCertificateTemplates) {
    const data = {
      name: template.name,
      description: template.description,
      backgroundUrl: template.backgroundUrl,
      layoutJson: template.layoutJson as Prisma.InputJsonObject,
    };
    await prisma.certificateTemplate.upsert({
      where: { id: template.id },
      create: { id: template.id, ...data },
      update: data,
    });
  }

  for (const certificate of demoCertificates) {
    const verificationUrl = `${publicAppUrl}/certificates/verify/${encodeURIComponent(
      certificate.certificateCode,
    )}`;
    const data = {
      userId: certificate.userId,
      courseId: certificate.courseId,
      certificateTemplateId: certificate.certificateTemplateId,
      certificateCode: certificate.certificateCode,
      title: certificate.title,
      issuedAt: addDays(seedNow, -certificate.issuedOffsetDays),
      verificationUrl,
      qrCodeUrl: null,
      metadataJson: certificate.metadataJson as Prisma.InputJsonObject,
    };
    await prisma.certificate.upsert({
      where: { id: certificate.id },
      create: { id: certificate.id, ...data },
      update: data,
    });
  }

  await seedFinalDemoData(prisma);

  const verification = await verifyDemoData(prisma);
  process.stdout.write(
    `Demo seed verified for student ${DEMO_IDS.primaryStudent}: ${JSON.stringify(
      verification.counts,
    )}\n`,
  );
}
