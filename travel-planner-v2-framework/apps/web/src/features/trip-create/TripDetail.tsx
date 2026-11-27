import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { BPlaces, Destination, Place, ScheduleDay, Trip, TripActivity } from '@travel/shared';
import TripAddDialog from './TripAddDialog';
import { getBeijingVisitInfo } from '../../data/beijing';
import { movePlace, reorderPlace, type LocalDay } from '../../data/planner';
import { notifyHost, type TripHostEvents } from './host-integration';
import TripCover from './TripCover';
import TripDayTimeline from './TripDayTimeline';
import TripMap, { type TripPin } from './TripMap';
import TripOuting from './TripOuting';
import TripPlaceCard from './TripPlaceCard';
import TripTools from './TripTools';
import TripTransitSteps from './TripTransitSteps';
import TripPreparation from './TripPreparation';
import { bookingLabels, type BookingStatus } from './trip-booking';
import { destinationDate, scheduleMinutes } from './trip-day';
import type { TripDraftApi } from './trip-draft-client';
import { tripErrorMessage } from './trip-errors';
import { previewScheduleChanges, scheduleWindow } from './trip-schedule-preview';
import { visitConflicts } from './visit-hours';
import {
  buildDays,
  canCompareRoutes,
  formatRouteSummary,
  navigationUrl,
  savedOrder,
  summarizeRoutes,
  transitSummary,
  transportNames,
  type RouteResult,
  outingProgress,
} from './trip-map-routes';
import './trip-detail.css';
import './trip-day.css';

type RouteCache = { tripId: string; results: Map<string, BPlaces.RoutePreview> };

function focusRegion(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
  element?.scrollIntoView({ block: 'start' });
}

function routeText(route: RouteResult | undefined) {
  if (!route) return '正在查询路线…';
  if (route === 'unavailable') return '暂无路线';
  if (route.source === 'estimate') return `约 ${route.durationMinutes} 分钟 · 步行估算`;
  const duration = `约 ${route.durationMinutes} 分钟`;
  return route.paths?.length ? duration : `${duration} · 暂无轨迹`;
}

