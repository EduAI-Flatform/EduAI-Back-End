import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { bankTransferEnabled, classifyBankEvidence } from './bank-transfer-policy';

// A bank payment never inherits gateway trust merely by setting a paid status.
export async function requireBankTransferProof(tx: Prisma.TransactionClient, orderId: string, settlementId: string) {
  if (!bankTransferEnabled(process.env.NODE_ENV ?? '', process.env.BANK_TRANSFER_SANDBOX_ENABLED)) {
    throw new ConflictException('BANK_TRANSFER_DISABLED');
  }
  const settlement = await tx.commerceSettlement.findUnique({ where: { id: settlementId } });
  const order = await tx.commerceOrder.findUnique({ where: { id: orderId } });
  const request = await tx.commerceBankTransferRequest.findUnique({ where: { orderId } });
  const evidence = settlement?.providerSettlementReference
    ? await tx.commerceBankStatementEvidence.findUnique({ where: { id: settlement.providerSettlementReference } }) : null;
  const approvals = evidence ? await tx.commerceBankApproval.findMany({ where: { evidenceId: evidence.id } }) : [];
  const attempt = request ? await tx.commercePaymentAttempt.findUnique({ where: { id: request.paymentAttemptId } }) : null;
  const event = settlement?.paymentEventId ? await tx.commercePaymentEvent.findUnique({ where: { id: settlement.paymentEventId } }) : null;
  if (!order || order.status !== 'confirmed' || order.confirmedSettlementId !== settlementId ||
      !settlement || !request || !evidence || !attempt || !event || request.status !== 'PAID' ||
      order.payableAmountMinor !== request.amountMinor || order.currency !== 'VND' ||
      evidence.requestId !== request.id || evidence.exceptionReason || classifyBankEvidence(request, evidence) ||
      new Set(approvals.map((approval) => approval.actorId)).size < 2 ||
      settlement.orderId !== orderId || settlement.provider !== 'bank_transfer' ||
      settlement.kind !== 'provider_collection' || settlement.disposition !== 'matched' ||
      settlement.paymentAttemptId !== attempt.id || attempt.provider !== 'bank_transfer' || attempt.status !== 'paid' ||
      event.provider !== 'bank_transfer' || event.paymentAttemptId !== attempt.id || event.nextStatus !== 'paid' ||
      event.providerSettlementReference !== evidence.id || event.amountMinor !== evidence.amountMinor ||
      event.providerOccurredAt?.getTime() !== evidence.occurredAt.getTime() || settlement.settledAt.getTime() !== evidence.occurredAt.getTime() ||
      settlement.amountMinor !== request.amountMinor || attempt.amountMinor !== request.amountMinor ||
      settlement.currency !== 'VND' || attempt.currency !== 'VND' || event.currency !== 'VND') {
    throw new ConflictException('BANK_STATEMENT_PROOF_REQUIRED');
  }
  return { settlement, request, attempt, event };
}
