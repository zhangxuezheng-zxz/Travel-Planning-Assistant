import type { Trip, TripActivityInput } from '@travel/shared' with { 'resolution-mode': 'import' };
import { ApiError } from '../common/api-error';
import { rejectUnknownFields, requiredString } from '../common/json-body.pipe';
import { revision, validateDates } from './trip-validation';

export function activityInput(body: Record<string, unknown>): TripActivityInput {
  rejectUnknownFields(body, [
    'expectedRevision',
    'title',
    'notes',
    'date',
    'startTime',
    'durationMinutes',
    'poiId',
  ]);
  if (typeof body.date !== 'string') throw new ApiError('VALIDATION_ERROR', '请选择活动日期', 400);
  validateDates(body.date, body.date);
  if (
    typeof body.startTime !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime) ||
    !Number.isInteger(body.durationMinutes) ||
    Number(body.durationMinutes) < 5 ||
    Number(body.durationMinutes) > 720 ||
    minutes(body.startTime) + Number(body.durationMinutes) > 1440
  )
    throw new ApiError(
      'VALIDATION_ERROR',
      '请输入有效的开始时间和 5～720 分钟时长，活动不能跨越当天',
      400,
    );
  const poiId = requiredString(body.poiId, 'poiId', 1, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(poiId))
    throw new ApiError('VALIDATION_ERROR', '请选择高德搜索返回的地点', 400);
  return {
    expectedRevision: revision(body.expectedRevision),
    title: requiredString(body.title, 'title', 1, 120),
    notes: requiredString(body.notes ?? '', 'notes', 0, 1000),
    date: body.date as string,
    startTime: body.startTime,
    durationMinutes: Number(body.durationMinutes),
    poiId,
  };
}
export function minutes(time: string) {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
}
export function timeOf(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function assertActivitiesFit(trip: Trip) {
  if ((trip.activities?.length ?? 0) > 100)
    throw new ApiError('VALIDATION_ERROR', '每个行程最多添加 100 个活动', 400);
  for (const activity of trip.activities ?? []) {
    if (!trip.days.some((day) => day.date === activity.date))
      throw new ApiError('VALIDATION_ERROR', '活动日期必须位于行程日期内', 400);
    const start = minutes(activity.startTime),
      end = start + activity.durationMinutes;
    const scenic = trip.days.find((day) => day.date === activity.date)?.items ?? [];
    const overlaps = (time: string, duration: number) =>
      start < minutes(time) + duration && end > minutes(time);
    if (
      scenic.some((item) => overlaps(item.startTime, item.durationMinutes)) ||
      (trip.activities ?? []).some(
        (item) =>
          item.id !== activity.id &&
          item.date === activity.date &&
          overlaps(item.startTime, item.durationMinutes),
      )
    )
      throw new ApiError(
        'ACTIVITY_TIME_CONFLICT',
        '活动时间与已有安排重叠，请调整日期、开始时间或时长',
        422,
      );
  }
}
