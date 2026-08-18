import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TmiRewardKind, TmiRewardStatus } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTmiRewardDto } from './dto/create-tmi-reward.dto';
import { ListTmiRewardsQueryDto } from './dto/list-tmi-rewards-query.dto';
import { UpdateTmiRewardDto } from './dto/update-tmi-reward.dto';

const rewardSelect = { id: true, title: true, description: true, kind: true, cost: true, status: true, quota: true, redeemedCount: true, startsAt: true, endsAt: true, inventoryMetadata: true, createdById: true, createdAt: true, updatedAt: true } satisfies Prisma.TmiRewardSelect;
type RewardRecord = Prisma.TmiRewardGetPayload<{ select: typeof rewardSelect }>;
export interface TmiRewardResponse extends Omit<RewardRecord, 'inventoryMetadata'> { inventoryMetadata: Record<string, unknown> | null; }
export interface TmiRewardPage { items: TmiRewardResponse[]; page: number; pageSize: number; total: number; totalPages: number; }

@Injectable()
export class TmiRewardService {
  constructor(private readonly prisma: PrismaService, private readonly auditService: AuditService) {}

  async create(actorId: string, input: CreateTmiRewardDto): Promise<TmiRewardResponse> {
    const normalized = this.normalizeCreate(input); this.assertPolicy(normalized);
    const created = await this.prisma.$transaction(async (tx) => {
      const reward = await tx.tmiReward.create({ data: { ...normalized, inventoryMetadata: this.toJsonInput(normalized.inventoryMetadata), status: TmiRewardStatus.draft, createdById: actorId, startsAt: new Date(normalized.startsAt), endsAt: new Date(normalized.endsAt) }, select: rewardSelect });
      await this.auditService.record({ actorId, action: AuditAction.TmiRewardCreated, target: { type: 'tmi_reward', id: reward.id }, metadata: { title: reward.title, cost: reward.cost } }, tx);
      return reward;
    });
    return this.toResponse(created);
  }

  async get(id: string): Promise<TmiRewardResponse> { const reward = await this.prisma.tmiReward.findUnique({ where: { id }, select: rewardSelect }); if (!reward) throw new NotFoundException('TMI reward not found'); return this.toResponse(reward); }

  async list(query: ListTmiRewardsQueryDto): Promise<TmiRewardPage> {
    const where: Prisma.TmiRewardWhereInput = query.status ? { status: query.status } : {};
    const [total, items] = await this.prisma.$transaction([this.prisma.tmiReward.count({ where }), this.prisma.tmiReward.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: rewardSelect })]);
    return { items: items.map((item) => this.toResponse(item)), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  async update(actorId: string, id: string, input: UpdateTmiRewardDto): Promise<TmiRewardResponse> {
    const current = await this.prisma.tmiReward.findUnique({ where: { id }, select: rewardSelect }); if (!current) throw new NotFoundException('TMI reward not found');
    const normalized = { title: input.title?.trim() ?? current.title, description: input.description === undefined ? current.description : input.description, kind: input.kind ?? current.kind, cost: input.cost ?? current.cost, startsAt: input.startsAt ?? current.startsAt.toISOString(), endsAt: input.endsAt ?? current.endsAt.toISOString(), quota: input.quota === undefined ? current.quota : input.quota, inventoryMetadata: input.inventoryMetadata === undefined ? current.inventoryMetadata : input.inventoryMetadata, status: input.status ?? current.status };
    this.assertPolicy(normalized); if (current.redeemedCount > 0 && ['kind', 'cost', 'startsAt', 'endsAt', 'quota', 'inventoryMetadata'].some((key) => Object.prototype.hasOwnProperty.call(input, key))) throw new ConflictException('Reward policy cannot change after redemption; disable it instead');
    const updated = await this.prisma.$transaction(async (tx) => { const reward = await tx.tmiReward.update({ where: { id }, data: { ...normalized, inventoryMetadata: this.toJsonInput(normalized.inventoryMetadata), startsAt: new Date(normalized.startsAt), endsAt: new Date(normalized.endsAt) }, select: rewardSelect }); await this.auditService.record({ actorId, action: AuditAction.TmiRewardUpdated, target: { type: 'tmi_reward', id }, metadata: { title: reward.title, status: reward.status } }, tx); return reward; });
    return this.toResponse(updated);
  }

  private normalizeCreate(input: CreateTmiRewardDto) { return { title: input.title.trim(), description: input.description?.trim() || null, kind: input.kind, cost: input.cost, startsAt: input.startsAt, endsAt: input.endsAt, quota: input.quota ?? null, inventoryMetadata: input.inventoryMetadata ?? null }; }
  private assertPolicy(input: { title: string; kind: TmiRewardKind; cost: number; startsAt: string; endsAt: string; quota: number | null }) { if (!input.title) throw new BadRequestException('Reward title is required'); const start = Date.parse(input.startsAt); const end = Date.parse(input.endsAt); if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new BadRequestException('Reward dates must be valid and ordered'); if (!Number.isInteger(input.cost) || input.cost <= 0) throw new BadRequestException('Reward cost must be positive'); if (input.quota !== null && (!Number.isInteger(input.quota) || input.quota < 1)) throw new BadRequestException('Reward quota must be positive'); }
  private toResponse(record: RewardRecord): TmiRewardResponse { return { ...record, inventoryMetadata: record.inventoryMetadata as Record<string, unknown> | null }; }
  private toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull { return value === null || value === undefined ? Prisma.JsonNull : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
}
