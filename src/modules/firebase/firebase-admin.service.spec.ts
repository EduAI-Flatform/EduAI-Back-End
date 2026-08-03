import { InternalServerErrorException } from '@nestjs/common';
import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { AppConfigService } from '../../config/app-config.service';
import { FirebaseAdminService } from './firebase-admin.service';

jest.mock('firebase-admin/app', () => ({
  cert: jest.fn(),
  getApp: jest.fn(),
  getApps: jest.fn(),
  initializeApp: jest.fn(),
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(),
}));

describe('FirebaseAdminService', () => {
  const firebaseConfig = {
    clientEmail: 'firebase-adminsdk@example.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nprivate-key\\n-----END PRIVATE KEY-----\\n',
    projectId: 'eduai-project',
  };
  const app = { name: '[DEFAULT]' } as never;
  const auth = {
    verifyIdToken: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getApps as jest.Mock).mockReturnValue([]);
    (cert as jest.Mock).mockReturnValue({ type: 'certificate' });
    (initializeApp as jest.Mock).mockReturnValue(app);
    (getAuth as jest.Mock).mockReturnValue(auth);
    auth.verifyIdToken.mockResolvedValue({ uid: 'firebase-uid' });
  });

  it('initializes Firebase once and verifies the supplied ID token', async () => {
    const service = new FirebaseAdminService({
      firebase: firebaseConfig,
    } as AppConfigService);

    await expect(service.verifyIdToken('firebase-id-token')).resolves.toEqual({
      uid: 'firebase-uid',
    });

    expect(cert).toHaveBeenCalledWith({
      clientEmail: firebaseConfig.clientEmail,
      privateKey: '-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----\n',
      projectId: firebaseConfig.projectId,
    });
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(auth.verifyIdToken).toHaveBeenCalledWith('firebase-id-token');

    await service.verifyIdToken('second-token');

    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(getAuth).toHaveBeenCalledTimes(1);
  });

  it('reuses an already initialized default Firebase app', async () => {
    (getApps as jest.Mock).mockReturnValue([app]);
    (getApp as jest.Mock).mockReturnValue(app);
    const service = new FirebaseAdminService({
      firebase: firebaseConfig,
    } as AppConfigService);

    await service.verifyIdToken('firebase-id-token');

    expect(getApp).toHaveBeenCalledTimes(1);
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('fails clearly when Firebase configuration is missing', async () => {
    const service = new FirebaseAdminService({
      firebase: {},
    } as AppConfigService);

    await expect(service.verifyIdToken('firebase-id-token')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(getApps).not.toHaveBeenCalled();
  });
});
