import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  App,
  cert,
  getApp,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class FirebaseAdminService {
  private auth?: Auth;

  constructor(private readonly appConfig: AppConfigService) {}

  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    return this.getAuth().verifyIdToken(idToken);
  }

  async checkHealth(): Promise<'ok' | 'disabled' | 'error'> {
    const { clientEmail, privateKey, projectId } = this.appConfig.firebase;
    if (!clientEmail || !privateKey || !projectId) return 'disabled';
    try {
      await this.getAuth().listUsers(1);
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private getAuth(): Auth {
    if (this.auth) {
      return this.auth;
    }

    const { clientEmail, privateKey, projectId } = this.appConfig.firebase;

    if (!clientEmail || !privateKey || !projectId) {
      throw new InternalServerErrorException(
        'Firebase authentication is not configured',
      );
    }

    const app = this.getOrInitializeApp({
      clientEmail,
      privateKey,
      projectId,
    });

    const { getAuth } = require('firebase-admin/auth') as typeof import(
      'firebase-admin/auth'
    );
    this.auth = getAuth(app);
    return this.auth;
  }

  private getOrInitializeApp(config: {
    clientEmail: string;
    privateKey: string;
    projectId: string;
  }): App {
    if (getApps().length > 0) {
      return getApp();
    }

    return initializeApp({
      credential: cert({
        clientEmail: config.clientEmail,
        privateKey: config.privateKey.replace(/\\n/g, '\n'),
        projectId: config.projectId,
      }),
    });
  }
}
