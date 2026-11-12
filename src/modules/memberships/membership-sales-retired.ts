import { GoneException } from '@nestjs/common';

/** Retire sales without mutating historical plans, purchases or granted access. */
export function membershipSalesRetired(): never {
  throw new GoneException({
    error: 'MEMBERSHIP_SALES_RETIRED',
    message: 'Membership packages have been replaced by GDS membership cards.',
  });
}
