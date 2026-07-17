import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiRateLimitService } from './ai-rate-limit.service';
import { AiSummaryService } from './ai-summary.service';
import { CreateAiGenerationDto } from './dto/create-ai-generation.dto';
import { OpenAiService } from './openai.service';

interface GeneratedQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
}

interface GeneratedFlashcard {
  front: string;
  back: string;
}

export interface AiQuizResponse {
  quizId: string;
  sourceType: CreateAiGenerationDto['sourceType'];
  sourceId: string;
  questions: GeneratedQuestion[];
}

export interface AiFlashcardsResponse {
  sourceType: CreateAiGenerationDto['sourceType'];
  sourceId: string;
  flashcards: Array<GeneratedFlashcard & { id: string }>;
}

@Injectable()
export class AiGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
    private readonly rateLimit: AiRateLimitService,
    private readonly summary: AiSummaryService,
  ) {}

  async generateQuiz(user: AuthenticatedUser, input: CreateAiGenerationDto): Promise<AiQuizResponse> {
    await this.rateLimit.assertQuizAllowed(user.id);
    const source = await this.summary.resolveSource(user, input);
    if (!source) throw new NotFoundException('AI generation source not found');
    const questions = await this.generateJson<GeneratedQuestion[]>(
      'Generate a JSON object with an items array of multiple-choice questions. Each item must contain question, options (exactly 4 strings), correctAnswer (one option), and explanation.',
      source.title,
      source.content,
      input.count,
    );
    this.validateQuestions(questions);

    const quiz = await this.prisma.aiGeneratedQuiz.create({
      data: { userId: user.id, sourceType: input.sourceType, sourceId: input.sourceId, outputJson: questions as unknown as Prisma.InputJsonValue },
      select: { id: true },
    });

    return { quizId: quiz.id, sourceType: input.sourceType, sourceId: input.sourceId, questions };
  }

  async generateFlashcards(user: AuthenticatedUser, input: CreateAiGenerationDto): Promise<AiFlashcardsResponse> {
    await this.rateLimit.assertFlashcardsAllowed(user.id);
    const source = await this.summary.resolveSource(user, input);
    if (!source) throw new NotFoundException('AI generation source not found');
    const flashcards = await this.generateJson<GeneratedFlashcard[]>(
      'Generate a JSON object with an items array of study flashcards. Each item must contain a concise front and an accurate back.',
      source.title,
      source.content,
      input.count,
    );
    this.validateFlashcards(flashcards);

    const created = await this.prisma.$transaction(
      flashcards.map((card) => this.prisma.aiFlashcard.create({
        data: { userId: user.id, sourceType: input.sourceType, sourceId: input.sourceId, front: card.front, back: card.back },
        select: { id: true, front: true, back: true },
      })),
    );

    return { sourceType: input.sourceType, sourceId: input.sourceId, flashcards: created };
  }

  private async generateJson<T>(instruction: string, title: string, content: string, count: number): Promise<T> {
    const completion = await this.openai.getClient().chat.completions.create({
      model: this.openai.getModel(),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You generate structured educational content. Return valid JSON only.' },
        { role: 'user', content: `${instruction}\nGenerate exactly ${count} items.\nTitle: ${title}\nContent:\n${content}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new BadGatewayException('AI provider returned empty generated content');

    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown }).items;
      if (!Array.isArray(items)) throw new Error('Generated payload is not an array');
      return items as T;
    } catch {
      throw new BadGatewayException('AI provider returned invalid structured content');
    }
  }

  private validateQuestions(questions: GeneratedQuestion[]): void {
    if (!questions.length || questions.some((item) => !item.question || !Array.isArray(item.options) || item.options.length !== 4 || !item.options.includes(item.correctAnswer))) {
      throw new BadGatewayException('AI provider returned invalid quiz content');
    }
  }

  private validateFlashcards(flashcards: GeneratedFlashcard[]): void {
    if (!flashcards.length || flashcards.some((item) => !item.front?.trim() || !item.back?.trim())) {
      throw new BadGatewayException('AI provider returned invalid flashcard content');
    }
  }
}
