import type { Prisma } from '../../../generated/prisma/client';
import type { MembershipCardPolicy } from './membership-card.evaluator';

// Stable server identities and units; Admin supplies business thresholds and quotas.
export const CARD_REQUEST_SERVICES = ['AI_CHAT', 'AI_SUMMARY', 'AI_QUIZ', 'AI_FLASHCARDS', 'AI_LEARNING_PATH'] as const;
type Definition = { code: string; valueType: string; resetPeriod: string; unitLabel: string | null };
export function isBoundCardRequestDefinition(definition: Definition): boolean {
  return CARD_REQUEST_SERVICES.includes(definition.code as typeof CARD_REQUEST_SERVICES[number])
    && definition.valueType === 'metered' && definition.unitLabel === 'request'
    && ['none', 'calendar_month', 'membership_term'].includes(definition.resetPeriod);
}

export async function inspectCardServiceBindings(client: Pick<Prisma.TransactionClient, 'serviceEntitlementDefinition'>, policy: MembershipCardPolicy) {
  const ids = [...new Set(policy.tiers.flatMap(tier => tier.serviceLimits ?? []).map(rule => rule.definitionId.toLowerCase()))];
  const issues: Array<{ definitionId: string; reason: string }> = [];
  if (!ids.length) return { ready: true, issues };
  const definitions = await client.serviceEntitlementDefinition.findMany({ where: { id: { in: ids } },
    select: { id: true, code: true, valueType: true, resetPeriod: true, unitLabel: true } });
  for (const definitionId of ids) {
    const definition = definitions.find(item => item.id.toLowerCase() === definitionId);
    let reason: string | null = null;
    if (!definition) reason = 'CARD_SERVICE_DEFINITION_NOT_FOUND';
    else if (!CARD_REQUEST_SERVICES.includes(definition.code as typeof CARD_REQUEST_SERVICES[number])) reason = 'CARD_SERVICE_OPERATION_NOT_BOUND';
    else if (!isBoundCardRequestDefinition(definition)) reason = 'CARD_SERVICE_REQUIRES_REQUEST_QUOTA';
    else if (definition.resetPeriod === 'membership_term' && (!policy.serviceLimits?.termAnchorAt || !policy.serviceLimits.termMonths))
      reason = 'CARD_SERVICE_TERM_NOT_CONFIGURED';
    if (reason) issues.push({ definitionId, reason });
  }
  return { ready: issues.length === 0, issues };
}
