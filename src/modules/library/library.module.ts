import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LibraryTaxonomyController } from './library-taxonomy.controller';
import { LibraryTaxonomyService } from './library-taxonomy.service';

@Module({
  imports: [AuthModule],
  controllers: [LibraryTaxonomyController],
  providers: [LibraryTaxonomyService],
})
export class LibraryModule {}
