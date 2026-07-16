import { MODULE_METADATA } from '@nestjs/common/constants';
import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from './community.module';

describe('CommunityModule', () => {
  it('imports AuthModule for JWT-protected community routes', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, CommunityModule) as unknown[];

    expect(imports).toContain(AuthModule);
  });
});
