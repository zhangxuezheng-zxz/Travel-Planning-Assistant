import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Trip, TripActivityInput, TripActivity } from '@travel/shared' with {
  'resolution-mode': 'import',
};
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { AmapLocationService } from '../footprints/amap-location.service';
import { TripRepository } from './trip.repository';
import { assertActivitiesFit } from './trip-activity-validation';

export function sameActivityCity(expected: string, actual: string | null) {
  if (!actual || !/^\d{6}$/.test(expected) || !/^\d{6}$/.test(actual)) return false;
  return ['11', '12', '31', '50'].includes(expected.slice(0, 2))
    ? expected.slice(0, 2) === actual.slice(0, 2)
    : expected.slice(0, 4) === actual.slice(0, 4);
}
@Injectable()
export class TripActivitiesService {
  constructor(
    private readonly repository: TripRepository,
    private readonly locations: AmapLocationService,
    private readonly db: DatabaseService,
  ) {}
  private planned(trip: Trip, expected?: number) {
    if (trip.status !== 'planned')
      throw new ApiError('INVALID_SCHEDULE', '请先完成行程创建，再添加活动', 422);
    if (expected !== undefined && trip.revision !== expected)
      throw new ApiError('REVISION_CONFLICT', '行程已发生变化，请重新读取后重试', 409, {
        currentRevision: trip.revision,
      });
  }
  private async cityAdcode(cityId: string) {
    const found = await this.db.query<{ adcode: string }>(
      'SELECT adcode FROM destinations WHERE id=$1',
      [cityId],
    );
    if (!found.rows[0]) throw new ApiError('NOT_FOUND', '城市不存在', 404);
    return found.rows[0].adcode;
  }
  async search(ownerId: string, id: string, keyword: string) {
    const trip = await this.repository.get(ownerId, id);
    this.planned(trip);
    const region = await this.cityAdcode(trip.planningInput.cityId);
    return (await this.locations.searchPlaces(keyword, region)).filter((place) =>
      sameActivityCity(region, place.cityAdcode),
    );
  }
  async save(ownerId: string, id: string, input: TripActivityInput, activityId?: string) {
    const current = await this.repository.get(ownerId, id);
    this.planned(current, input.expectedRevision);
    const previous = activityId
      ? current.activities?.find((item) => item.id === activityId)
      : undefined;
    if (activityId && !previous) throw new ApiError('NOT_FOUND', '活动不存在', 404);
    let location: Pick<TripActivity, 'poiId' | 'placeName' | 'address' | 'coordinates'>;
    if (previous?.poiId === input.poiId) location = previous;
    else {
      const resolved = await this.locations.resolve(0, 0, 'GCJ-02', input.poiId);
      const region = await this.cityAdcode(current.planningInput.cityId);
      if (!sameActivityCity(region, resolved.cityAdcode))
        throw new ApiError('VALIDATION_ERROR', '请选择行程所在城市的活动地点', 400);
      location = {
        poiId: input.poiId,
        placeName: resolved.placeName ?? '',
        address: resolved.placeAddress ?? '',
        coordinates: {
          longitude: resolved.longitude,
          latitude: resolved.latitude,
          coordinateSystem: 'GCJ-02',
        },
      };
    }
    return this.repository.mutate(ownerId, id, input.expectedRevision, async (trip) => {
      this.planned(trip);
      const activity: TripActivity = {
        ...location,
        id: activityId ?? randomUUID(),
        title: input.title,
        notes: input.notes,
        date: input.date,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        source: 'amap',
      };
      const next = {
        ...trip,
        activities: [...(trip.activities ?? []).filter((item) => item.id !== activityId), activity],
      };
      assertActivitiesFit(next);
      return next;
    });
  }
  remove(ownerId: string, id: string, expectedRevision: number, activityId: string) {
    return this.repository.mutate(ownerId, id, expectedRevision, async (trip) => {
      this.planned(trip);
      if (!trip.activities?.some((item) => item.id === activityId))
        throw new ApiError('NOT_FOUND', '活动不存在', 404);
      return { ...trip, activities: trip.activities.filter((item) => item.id !== activityId) };
    });
  }
}
