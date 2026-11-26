import { isDeepStrictEqual } from 'node:util';
import {
  validateSchedule,
  estimateTransferMinutes,
  paceSettings,
} from '@travel/shared/recommendation-engine';
import { assertActivitiesFit, minutes, timeOf } from './trip-activity-validation';
import { ProposalReader } from './proposal-reader';
import type { PlanningInput, ScheduleDay } from '@travel/shared' with {
  'resolution-mode': 'import',
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { validateSchedule as validateProposalSchedule } from '../recommendations/rule-planner';
import { TripCatalog } from './trip-catalog';
import { TripRepository } from './trip.repository';
import type {
  Trip,
  CreateTripRequest,
  UpdateTripRequest,
  UpdateTripSelectionsRequest,
} from '@travel/shared' with { 'resolution-mode': 'import' };
@Injectable()
export class TripsService {
  constructor(
    private readonly repository: TripRepository,
    private readonly catalog: TripCatalog,
    private readonly proposals: ProposalReader,
  ) {}
  async create(ownerId: string, input: CreateTripRequest) {
    await this.catalog.assertCityExists(input.cityId);
    return this.repository.create(ownerId, input);
  }
  get(ownerId: string, id: string) {
    return this.repository.get(ownerId, id);
  }
  list(ownerId: string, page: number, pageSize: number) {
    return this.repository.list(ownerId, page, pageSize);
  }
  remove(ownerId: string, id: string, revision: number) {
    return this.repository.remove(ownerId, id, revision);
  }
  update(ownerId: string, id: string, input: UpdateTripRequest) {
    return this.repository.mutate(ownerId, id, input.expectedRevision, async (current) => {
      const next = structuredClone(current);
      if (input.title !== undefined) next.title = input.title;
      if (input.planningInput) {
        const cityId = input.planningInput.cityId ?? current.planningInput.cityId;
        await this.catalog.assertCityExists(cityId);
        next.planningInput = { ...current.planningInput, ...input.planningInput };
        if (cityId !== current.planningInput.cityId) next.planningInput.selectedPlaceIds = [];
      }
      return this.resetIfChanged(current, next, input.acknowledgeScheduleReset);
    });
  }
  selections(ownerId: string, id: string, input: UpdateTripSelectionsRequest) {
    return this.repository.mutate(ownerId, id, input.expectedRevision, async (current) => {
      await this.catalog.assertPlacesBelongToCity(current.planningInput.cityId, input.placeIds);
      const next = structuredClone(current);
      next.planningInput.selectedPlaceIds = [...input.placeIds];
      return this.resetIfChanged(current, next, input.acknowledgeScheduleReset);
    });
  }
  applyProposal(ownerId: string, id: string, expectedRevision: number, proposalId: string) {
    return this.repository.mutate(ownerId, id, expectedRevision, async (current) => {
      if (current.status !== 'draft')
        throw new ApiError('SCHEDULE_RESET_REQUIRED', '请先明确重置已有安排', 409);
      const proposal = await this.proposals.getOwnedProposal(proposalId, ownerId);
      const key = (p: Trip['planningInput']) =>
        JSON.stringify([
          p.cityId,
          p.startDate,
          p.endDate,
          [...p.themes].sort(),
          p.pace,
          p.transportMode,
          p.selectedPlaceIds,
        ]);
      if (key(current.planningInput) !== key(proposal.inputSnapshot))
        throw new ApiError('PROPOSAL_INPUT_MISMATCH', '方案输入与当前草稿不一致，请重新生成', 409);
      if (proposal.unassignedPlaceIds.length)
        throw new ApiError('UNASSIGNED_PLACES', '仍有未安排景点，请增加天数或减少景点', 422, {
          placeIds: proposal.unassignedPlaceIds,
        });
      await this.checkSchedule(current, proposal.days, 'proposal');
      // 目录校验可能耗时，在实际写入前再次核对方案有效期。
      await this.proposals.getOwnedProposal(proposalId, ownerId);
      return { ...current, status: 'planned', days: structuredClone(proposal.days) };
    });
  }
  updateSchedule(ownerId: string, id: string, expectedRevision: number, days: ScheduleDay[]) {
    return this.repository.mutate(ownerId, id, expectedRevision, async (current) => {
      if (current.status !== 'planned')
        throw new ApiError('INVALID_SCHEDULE', '请先确认推荐方案', 422);
      const scheduleChanged = !isDeepStrictEqual(current.days, days);
      const editedDays = scheduleChanged
        ? days.map((day, index) =>
            isDeepStrictEqual(day, current.days[index]) ? { date: day.date, items: [] } : day,
          )
        : days;
      if (editedDays.some((day) => day.items.some((item) => item.travelTimeSource === 'provider')))
        throw new ApiError('INVALID_SCHEDULE', '当前未接路线服务，不能标记为实时交通', 422);
      const expected = new Set(current.planningInput.selectedPlaceIds);
      for (const day of days) {
        for (const item of day.items) {
          if (!expected.delete(item.placeId))
            throw new ApiError('INVALID_SCHEDULE', '安排需覆盖所有已选景点且不能重复', 422);
        }
      }
      if (expected.size)
        throw new ApiError('INVALID_SCHEDULE', '安排需覆盖所有已选景点且不能重复', 422);

      await this.checkSchedule(
        {
          ...current,
          planningInput: {
            ...current.planningInput,
            selectedPlaceIds: editedDays.flatMap((day) => day.items.map(({ placeId }) => placeId)),
          },
        },
        editedDays,
      );
      const next = { ...current, days: structuredClone(days) };
      assertActivitiesFit(next);
      return next;
    });
  }
  addScenic(ownerId: string, id: string, expectedRevision: number, placeId: string, date: string) {
    return this.repository.mutate(ownerId, id, expectedRevision, async (current) => {
      if (current.status !== 'planned')
        throw new ApiError('INVALID_SCHEDULE', '请先完成行程创建', 422);
      if (current.planningInput.selectedPlaceIds.includes(placeId))
        throw new ApiError('VALIDATION_ERROR', '该景点已经在行程中', 400);
      if (current.planningInput.selectedPlaceIds.length >= 100)
        throw new ApiError('VALIDATION_ERROR', '每个行程最多选择 100 个景点', 400);
      await this.catalog.assertPlacesBelongToCity(current.planningInput.cityId, [placeId]);
      const places = await this.catalog.getCityPlaces(current.planningInput.cityId);
      const place = places.find((item) => item.id === placeId)!;
      const next = structuredClone(current);
      const day = next.days.find((item) => item.date === date);
      if (!day) throw new ApiError('VALIDATION_ERROR', '请选择行程内的日期', 400);
      const last = day.items.at(-1);
      const cfg = paceSettings[current.planningInput.pace];
      const travel = estimateTransferMinutes(
        places.find((item) => item.id === last?.placeId) ?? null,
        place,
        current.planningInput.transportMode,
      );
      let start = last
        ? minutes(last.startTime) + last.durationMinutes + travel + cfg.rest
        : cfg.start;
      for (const activity of [...(next.activities ?? [])]
        .filter((item) => item.date === date)
        .sort((a, b) => a.startTime.localeCompare(b.startTime))) {
        if (
          start < minutes(activity.startTime) + activity.durationMinutes &&
          start + place.suggestedDurationMinutes > minutes(activity.startTime)
        )
          start = minutes(activity.startTime) + activity.durationMinutes + cfg.rest;
      }
      day.items.push({
        placeId,
        position: day.items.length,
        startTime: timeOf(start),
        durationMinutes: place.suggestedDurationMinutes,
        travelMinutesFromPrevious: travel,
        travelTimeSource: last ? 'estimate' : 'none',
        reason: '用户从景点目录添加，交通为规则预留',
      });
      next.planningInput.selectedPlaceIds.push(placeId);
      // 原有高德交通段来自已确认方案；这里只新增服务端计算的估算段，保留其他时段。
      await this.checkSchedule(next, next.days, 'proposal');
      assertActivitiesFit(next);
      return next;
    });
  }
  removeScenic(ownerId: string, id: string, expectedRevision: number, placeId: string) {
    return this.repository.mutate(ownerId, id, expectedRevision, async (current) => {
      if (current.status !== 'planned')
        throw new ApiError('INVALID_SCHEDULE', '请先完成行程创建', 422);
      if (!current.planningInput.selectedPlaceIds.includes(placeId))
        throw new ApiError('NOT_FOUND', '景点不在当前行程中', 404);
      const next = structuredClone(current);
      const places = await this.catalog.getCityPlaces(current.planningInput.cityId);
      const cfg = paceSettings[current.planningInput.pace];
      next.planningInput.selectedPlaceIds = next.planningInput.selectedPlaceIds.filter(
        (item) => item !== placeId,
      );
      for (const day of next.days) {
        const original = current.days.find((item) => item.date === day.date)!;
        day.items = day.items.filter((item) => item.placeId !== placeId);
        for (const [index, item] of day.items.entries()) {
          item.position = index;
          const previous = day.items[index - 1];
          const oldIndex = original.items.findIndex((old) => old.placeId === item.placeId);
          if (original.items[oldIndex - 1]?.placeId !== previous?.placeId) {
            const place = places.find((p) => p.id === item.placeId)!;
            item.travelMinutesFromPrevious = estimateTransferMinutes(
              places.find((p) => p.id === previous?.placeId) ?? null,
              place,
              current.planningInput.transportMode,
            );
            item.travelTimeSource = previous ? 'estimate' : 'none';
          }
          if (previous)
            item.startTime = timeOf(
              Math.max(
                minutes(item.startTime),
                minutes(previous.startTime) +
                  previous.durationMinutes +
                  item.travelMinutesFromPrevious +
                  cfg.rest,
              ),
            );
        }
      }
      await this.checkSchedule(next, next.days, 'proposal');
      assertActivitiesFit(next);
      return next;
    });
  }
  private async checkSchedule(
    current: Trip,
    days: ScheduleDay[],
    source: 'proposal' | 'manual' = 'manual',
  ) {
    if (!current.planningInput.startDate || !current.planningInput.endDate)
      throw new ApiError('INVALID_SCHEDULE', '缺少完整日期', 422);
    const places = await this.catalog.getCityPlaces(current.planningInput.cityId);
    try {
      const input = current.planningInput as PlanningInput;
      if (source === 'proposal') validateProposalSchedule(input, places, days);
      else validateSchedule(places, input, days);
    } catch {
      throw new ApiError(
        'INVALID_SCHEDULE',
        '安排需覆盖所有已选景点、日期，且顺序/交通/时长满足规则预算',
        422,
      );
    }
  }
  private resetIfChanged(current: Trip, next: Trip, acknowledged?: boolean): Trip {
    const normalize = (trip: Trip) => ({
      ...trip.planningInput,
      themes: [...trip.planningInput.themes].sort(),
    });
    const changed = JSON.stringify(normalize(current)) !== JSON.stringify(normalize(next));
    if (changed && current.status === 'planned') {
      if (!acknowledged)
        throw new ApiError(
          'SCHEDULE_RESET_REQUIRED',
          '修改规划条件将清空每日安排，请明确确认',
          409,
        );
      next.days = [];
      next.activities = [];
      next.status = 'draft';
    }
    return next;
  }
}
