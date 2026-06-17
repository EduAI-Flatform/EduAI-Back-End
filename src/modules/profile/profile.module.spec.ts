import { Test } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service';
import { AvatarStorageService } from './avatar-storage.service';
import { ProfileModule } from './profile.module';
import { ProfileService } from './profile.service';

describe('ProfileModule', () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= 'postgresql://user:password@localhost:5432/eduai';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
  });

  it('compiles with the auth guard dependencies available', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProfileModule],
    })
      .overrideProvider(AuthService)
      .useValue({})
      .overrideProvider(ProfileService)
      .useValue({})
      .overrideProvider(AvatarStorageService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});
