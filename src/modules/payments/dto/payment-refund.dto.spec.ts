import 'reflect-metadata';
import { validate } from 'class-validator';
import { RecordRefundDto } from './payment-refund.dto';

describe('RecordRefundDto', () => {
  it('requires explicit confirmation of the already-completed external action', async () => {
    const valid = Object.assign(new RecordRefundDto(), {
      externalReference: 'manual-ref',
      confirmExternalAction: true,
      expectedUpdatedAt: '2026-08-27T09:00:00.000Z',
    });
    await expect(validate(valid)).resolves.toHaveLength(0);
    const unconfirmed = Object.assign(new RecordRefundDto(), {
      externalReference: 'manual-ref',
      confirmExternalAction: false,
      expectedUpdatedAt: '2026-08-27T09:00:00.000Z',
    });
    await expect(validate(unconfirmed)).resolves.not.toHaveLength(0);
  });
});
