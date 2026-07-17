import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiConversationService } from './ai-conversation.service';
import { AiSummaryService } from './ai-summary.service';
import { AiGenerationService } from './ai-generation.service';
import { CreateAiChatDto } from './dto/create-ai-chat.dto';
import { CreateAiSummaryDto } from './dto/create-ai-summary.dto';
import { CreateAiGenerationDto } from './dto/create-ai-generation.dto';

@ApiTags('AI')
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiConversationService: AiConversationService,
    private readonly aiSummaryService: AiSummaryService,
    private readonly aiGenerationService: AiGenerationService,
  ) {}

  @Post('chat')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'AI chat message stored successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid AI chat payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'AI conversation not found for current user.' })
  createChat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateAiChatDto,
  ) {
    return this.aiConversationService.createChat(user, input);
  }

  @Post('summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'AI summary generated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid AI summary payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Summary source not found for current user.' })
  createSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateAiSummaryDto,
  ) {
    return this.aiSummaryService.summarize(user, input);
  }

  @Post('quiz-generator')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'AI quiz generated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid AI quiz payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Quiz source not found for current user.' })
  createQuiz(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateAiGenerationDto,
  ) {
    return this.aiGenerationService.generateQuiz(user, input);
  }

  @Post('flashcards')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'AI flashcards generated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid AI flashcard payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Flashcard source not found for current user.' })
  createFlashcards(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateAiGenerationDto,
  ) {
    return this.aiGenerationService.generateFlashcards(user, input);
  }
}
