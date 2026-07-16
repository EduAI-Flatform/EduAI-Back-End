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
import { CreateAiChatDto } from './dto/create-ai-chat.dto';

@ApiTags('AI')
@Controller('ai')
export class AiController {
  constructor(private readonly aiConversationService: AiConversationService) {}

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
}
