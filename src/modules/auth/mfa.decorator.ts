import { SetMetadata } from '@nestjs/common';
/** Allows primary-authenticated provisional sessions only on dedicated MFA endpoints. */
export const ALLOW_MFA_PENDING = 'allowMfaPending';
export const AllowMfaPending = () => SetMetadata(ALLOW_MFA_PENDING, true);