function TripSchedule({
  trip,
  places,
  previewRoute,
  routeCache,
  cityName,
  timeZone,
  onEdit,
  editDisabled,
  onSaveSchedule,
  getState,
  saveState,
  api,
  onMutated,
}: {
  trip: Trip;
  places: Place[];
  previewRoute?: TripDraftApi['previewRoute'];
  routeCache: RefObject<RouteCache>;
  cityName?: string;
  timeZone?: string;
  onEdit: () => void;
  editDisabled: boolean;
  onSaveSchedule: (days: ScheduleDay[]) => Promise<void>;
  getState: TripDraftApi['getState'];
  saveState: TripDraftApi['saveState'];
  api: TripDraftApi;
  onMutated: (trip: Trip) => void;
}) {
  const [date, setDate] = useState<string | null>(null);
  const [outing, setOuting] = useState(false);
  const [outingError, setOutingError] = useState('');
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLeg, setSelectedLeg] = useState<string | null>(null);
  const [draft, setDraft] = useState<LocalDay[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [bookings, setBookings] = useState<Record<string, BookingStatus>>({});
  const [addition, setAddition] = useState<{ activity?: TripActivity } | null>(null);
  const [deletion, setDeletion] = useState<{
    kind: 'activity' | 'scenic';
    id: string;
    title: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const deletionDialog = useRef<HTMLDialogElement>(null);
  const activityCard = useRef<HTMLElement>(null);
  useEffect(() => {
    if (deletion && !deletionDialog.current?.open) deletionDialog.current?.showModal();
    else if (!deletion) deletionDialog.current?.close();
  }, [deletion]);
  useEffect(() => {
    const card = activityCard.current;
    card?.focus({ preventScroll: true });
    if (card && getComputedStyle(card).getPropertyValue('--trip-inline-card').trim() === '1')
      card.scrollIntoView({ block: 'start' });
  }, [selected]);

  // 勾选“去过”和预约状态都存在服务端 trip_state，换设备也能看到；
  // 读取失败时降级为空并在界面上提示，不再静默丢数据。
  useEffect(() => {
    let active = true;
    getState(trip.id)
      .then((state) => {
        if (!active) return;
        setVisited(new Set(state.visited));
        setBookings(state.bookings);
      })
      .catch(() => {
        if (active) setOutingError('行程状态读取失败，勾选可能不会保存，请刷新重试。');
      });
    return () => {
      active = false;
    };
  }, [getState, trip.id]);

  const agenda = useRef<HTMLElement>(null);
  const mapPane = useRef<HTMLElement>(null);
  const changePreview = useRef<HTMLElement>(null);
  const agendaDays = useRef<HTMLDivElement>(null);
  const stopTrigger = useRef<HTMLButtonElement | null>(null);
  const [routes, setRoutes] = useState<Map<string, RouteResult>>(
    () => new Map(routeCache.current.tripId === trip.id ? routeCache.current.results : []),
  );
  const resolved = useRef(new Map<string, RouteResult>());
  const originalOrder = useMemo(() => savedOrder(trip), [trip]);
  const originalDays = useMemo(
    () => buildDays(trip, places, originalOrder),
    [trip, places, originalOrder],
  );
  const placeNames = useMemo(
    () =>
      new Map([
        ...places.map((place) => [place.id, place.name] as const),
        ...(trip.activities ?? []).map((item) => [item.id, item.title] as const),
      ]),
    [places, trip.activities],
  );
  const changedDays = useMemo(
    () =>
      new Set(
        draft
          ?.filter(
            (day, index) =>
              day.placeIds.length !== originalOrder[index]?.placeIds.length ||
              day.placeIds.some(
                (placeId, position) => placeId !== originalOrder[index]?.placeIds[position],
              ),
          )
          .map((day) => day.date),
      ),
    [draft, originalOrder],
  );
  const draftPreview = useMemo(() => {
    if (!draft || !changedDays.size) return null;
    try {
      return previewScheduleChanges(trip, places, draft, changedDays);
    } catch {
      return null;
    }
  }, [changedDays, draft, places, trip]);
  const days = useMemo(
    () => (draft ? buildDays(trip, places, draft, draftPreview?.days) : originalDays),
    [trip, places, draft, draftPreview, originalDays],
  );
  const itemsByPlace = useMemo(
    () =>
      new Map(
        days.flatMap((day) =>
          (!draftPreview || draftPreview.unassigned.length
            ? day.stops.filter((stop) => stop.activity || !changedDays.has(day.date))
            : day.stops
          ).map((item) => [item.placeId, item]),
        ),
      ),
    [changedDays, draftPreview, days],
  );
  const conflicts = useMemo(
    () =>
      new Map(
        days.flatMap((day) =>
          day.stops.map(({ placeId }) => {
            const hours = getBeijingVisitInfo(placeId)?.hours;
            const timing = itemsByPlace.get(placeId);
            return [
              placeId,
              hours && timing
                ? visitConflicts(hours, day.date, timing.startTime, timing.durationMinutes)
                : [],
            ];
          }),
        ),
      ),
    [days, itemsByPlace],
  );
  const visibleDays = useMemo(
    () => (date ? days.filter((day) => day.date === date) : days),
    [days, date],
  );
  const visibleLegs = useMemo(() => visibleDays.flatMap((day) => day.legs), [visibleDays]);
  const originalVisibleLegs = useMemo(
    () => originalDays.flatMap((day) => (!date || day.date === date ? day.legs : [])),
    [originalDays, date],
  );
  const comparing = visibleDays.some((day) => changedDays.has(day.date));
  const queryLegs = useMemo(
    () =>
      changedDays.size
        ? [
            ...new Map(
              [
                ...visibleLegs,
                ...[...days, ...originalDays].flatMap((day) =>
                  changedDays.has(day.date) ? day.legs : [],
                ),
              ].map((leg) => [leg.key, leg]),
            ).values(),
          ]
        : visibleLegs,
    [changedDays, days, originalDays, visibleLegs],
  );
  const { cityId, transportMode } = trip.planningInput;

  useEffect(() => {
    if (!previewRoute || !queryLegs.length) return;
    if (routeCache.current.tripId !== trip.id)
      routeCache.current = { tripId: trip.id, results: new Map() };
    const cache = routeCache.current.results;
    const controller = new AbortController();
    async function loadRoutes(preview: NonNullable<TripDraftApi['previewRoute']>) {
      for (const leg of queryLegs) {
        if (controller.signal.aborted) return;
        if (cache.has(leg.key) || resolved.current.has(leg.key)) continue;
        const from = leg.from.place?.coordinates;
        const to = leg.to.place?.coordinates;
        let route: RouteResult = 'unavailable';
        if (from && to) {
          try {
            route = await preview({ from, to, cityId, transportMode }, controller.signal);
          } catch {
            // 其他路段仍可以显示。
          }
        }
        if (controller.signal.aborted) return;
        if (route !== 'unavailable' && route.source === 'provider' && route.paths?.length)
          cache.set(leg.key, route);
        resolved.current.set(leg.key, route);
        setRoutes((current) => new Map(current).set(leg.key, route));
        if (from && to) await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    void loadRoutes(previewRoute);
    return () => controller.abort();
  }, [attempt, queryLegs, previewRoute, routeCache, trip.id, cityId, transportMode]);

  const pins = useMemo(
    () =>
      visibleDays.flatMap(({ color, stops }) =>
        stops.flatMap(({ place, number }): TripPin[] =>
          place?.coordinates
            ? [
                {
                  id: place.id,
                  number,
                  label: place.name,
                  position: [place.coordinates.longitude, place.coordinates.latitude],
                  color,
                },
              ]
            : [],
        ),
      ),
    [visibleDays],
  );
  const lines = useMemo(
    () =>
      visibleDays.flatMap(({ color, legs }) =>
        legs.flatMap(({ key }) => {
          const route = routes.get(key);
          return route &&
            route !== 'unavailable' &&
            route.source === 'provider' &&
            route.paths?.length
            ? [{ id: key, color, paths: route.paths }]
            : [];
        }),
      ),
    [visibleDays, routes],
  );
  const availableLegs = queryLegs.filter(
    (leg) => leg.from.place?.coordinates && leg.to.place?.coordinates,
  );
  const pending = previewRoute ? availableLegs.filter(({ key }) => !routes.has(key)).length : 0;
  const incomplete = previewRoute
    ? availableLegs.filter(({ key }) => {
        const route = routes.get(key);
        return route && (route === 'unavailable' || !route.paths?.length);
      })
    : [];
  function showDay(nextDate: string | null) {
    if (!nextDate) setOuting(false);
    setDate(nextDate);
    setSelected(null);
    setSelectedLeg(null);
  }
  const outingDay = outing && !draft ? visibleDays.find((day) => day.date === date) : undefined;
  const today = destinationDate(timeZone);
  const outingState = outingProgress(outingDay, visited);
  const upcoming = outingState.next;

  function enterOuting() {
    const day = date ?? days.find((day) => day.date >= today)?.date ?? days.at(-1)?.date;
    if (!day) return;
    showDay(day);
    setOuting(true);
    setOutingError('');
  }

  function changeVisited(date: string, placeId: string, complete: boolean) {
    const key = `${date}:${placeId}`;
    const next = new Set(visited);
    if (complete) next.add(key);
    else next.delete(key);
    setVisited(next);
    setOutingError('');
    void saveState(trip.id, { visited: [...next] }).catch(() => {
      setOutingError('游览进度保存失败，请检查网络后重试。');
    });
  }
  const focusStop = useCallback((id: string, trigger?: HTMLButtonElement) => {
    if (trigger) stopTrigger.current = trigger;
    setSelected(id);
    setSelectedLeg(null);
  }, []);
  const focusLeg = useCallback((id: string) => {
    setSelectedLeg(id);
    setSelected(null);
  }, []);
  const visibleStops = useMemo(
    () =>
      visibleDays.flatMap((day) =>
        day.stops.flatMap((stop) =>
          stop.place
            ? [
                {
                  place: stop.place,
                  activity: stop.activity,
                  date: day.date,
                  dayNumber: day.number,
                  startTime: itemsByPlace.get(stop.placeId)?.startTime,
                  durationMinutes:
                    itemsByPlace.get(stop.placeId)?.durationMinutes ?? stop.durationMinutes,
                },
              ]
            : [],
        ),
      ),
    [itemsByPlace, visibleDays],
  );
  const activeStopIndex = visibleStops.findIndex(({ place }) => place.id === selected);
  const activeStop = visibleStops[activeStopIndex];
  const activePlace = activeStop?.place;
  const activeActivity = activeStop?.activity;
  const activityTravelWarnings = activeActivity
    ? visibleLegs.flatMap((leg) => {
        if (leg.from.placeId !== activeActivity.id && leg.to.placeId !== activeActivity.id)
          return [];
        const route = routes.get(leg.key);
        if (!route || route === 'unavailable') return [];
        const gap =
          scheduleMinutes(leg.to.startTime) -
          scheduleMinutes(leg.from.startTime) -
          leg.from.durationMinutes;
        return gap < route.durationMinutes
          ? [
              `${leg.to.placeId === activeActivity.id ? '前一站到活动' : '活动到下一站'}约需 ${route.durationMinutes} 分钟，当前只预留 ${Math.max(0, gap)} 分钟，请调整时间。`,
            ]
          : [];
      })
    : [];
  const activeBookingKey = activeStop && `${activeStop.date}:${activeStop.place.id}`;
  const activeLeg = visibleLegs.find((leg) => leg.key === selectedLeg);
  const activeRoute = activeLeg && routes.get(activeLeg.key);
  const legDirections =
    activeLeg?.from.place && activeLeg.to.place
      ? navigationUrl(activeLeg.to.place, transportMode, activeLeg.from.place)
      : null;

  useEffect(() => {
    const list = agendaDays.current;
    if (!selected || !list || list.scrollHeight <= list.clientHeight) return;
    const stop = list.querySelector(`button[data-place-id="${CSS.escape(selected)}"]`);
    if (!stop) return;
    const listBounds = list.getBoundingClientRect();
    const bounds = stop.getBoundingClientRect();
    if (bounds.bottom > listBounds.bottom) list.scrollTop += bounds.bottom - listBounds.bottom;
    if (bounds.top < listBounds.top) list.scrollTop += bounds.top - listBounds.top;
  }, [selected]);

  function closePlace() {
    setSelected(null);
    const trigger = stopTrigger.current;
    if (trigger?.isConnected) {
      trigger.focus();
    } else {
      agenda.current?.focus();
    }
  }
  const summary = summarizeRoutes(visibleLegs, routes);
  const previous = comparing ? summarizeRoutes(originalVisibleLegs, routes) : null;
  const difference =
    previous && canCompareRoutes(previous) && canCompareRoutes(summary)
      ? summary.minutes - previous.minutes
      : null;
  const differenceText =
    difference === 0
      ? '交通耗时相同'
      : difference !== null
        ? `${difference > 0 ? '增加' : '节省'}约 ${Math.abs(difference)} 分钟`
        : previous?.pending || summary.pending
          ? '正在查询对比路线…'
          : '部分路段缺少高德耗时，暂无法比较';

  function moveStop(id: string, direction: -1 | 1, day: string) {
    setDraft((current) => current && reorderPlace(current, id, direction));
    showDay(day);
    setSaveError('');
  }

  function moveToDay(id: string, nextDate: string) {
    setDraft((current) => movePlace(current ?? originalOrder, id, nextDate));
    setOuting(false);
    setDate(null);
    setSelectedLeg(null);
    setSaved(false);
    setSaveError('');
  }

  function changeBooking(key: string, status: BookingStatus | '') {
    const next = { ...bookings };
    if (status) next[key] = status;
    else delete next[key];
    setBookings(next);
    void saveState(trip.id, { bookings: next }).catch(() => {
      setSaveError('预约状态保存失败，请检查网络后重试。');
    });
  }

  const previewError =
    changedDays.size && (!draftPreview || draftPreview.unassigned.length > 0)
      ? draftPreview
        ? `当前日期或路线无法安排：${draftPreview.unassigned.map((id) => placeNames.get(id) ?? id).join('、')}。请调整日期或顺序。`
        : '暂时无法生成时间预览，请检查景点目录或取消调整。'
      : draftPreview?.activityConflicts.length
        ? `调整后的景点时间与活动冲突：${draftPreview.activityConflicts.map((id) => placeNames.get(id) ?? id).join('、')}。请取消调整或先修改活动时间。`
        : '';
  const canSave =
    !saving &&
    !editDisabled &&
    draftPreview &&
    !draftPreview.unassigned.length &&
    !draftPreview.activityConflicts.length;

  function cancelOrder() {
    setDraft(null);
    setSelectedLeg(null);
    setSaveError('');
    if (date && selected) showDay(null);
  }

  async function saveOrder() {
    if (!canSave || !draftPreview) return;
    setSaving(true);
    setSaveError('');
    try {
      await onSaveSchedule(draftPreview.days);
      setDraft(null);
      setSaved(true);
    } catch (error) {
      setSaveError(tripErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function deleteStop() {
    if (!deletion || saving) return;
    setSaving(true);
    setDeleteError('');
    try {
      const updated =
        deletion.kind === 'activity'
          ? await api.removeActivity(trip.id, trip.revision, deletion.id)
          : await api.removeScenic(trip.id, trip.revision, deletion.id);
      onMutated(updated);
      setDeletion(null);
      setSelected(null);
      setSelectedLeg(null);
      setSaved(true);
    } catch (failure) {
      setDeleteError(tripErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="trip-detail-layout">
      {addition && (
        <TripAddDialog
          trip={trip}
          places={places}
          api={api}
          initialDate={date}
          activity={addition.activity}
          onClose={() => setAddition(null)}
          onSaved={(updated, selectedId) => {
            onMutated(updated);
            setAddition(null);
            setSelected(selectedId || null);
            setSelectedLeg(null);
            setSaved(true);
          }}
        />
      )}
      <dialog
        className="trip-delete-stop-dialog"
        ref={deletionDialog}
        aria-labelledby="trip-delete-stop-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!saving) setDeletion(null);
        }}
      >
        <h2 id="trip-delete-stop-title">移除{deletion?.kind === 'activity' ? '活动' : '景点'}？</h2>
        <p>
          将从此行程移除“{deletion?.title}”。
          {deletion?.kind === 'scenic'
            ? '不会删除景点目录中的资料；其余安排会保留。'
            : '其余景点与活动会保留。'}
        </p>
        {deleteError && (
          <p className="trip-add-error" role="alert">
            {deleteError}
          </p>
        )}
        <footer>
          <button type="button" disabled={saving} onClick={() => setDeletion(null)}>
            取消
          </button>
          <button type="button" disabled={saving} onClick={() => void deleteStop()}>
            {saving ? '正在移除…' : '确认移除'}
          </button>
        </footer>
      </dialog>
      <section className="trip-detail-agenda" aria-label="每日行程" ref={agenda} tabIndex={-1}>
        <header className="trip-detail-section-header">
          <h2>每日行程</h2>
          <button
            type="button"
            className="trip-text-button trip-map-jump"
            onClick={() => focusRegion(mapPane.current)}
          >
            回到地图 <span aria-hidden="true">↑</span>
          </button>
          <button
            className="trip-view-all"
            type="button"
            aria-pressed={date === null}
            onClick={() => showDay(null)}
          >
            查看全部
          </button>
        </header>
        <div className="trip-order-controls" data-editing={Boolean(draft)}>
          {draft ? (
            <>
              <button type="button" onClick={cancelOrder} disabled={saving}>
                取消
              </button>
              <button
                type="button"
                className="workspace-primary"
                onClick={() => void saveOrder()}
                disabled={!canSave}
              >
                {saving ? '正在保存…' : '保存安排'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setAddition({})}
                disabled={editDisabled || saving}
              >
                <span aria-hidden="true">＋ </span>添加
              </button>
              <button
                className="trip-order-toggle"
                type="button"
                disabled={editDisabled || originalOrder.every((day) => day.placeIds.length < 2)}
                onClick={() => {
                  setOuting(false);
                  setDraft(originalOrder);
                  setSaved(false);
                }}
              >
                调整顺序
              </button>
            </>
          )}
          {saved && <span role="status">已保存新安排</span>}
        </div>
        {previewError && (
          <p className="workspace-error trip-order-error" role="status">
            {previewError}
          </p>
        )}
        {saveError && (
          <p className="workspace-error trip-order-error" role="alert">
            {saveError}
          </p>
        )}
        <div className="trip-agenda-days" ref={agendaDays}>
          {(outingDay ? [outingDay] : days).map((day) => (
            <section className="trip-detail-day" key={day.date}>
              <h3>
                <button
                  className="trip-day-button"
                  type="button"
                  aria-pressed={date === day.date}
                  onClick={() => showDay(day.date)}
                >
                  <span className="trip-day-swatch" style={{ background: day.color }} />第{' '}
                  {day.number} 天{' '}
                  <time dateTime={day.date}>
                    {Number(day.date.slice(5, 7))}月{Number(day.date.slice(8))}日
                  </time>
                </button>
              </h3>
              {previewRoute && day.legs.length > 0 && (
                <p className="trip-day-traffic">
                  {formatRouteSummary(summarizeRoutes(day.legs, routes), transportMode)}
                </p>
              )}
              {!day.stops.length && <p className="trip-detail-muted">当天未安排景点</p>}
              {day.stops.length > 0 &&
                day.stops.every(({ placeId }) => itemsByPlace.has(placeId)) && (
                  <TripDayTimeline
                    items={day.stops.map(({ placeId }) => itemsByPlace.get(placeId)!)}
                    names={placeNames}
                  />
                )}
              <ol>
                {day.stops.map((stop, index) => {
                  const leg = day.legs[index - 1];
                  const place = stop.place;
                  const timing = itemsByPlace.get(stop.placeId);
                  const warning = conflicts.get(stop.placeId)?.[0];
                  const booking = bookings[`${day.date}:${stop.placeId}`];
                  const needsBooking = getBeijingVisitInfo(stop.placeId)?.booking
                    .reservationRequired;
                  const completed = Boolean(
                    outingDay && visited.has(`${day.date}:${stop.placeId}`),
                  );
                  return (
                    <li key={stop.placeId}>
                      {leg && previewRoute && (
                        <button
                          type="button"
                          className="trip-leg-info"
                          aria-label={`查看${leg.from.place?.name ?? '上一站'}到${place?.name ?? '本站'}的路线`}
                          aria-pressed={selectedLeg === leg.key}
                          onClick={() => {
                            if (date && date !== day.date) setDate(day.date);
                            focusLeg(leg.key);
                          }}
                        >
                          {leg.from.place?.coordinates && place?.coordinates
                            ? routeText(routes.get(leg.key))
                            : '景点缺少坐标'}
                          {transportMode === 'transit' && transitSummary(routes.get(leg.key)) && (
                            <span className="trip-leg-lines">
                              {transitSummary(routes.get(leg.key))}
                            </span>
                          )}
                        </button>
                      )}
                      <div className="trip-stop-row">
                        <button
                          className={`trip-stop ${stop.activity ? 'trip-stop-activity' : ''}`}
                          type="button"
                          data-place-id={stop.placeId}
                          data-completed={completed}
                          aria-pressed={selected === stop.placeId}
                          disabled={!place}
                          onClick={(event) => {
                            if (date && date !== day.date) setDate(day.date);
                            focusStop(stop.placeId, event.currentTarget);
                          }}
                        >
                          <span className="trip-stop-number" style={{ background: day.color }}>
                            {stop.number}
                          </span>
                          <span>
                            <strong>
                              {stop.activity && <span className="trip-stop-kind">活动</span>}
                              {place?.name ?? '景点资料不可用'}
                            </strong>
                            <span className="trip-detail-muted">
                              {timing
                                ? `${timing.startTime} · ${stop.activity ? '活动' : '游览'} ${timing.durationMinutes} 分钟`
                                : '时间待调整'}
                            </span>
                            {warning && <span className="trip-visit-badge">{warning.label}</span>}
                            {(booking || needsBooking) && (
                              <span className="trip-booking-badge">
                                {booking ? bookingLabels[booking] : '需预约'}
                              </span>
                            )}
                          </span>
                        </button>
                        {outingDay && (
                          <label className="trip-stop-complete">
                            <input
                              type="checkbox"
                              checked={completed}
                              aria-label={`${stop.activity ? '已完成活动' : '已游览'}${place?.name ?? `地点 ${stop.number}`}`}
                              onChange={(event) =>
                                changeVisited(day.date, stop.placeId, event.target.checked)
                              }
                            />
                          </label>
                        )}
                        {draft &&
                          !stop.activity &&
                          (draft.find((item) => item.date === day.date)?.placeIds.length ?? 0) >
                            1 && (
                            <div className="trip-order-arrows">
                              <button
                                type="button"
                                aria-label={`上移${place?.name ?? stop.number}`}
                                disabled={
                                  saving ||
                                  draft.find((item) => item.date === day.date)?.placeIds[0] ===
                                    stop.placeId
                                }
                                onClick={() => moveStop(stop.placeId, -1, day.date)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                aria-label={`下移${place?.name ?? stop.number}`}
                                disabled={
                                  saving ||
                                  draft.find((item) => item.date === day.date)?.placeIds.at(-1) ===
                                    stop.placeId
                                }
                                onClick={() => moveStop(stop.placeId, 1, day.date)}
                              >
                                ↓
                              </button>
                            </div>
                          )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      </section>
      <section className="trip-detail-map" aria-label="地图与路线" ref={mapPane} tabIndex={-1}>
        <header className="trip-detail-section-header">
          <h2>地图与路线</h2>
          <div className="trip-map-heading-actions">
            <span className="trip-map-scope">
              {date ?? '全部日期'} · {transportNames[transportMode]}
            </span>
            {!outingDay && (
              <button
                type="button"
                className="trip-view-all trip-outing-open"
                disabled={Boolean(draft)}
                onClick={enterOuting}
              >
                出游模式
              </button>
            )}
          </div>
          <button
            type="button"
            className="trip-text-button trip-map-jump"
            onClick={() => focusRegion(agenda.current)}
          >
            跳到每日行程 <span aria-hidden="true">↓</span>
          </button>
        </header>
        {outingDay && (
          <TripOuting
            days={days}
            date={outingDay.date}
            today={today}
            count={outingState.count}
            completed={outingState.completed}
            next={
              upcoming && {
                id: upcoming.placeId,
                name: upcoming.place?.name ?? '景点资料不可用',
                time: upcoming.startTime,
                directions: upcoming.place ? navigationUrl(upcoming.place, transportMode) : null,
                hasDetails: Boolean(upcoming.place),
                activity: Boolean(upcoming.activity),
                reminder: conflicts.get(upcoming.placeId)?.[0]?.label,
              }
            }
            error={outingError}
            onDate={(nextDate) => {
              showDay(nextDate);
              setOutingError('');
            }}
            onExit={() => showDay(null)}
            onOpen={focusStop}
            onComplete={(id) => changeVisited(outingDay.date, id, true)}
          />
        )}
        {saved && (
          <p className="trip-map-saved" role="status">
            已保存新安排
          </p>
        )}
        {previewRoute && (
          <div className="trip-traffic-summary" aria-label="站间交通汇总" aria-live="polite">
            <div className="trip-traffic-total">
              <strong>{date ? '当天交通' : '行程交通'}</strong>
              <span>{formatRouteSummary(summary, transportMode)}</span>
            </div>
            {previous && (
              <div className="trip-route-comparison" aria-label="调序前后对比">
                <span>
                  <small>调整前</small> {formatRouteSummary(previous, transportMode)}
                </span>
                <span>
                  <small>调整后</small> {formatRouteSummary(summary, transportMode)}
                </span>
                <strong
                  data-change={
                    difference === null || difference === 0
                      ? 'neutral'
                      : difference > 0
                        ? 'longer'
                        : 'shorter'
                  }
                >
                  {differenceText}
                </strong>
              </div>
            )}
          </div>
        )}
        {changedDays.size > 0 && (
          <section
            className="trip-change-preview"
            aria-label="受影响日期"
            ref={changePreview}
            tabIndex={-1}
          >
            <strong>调整预览</strong>
            {days
              .filter((day) => changedDays.has(day.date))
              .map((day) => {
                const original = originalDays[day.number - 1]!;
                const nextSchedule = draftPreview?.days[day.number - 1];
                return (
                  <div key={day.date}>
                    <button
                      className="trip-text-button"
                      type="button"
                      onClick={() => showDay(day.date)}
                    >
                      第 {day.number} 天 · {day.date}
                    </button>
                    <span>
                      {original.stops.length} 站 → {day.stops.length} 站
                    </span>
                    <span>
                      {scheduleWindow(trip.days[day.number - 1])} →{' '}
                      {nextSchedule?.items.length === day.stops.length
                        ? scheduleWindow(nextSchedule)
                        : '时间待调整'}
                    </span>
                    {previewRoute && (
                      <span>
                        {formatRouteSummary(summarizeRoutes(original.legs, routes), transportMode)}
                        {' → '}
                        {formatRouteSummary(summarizeRoutes(day.legs, routes), transportMode)}
                      </span>
                    )}
                  </div>
                );
              })}
            {(previewError || saveError) && (
              <p className="trip-preview-error" role={saveError ? 'alert' : 'status'}>
                {saveError || previewError}
              </p>
            )}
            <div className="trip-order-controls trip-preview-actions" data-editing="true">
              <button
                type="button"
                onClick={() => {
                  cancelOrder();
                  focusRegion(mapPane.current);
                }}
                disabled={saving}
              >
                取消调整
              </button>
              <button
                type="button"
                className="workspace-primary"
                onClick={() => {
                  void saveOrder();
                  mapPane.current?.focus({ preventScroll: true });
                }}
                disabled={!canSave}
              >
                {saving ? '正在保存…' : '保存安排'}
              </button>
            </div>
          </section>
        )}
        <div className="trip-map-stage">
          {pins.length ? (
            <TripMap
              pins={pins}
              lines={lines}
              selected={selected}
              selectedLine={selectedLeg}
              onSelect={focusStop}
              onSelectLine={focusLeg}
              onOverview={() => {
                setSelected(null);
                setSelectedLeg(null);
              }}
            />
          ) : (
            <p className="trip-map-status">所选日期没有可显示的景点坐标。</p>
          )}
          {activeActivity && (
            <section
              className="trip-map-info trip-place-card trip-activity-card"
              aria-label="活动详情"
              ref={activityCard}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  closePlace();
                }
              }}
            >
              <button
                type="button"
                className="trip-map-info-close"
                aria-label="关闭活动详情"
                onClick={closePlace}
              >
                ×
              </button>
              <span className="trip-stop-kind">活动 · 高德地点</span>
              <h3>{activeActivity.title}</h3>
              <p>
                <strong>{activeActivity.placeName}</strong>
                <br />
                {activeActivity.address}
              </p>
              <p>
                {activeActivity.date} · {activeActivity.startTime} ·{' '}
                {activeActivity.durationMinutes} 分钟
              </p>
              {activeActivity.notes && (
                <p className="trip-activity-notes">{activeActivity.notes}</p>
              )}
              <p>活动时间由你安排，往返交通请查看站间路线。</p>
              {activityTravelWarnings.map((message, i) => (
                <p className="trip-add-error" role="status" key={i}>
                  {message}
                </p>
              ))}
              <div className="trip-activity-card-actions">
                <button
                  type="button"
                  disabled={saving || editDisabled || Boolean(draft)}
                  onClick={() => setAddition({ activity: activeActivity })}
                >
                  编辑活动
                </button>
                <button
                  type="button"
                  disabled={saving || editDisabled || Boolean(draft)}
                  onClick={() => {
                    setDeleteError('');
                    setDeletion({
                      kind: 'activity',
                      id: activeActivity.id,
                      title: activeActivity.title,
                    });
                  }}
                >
                  删除活动
                </button>
                {activePlace && (
                  <a
                    href={navigationUrl(activePlace, transportMode) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    高德导航 ↗
                  </a>
                )}
              </div>
            </section>
          )}
          {activeStop && activeBookingKey && !activeActivity && (
            <TripPlaceCard
              key={activeBookingKey}
              place={activeStop.place}
              visit={activeStop}
              directions={navigationUrl(activeStop.place, transportMode)}
              previous={visibleStops[activeStopIndex - 1]?.place}
              next={visibleStops[activeStopIndex + 1]?.place}
              conflicts={conflicts.get(activeStop.place.id) ?? []}
              moveDates={days.filter((day) => day.date !== activeStop.date)}
              onMove={
                saving || editDisabled
                  ? undefined
                  : (nextDate) => moveToDay(activeStop.place.id, nextDate)
              }
              onReviewChanges={
                changedDays.size ? () => focusRegion(changePreview.current) : undefined
              }
              booking={bookings[activeBookingKey]}
              bookedForAnotherDate={Object.entries(bookings).some(
                ([key, status]) =>
                  key !== activeBookingKey &&
                  key.endsWith(`:${activeStop.place.id}`) &&
                  status === 'booked',
              )}
              onBookingChange={(status) => changeBooking(activeBookingKey, status)}
              onSelect={focusStop}
              onClose={closePlace}
              onRemove={
                saving || editDisabled || Boolean(draft)
                  ? undefined
                  : () => {
                      setDeleteError('');
                      setDeletion({
                        kind: 'scenic',
                        id: activeStop.place.id,
                        title: activeStop.place.name,
                      });
                    }
              }
            />
          )}
          {activeLeg && (
            <section className="trip-map-info trip-route-card" aria-label="路段详情">
              <button
                type="button"
                className="trip-map-info-close"
                aria-label="关闭路段详情"
                onClick={() => setSelectedLeg(null)}
              >
                ×
              </button>
              <h3>
                {activeLeg.from.place?.name ?? '上一站'} → {activeLeg.to.place?.name ?? '本站'}
              </h3>
              <p>
                {transportNames[transportMode]} ·{' '}
                {activeLeg.from.place?.coordinates && activeLeg.to.place?.coordinates
                  ? routeText(routes.get(activeLeg.key))
                  : '景点缺少坐标'}
              </p>
              {transportMode === 'transit' && (
                <TripTransitSteps
                  steps={
                    activeRoute && activeRoute !== 'unavailable'
                      ? activeRoute.transitSteps
                      : undefined
                  }
                />
              )}
              {legDirections && (
                <a href={legDirections} target="_blank" rel="noreferrer">
                  在高德查看{transportMode === 'transit' ? '公交' : ''}路线 ↗
                </a>
              )}
            </section>
          )}
        </div>
        <div className="trip-detail-map-footer">
          {pending > 0 && <p role="status">正在查询 {pending} 段路线…</p>}
          {incomplete.length > 0 && (
            <>
              <p>{incomplete.length} 段暂无轨迹，地图仍可查看景点位置。</p>
              <button
                type="button"
                onClick={() => {
                  for (const { key } of incomplete) resolved.current.delete(key);
                  setRoutes((current) => {
                    const next = new Map(current);
                    for (const { key } of incomplete) next.delete(key);
                    return next;
                  });
                  setAttempt((value) => value + 1);
                }}
              >
                重试路线
              </button>
            </>
          )}
          {pins.length > 0 && !visibleLegs.length && <p>这段日程的地图只显示景点位置。</p>}
        </div>
      </section>
      <TripTools
        trip={trip}
        cityName={cityName}
        guidePlace={activePlace?.name}
        days={originalDays}
        trafficScope={`${date ?? '全部日期'} · ${transportNames[transportMode]}`}
        trafficSummary={
          previewRoute ? formatRouteSummary(summary, transportMode) : '路线预览不可用'
        }
        trafficLegs={
          previewRoute
            ? visibleLegs.map(({ key, from, to }) => {
                const route = routes.get(key);
                return {
                  id: key,
                  label: `${from.place?.name ?? '上一站'} → ${to.place?.name ?? '本站'}`,
                  duration:
                    from.place?.coordinates && to.place?.coordinates
                      ? routeText(routes.get(key))
                      : '景点缺少坐标',
                  lines: transportMode === 'transit' ? transitSummary(routes.get(key)) : '',
                  transitSteps:
                    transportMode === 'transit' && route && route !== 'unavailable'
                      ? route.transitSteps
                      : undefined,
                  navigation:
                    from.place && to.place
                      ? navigationUrl(to.place, transportMode, from.place)
                      : null,
                };
              })
            : []
        }
        transportMode={transportMode}
        onSelectLeg={focusLeg}
        onEdit={onEdit}
        editDisabled={editDisabled}
        getState={() => getState(trip.id)}
        saveState={(patch) => saveState(trip.id, patch)}
      />
    </div>
  );
}

export default function TripDetail({
  id,
  api,
  cities,
  routeCache,
  onBack,
  onEdit,
  editDisabled,
  editError,
  onSaved,
}: {
  id: string;
  api: TripDraftApi;
  cities: Destination[];
  routeCache: RefObject<RouteCache>;
  onBack: () => void;
  onEdit: () => void;
  editDisabled: boolean;
  editError: string;
  onSaved?: TripHostEvents['onSaved'];
}) {
  const [data, setData] = useState<{ trip: Trip; places: Place[] } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void api
      .get(id)
      .then(async (trip) => ({ trip, places: await api.getPlaces(trip.planningInput.cityId) }))
      .then((value) => {
        if (active) setData(value);
      })
      .catch((failure) => {
        if (active) setError(tripErrorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [api, id, attempt]);
  const trip = data?.trip;
  const city = cities.find((item) => item.id === trip?.planningInput.cityId);

  return (
    <main className="trip-workspace trip-detail">
      <TripCover
        trip={trip}
        city={city}
        onBack={onBack}
        onEdit={onEdit}
        editDisabled={editDisabled}
      />
      {editError && (
        <p className="workspace-error" role="alert">
          {editError}
        </p>
      )}
      {error && (
        <p className="workspace-error" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            重新读取行程
          </button>
        </p>
      )}
      {!data && !error && <p role="status">正在读取行程…</p>}
      {trip && (trip.status === 'draft' || !trip.days.length) && <p>此行程还没有保存每日安排。</p>}
      {data?.trip.status === 'planned' && data.trip.days.length > 0 && (
        <TripSchedule
          trip={data.trip}
          places={data.places}
          previewRoute={api.previewRoute}
          routeCache={routeCache}
          cityName={city?.name}
          timeZone={city?.timeZone}
          onEdit={onEdit}
          editDisabled={editDisabled}
          getState={api.getState}
          saveState={api.saveState}
          api={api}
          onMutated={(updated) => {
            setData({ trip: updated, places: data.places });
            notifyHost(onSaved, updated);
          }}
          onSaveSchedule={async (days) => {
            const { trip: current, places } = data;
            const updated = await api.updateSchedule(current.id, current.revision, days);
            setData({ trip: updated, places });
            notifyHost(onSaved, updated);
          }}
        />
      )}
      {data?.trip.status === 'planned' && (
        <TripPreparation
          key={data.trip.id}
          destination={city?.name ?? ''}
          startDate={data.trip.planningInput.startDate ?? ''}
          endDate={data.trip.planningInput.endDate ?? ''}
          themes={data.trip.planningInput.themes}
          transport={data.trip.planningInput.transportMode}
        />
      )}
    </main>
  );
}
