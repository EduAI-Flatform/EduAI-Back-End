import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LibraryResourceController } from './library-resource.controller';
import { LibraryResourceService } from './library-resource.service';
import { LibraryR2StorageService } from './library-r2-storage.service';
import { LibraryTaxonomyController } from './library-taxonomy.controller';
import { LibraryTaxonomyService } from './library-taxonomy.service';

@Module({
  imports: [AuthModule],
  controllers: [LibraryTaxonomyController, LibraryResourceController],
  providers: [LibraryTaxonomyService, LibraryResourceService, LibraryR2StorageService],
})
export class LibraryModule {}
