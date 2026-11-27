import type { Place, ScheduleDay, Trip } from '@travel/shared';
import { scheduleGroups } from '@travel/shared/recommendation-engine';
import type { LocalDay } from '../../data/planner';
import { formatScheduleMinutes, scheduleMinutes } from './trip-day';

export function scheduleWindow(day: ScheduleDay | undefined) {
  const first = day?.items[0];
  const last = day?.items.at(-1);
  if (!first || !last) return '无景点';
  const end = scheduleMinutes(last.startTime) + last.durationMinutes;
  return `${first.startTime}–${formatScheduleMinutes(end)}`;
}

export function previewScheduleChanges(
  trip: Trip,
  places: Place[],
  order: LocalDay[],
  changedDates: ReadonlySet<string>,
) {
  const { startDate, endDate } = trip.planningInput;
  if (!startDate || !endDate) throw new Error('行程缺少完整日期');
  const groups = order.map((day) =>
    changedDates.has(day.date) ? day : { date: day.date, placeIds: [] },
  );
  const plan = scheduleGroups(
    places,
    {
      ...trip.planningInput,
      startDate,
      endDate,
      selectedPlaceIds: groups.flatMap(({ placeIds }) => placeIds),
    },
    groups,
  );
  const days = plan.days.map((day, index) =>
    changedDates.has(day.date) ? day : (trip.days[index] ?? day),
  );
  const activityConflicts = (trip.activities ?? [])
    .filter((activity) => {
      const start = scheduleMinutes(activity.startTime);
      const end = start + activity.durationMinutes;
      return days
        .find((day) => day.date === activity.date)
        ?.items.some(
          (item) =>
            start < scheduleMinutes(item.startTime) + item.durationMinutes &&
            end > scheduleMinutes(item.startTime),
        );
    })
    .map((activity) => activity.id);
  return {
    unassigned: plan.unassignedPlaceIds,
    days,
    activityConflicts,
  };
}
