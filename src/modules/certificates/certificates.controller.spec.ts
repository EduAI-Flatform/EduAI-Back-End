import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CertificatesController } from './certificates.controller';

describe('CertificatesController', () => {
  it('issues a certificate for the authenticated student', async () => {
    const service = {
      issueCertificate: jest.fn().mockResolvedValue({ id: 'certificate-id' }),
      verifyCertificate: jest.fn().mockResolvedValue({
        certificateCode: 'CERT-abc123',
      }),
    };
    const controller = new CertificatesController(service as never);
    const user = { id: 'student-id', roles: [RoleName.student] };
    const input = { courseId: 'course-id', certificateTemplateId: 'template-id' };

    await controller.issueCertificate(user, input);

    expect(service.issueCertificate).toHaveBeenCalledWith(user.id, input);
  });

  it('verifies a certificate publicly without an authenticated user', async () => {
    const service = {
      issueCertificate: jest.fn(),
      verifyCertificate: jest.fn().mockResolvedValue({
        certificateCode: 'CERT-abc123',
      }),
    };
    const controller = new CertificatesController(service as never);

    await controller.verifyCertificate('CERT-abc123');

    expect(service.verifyCertificate).toHaveBeenCalledWith('CERT-abc123');
  });

  it('protects issuance with auth guards and student role', () => {
    const method = CertificatesController.prototype.issueCertificate;

    expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toBeDefined();
  });

  it('leaves public verification unguarded', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CertificatesController.prototype.verifyCertificate),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(ROLES_KEY, CertificatesController.prototype.verifyCertificate),
    ).toBeUndefined();
  });
});
