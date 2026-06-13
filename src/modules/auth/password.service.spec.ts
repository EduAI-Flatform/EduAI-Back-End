import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    service = new PasswordService();
  });

  it('hashes passwords with bcrypt and does not return plaintext', async () => {
    const plainPassword = 'Str0ngPassword!123';

    const passwordHash = await service.hashPassword(plainPassword);

    expect(passwordHash).not.toBe(plainPassword);
    expect(passwordHash).toMatch(/^\$2[aby]\$(\d{2})\$/);
    expect(Number(passwordHash.split('$')[2])).toBeGreaterThanOrEqual(12);
  });

  it('returns true when the password matches the hash', async () => {
    const plainPassword = 'Str0ngPassword!123';
    const passwordHash = await service.hashPassword(plainPassword);

    await expect(
      service.comparePassword(plainPassword, passwordHash),
    ).resolves.toBe(true);
  });

  it('returns false when the password does not match the hash', async () => {
    const passwordHash = await service.hashPassword('Str0ngPassword!123');

    await expect(
      service.comparePassword('WrongPassword!123', passwordHash),
    ).resolves.toBe(false);
  });
});
