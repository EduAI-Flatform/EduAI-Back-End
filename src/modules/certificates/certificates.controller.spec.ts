import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CertificatesController } from './certificates.controller';

describe('CertificatesController', () => {
  it('issues a certificate for the authenticated student', async () => {
    const service = {
      issueCertificate: jest.fn().mockResolvedValue({ id: 'certificate-id' }),
    };
    const controller = new CertificatesController(service as never);
    const user = { id: 'student-id', roles: [RoleName.student] };
    const input = { courseId: 'course-id', certificateTemplateId: 'template-id' };

    await controller.issueCertificate(user, input);

    expect(service.issueCertificate).toHaveBeenCalledWith(user.id, input);
  });

  it('protects issuance with auth guards and student role', () => {
    const method = CertificatesController.prototype.issueCertificate;

    expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(GUARDS_METADATA, CertificatesController)).toBeDefined();
  });
});
