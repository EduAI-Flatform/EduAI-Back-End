import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../../generated/prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  DEFAULT_PLATFORM_SETTINGS,
  PlatformGroup,
  PLATFORM_GROUPS,
} from "./platform-settings.defaults";
import { validatePlatformSettings } from "./platform-settings.validation";
import { PLATFORM_REQUEST_HANDLERS } from "../platform-requests/platform-requests.readiness";
import { computeMembershipCardImpact } from "../membership-cards/membership-card-source";
import type { MembershipCardPolicy } from "../membership-cards/membership-card.evaluator";
import { computeActivityPointImpact } from '../tmi/activity-point-impact';
import { SUPPORTED_POINT_EVENTS, type ActivityPointPolicy } from '../tmi/activity-point-policy';
import { readActivityPointReadiness } from '../tmi/activity-point.readiness';

const publicGroups = [
  "branding",
  "navigation",
  "courses",
  "partners",
  "operations",
] as const;
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async current() {
    const records = await this.prisma.platformPolicyRevision.findMany({
      where: { status: "scheduled", effectiveAt: { lte: new Date() } },
      orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
    });
    const settings: Record<string, unknown> = structuredClone(
      DEFAULT_PLATFORM_SETTINGS,
    );
    const versions: Record<string, string> = {};
    for (const row of records)
      if (!versions[row.group]) {
        settings[row.group] = row.content;
        versions[row.group] = row.id;
      }
    return { settings, versions };
  }

  async publicSettings() {
    const current = await this.current();
    return {
      settings: Object.fromEntries(
        publicGroups.map((g) => [g, current.settings[g]]),
      ),
      versions: Object.fromEntries(
        publicGroups
          .filter((g) => current.versions[g])
          .map((g) => [g, current.versions[g]]),
      ),
    };
  }

  async state() {
    const [current, revisions] = await Promise.all([
      this.current(),
      this.prisma.platformPolicyRevision.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    const pointReadiness = await readActivityPointReadiness(this.prisma);
    return { ...current, revisions, groups: PLATFORM_GROUPS, pointCapabilities: {
      supportedEvents: [...SUPPORTED_POINT_EVENTS], historicalAwardsPreserved: true,
      reprocessesHistoricalEvents: false, impactWindowDays: 30,
      activationReady: pointReadiness.ready, activationBlocker: pointReadiness.reason,
    } };
  }

  async create(actorId: string, group: string, content: unknown) {
    validatePlatformSettings(group, content);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const last = await tx.platformPolicyRevision.findFirst({
              where: { group },
              orderBy: { version: "desc" },
              select: { version: true },
            });
            const row = await tx.platformPolicyRevision.create({
              data: {
                group,
                version: (last?.version ?? 0) + 1,
                content: content as Prisma.InputJsonValue,
                createdById: actorId,
              },
            });
            await this.audit(
              tx,
              actorId,
              "PLATFORM_POLICY_DRAFT_CREATED",
              row.id,
              { group, version: row.version },
            );
            return row;
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034"].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    throw new ConflictException("Configuration changed. Please retry.");
  }

  async preview(id: string) {
    const row = await this.get(id);
    const current = await this.current();
    const before = current.settings[row.group];
    const changed = JSON.stringify(before) !== JSON.stringify(row.content);
    const membershipImpact = row.group === "membership"
      ? await this.prisma.$transaction(tx => computeMembershipCardImpact(
          tx, row.content as unknown as MembershipCardPolicy, row.id,
          { beforePolicy: current.settings.membership as MembershipCardPolicy, beforeRevisionId: current.versions.membership },
        ), { isolationLevel: "RepeatableRead" })
      : null;
    const pointsImpact = row.group === 'points'
      ? await this.prisma.$transaction(async tx => ({ ...await computeActivityPointImpact(tx,
          current.settings.points as ActivityPointPolicy, row.content as unknown as ActivityPointPolicy),
          beforeRevisionId: current.versions.points ?? null, afterRevisionId: row.id }),
        { isolationLevel: 'RepeatableRead' })
      : null;
    const blockers = await this.activationBlockers(
      row.group as PlatformGroup,
      row.content,
    );
    return {
      revisionId: id,
      group: row.group,
      version: row.version,
      before,
      after: row.content,
      changed,
      canSchedule: blockers.length === 0,
      blockers,
      preservesPurchasedAccess: true,
      membershipImpact,
      pointsImpact,
    };
  }

  async approve(actorId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.platformPolicyRevision.updateMany({
        where: { id, status: "draft" },
        data: {
          status: "approved",
          approvedAt: new Date(),
          approvedById: actorId,
        },
      });
      if (!result.count)
        throw new ConflictException("Only a draft can be approved.");
      await this.audit(tx, actorId, "PLATFORM_POLICY_APPROVED", id);
      return tx.platformPolicyRevision.findUniqueOrThrow({ where: { id } });
    });
  }

  async schedule(actorId: string, id: string, effectiveAt: Date) {
    if (!Number.isFinite(effectiveAt.getTime()))
      throw new BadRequestException("Invalid effective date.");
    // Allow a short client/server clock difference for immediate activation.
    if (effectiveAt.getTime() < Date.now() - 60000)
      throw new BadRequestException("Effective date is in the past.");
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.platformPolicyRevision.findUnique({ where: { id } });
      if (!row)
        throw new NotFoundException("Configuration revision not found.");
      validatePlatformSettings(row.group, row.content);
      const blockers = await this.activationBlockers(
        row.group as PlatformGroup,
        row.content,
        tx,
      );
      if (blockers.length)
        throw new BadRequestException({
          message: "Activation is not ready.",
          blockers,
        });
      const result = await tx.platformPolicyRevision.updateMany({
        where: { id, status: "approved" },
        data: { status: "scheduled", effectiveAt },
      });
      if (!result.count)
        throw new ConflictException(
          "Only an approved revision can be scheduled.",
        );
      await this.audit(tx, actorId, "PLATFORM_POLICY_SCHEDULED", id, {
        effectiveAt: effectiveAt.toISOString(),
      });
      return tx.platformPolicyRevision.findUniqueOrThrow({ where: { id } });
    });
  }

  async cancel(actorId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.platformPolicyRevision.findUnique({ where: { id } });
      if (!row)
        throw new NotFoundException("Configuration revision not found.");
      // Active revisions are immutable: restoring means creating and approving a new revision.
      if (
        row.status === "scheduled" &&
        row.effectiveAt &&
        row.effectiveAt <= new Date()
      ) {
        throw new ConflictException(
          "Restore an active policy by creating a new revision.",
        );
      }
      const result = await tx.platformPolicyRevision.updateMany({
        where: {
          id,
          status: { not: "cancelled" },
          OR: [{ effectiveAt: null }, { effectiveAt: { gt: new Date() } }],
        },
        data: { status: "cancelled" },
      });
      if (!result.count)
        throw new ConflictException("Revision cannot be cancelled.");
      await this.audit(tx, actorId, "PLATFORM_POLICY_CANCELLED", id);
      return { cancelled: true };
    });
  }

  private async activationBlockers(group: PlatformGroup, content: unknown, client: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma): Promise<string[]> {
    const c = content as Record<string, unknown>;
    if (["membership", "points", "affiliate"].includes(group) && c.enabled === false) return [];
    if (group === "affiliate" && c.subAffiliateEnabled) {
      return ["SUB_AFFILIATE_ATTRIBUTION_NOT_IMPLEMENTED"];
    }
    if (group === "points") {
      const readiness = await readActivityPointReadiness(client);
      return readiness.ready ? [] : [readiness.reason];
    }
    if (
      group === "operations" &&
      ((c.supportEnabled && !PLATFORM_REQUEST_HANDLERS.support) ||
        (c.partnerApplicationsEnabled &&
          !PLATFORM_REQUEST_HANDLERS.partnerApplications) ||
        (c.invoiceRequestsEnabled &&
          !PLATFORM_REQUEST_HANDLERS.invoiceRequests))
    ) {
      return [
        "Operational request handlers must be verified before enabling these features.",
      ];
    }
    return [];
  }

  private async get(id: string) {
    const row = await this.prisma.platformPolicyRevision.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException("Configuration revision not found.");
    return row;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorId: string,
    action: string,
    id: string,
    metadata: Record<string, string | number> = {},
  ) {
    await tx.auditLog.create({
      data: {
        actorId,
        actorKind: "USER",
        action,
        targetType: "platform_policy",
        targetId: id,
        metadataJson: metadata,
      },
    });
  }
}
