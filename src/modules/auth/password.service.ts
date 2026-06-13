import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

export const PASSWORD_HASH_ROUNDS = 12;

@Injectable()
export class PasswordService {
  async hashPassword(plainPassword: string): Promise<string> {
    return bcrypt.hash(plainPassword, PASSWORD_HASH_ROUNDS);
  }

  async comparePassword(
    plainPassword: string,
    passwordHash: string,
  ): Promise<boolean> {
    return bcrypt.compare(plainPassword, passwordHash);
  }
}
