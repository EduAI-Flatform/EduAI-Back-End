import { PartialType } from '@nestjs/swagger';
import { CreateCommunityPostDto } from './create-community-post.dto';

export class UpdateCommunityPostDto extends PartialType(CreateCommunityPostDto) {}
