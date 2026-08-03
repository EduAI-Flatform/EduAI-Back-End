import type { DecodedIdToken } from 'firebase-admin/auth';

export const FIREBASE_ADMIN_SERVICE = Symbol('FIREBASE_ADMIN_SERVICE');

export interface FirebaseAdminVerifier {
  verifyIdToken(idToken: string): Promise<DecodedIdToken>;
}
