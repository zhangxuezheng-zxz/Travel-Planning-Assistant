import { useEffect, useRef, useState } from 'react';
import type { Place, Trip, TripActivity } from '@travel/shared';
import type { TripDraftApi } from './trip-draft-client';
import { tripErrorMessage } from './trip-errors';
import TripMap from './TripMap';
import { formatScheduleMinutes, scheduleMinutes } from './trip-day';
import './trip-additions.css';

type PickedLocation = {
  id: string;
  name: string;
  address: string;
  coordinates: Place['coordinates'];
  place?: Place;
  poiId?: string;
};
export default function TripAddDialog({
  trip,
  places,
  api,
  initialDate,
  activity,
  onClose,
  onSaved,
}: {
  trip: Trip;
  places: Place[];
  api: TripDraftApi;
  initialDate?: string | null;
  activity?: TripActivity;
  onClose: () => void;
  onSaved: (trip: Trip, selectedId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<'activity' | 'scenic' | null>(activity ? 'activity' : null);
  const [keyword, setKeyword] = useState(activity?.placeName ?? '');
  const [results, setResults] = useState<PickedLocation[]>([]);
  const [picked, setPicked] = useState<PickedLocation | null>(() =>
    activity
      ? {
          id: activity.poiId,
          poiId: activity.poiId,
          name: activity.placeName,
          address: activity.address,
          coordinates: activity.coordinates,
        }
      : null,
  );
  const [date, setDate] = useState(activity?.date ?? initialDate ?? trip.days[0]?.date ?? '');
  const initialEnd = Math.max(
    540,
    ...trip.days
      .filter((day) => day.date === (initialDate ?? trip.days[0]?.date))
      .flatMap((day) =>
        day.items.map((item) => scheduleMinutes(item.startTime) + item.durationMinutes),
      ),
    ...(trip.activities ?? [])
      .filter((item) => item.date === (initialDate ?? trip.days[0]?.date))
      .map((item) => scheduleMinutes(item.startTime) + item.durationMinutes),
  );
  const [startTime, setStartTime] = useState(
    activity?.startTime ?? formatScheduleMinutes(Math.min(initialEnd + 30, 1380)),
  );
  const [duration, setDuration] = useState(String(activity?.durationMinutes ?? 60));
  const [title, setTitle] = useState(activity?.title ?? '');
  const [notes, setNotes] = useState(activity?.notes ?? '');
  const titleEdited = useRef(Boolean(activity));
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    if (!element?.open) element?.showModal();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    setSearchError('');
    setResults([]);
    setSearching(false);
    const query = keyword.trim();
    if (!kind || !query || (picked && query === picked.name)) return;
    if (kind === 'scenic') {
      setResults(
        places
          .filter(
            (place) =>
              !trip.planningInput.selectedPlaceIds.includes(place.id) &&
              `${place.name} ${place.address} ${place.category}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          )
          .slice(0, 20)
          .map((place) => ({
            id: place.id,
            name: place.name,
            address: place.address,
            coordinates: place.coordinates,
            place,
          })),
      );
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .searchActivityLocations(trip.id, query, controller.signal)
        .then((found) => {
          if (!controller.signal.aborted)
            setResults(
              found.map((place) => ({
                id: place.poiId,
                poiId: place.poiId,
                name: place.name,
                address: place.address,
                coordinates: {
                  longitude: place.longitude,
                  latitude: place.latitude,
                  coordinateSystem: 'GCJ-02',
                },
              })),
            );
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setSearchError(tripErrorMessage(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, kind, keyword, picked, places, trip.id, trip.planningInput.selectedPlaceIds]);

  function chooseKind(next: 'activity' | 'scenic') {
    if (next === kind) return;
    setKind(next);
    setKeyword('');
    setPicked(null);
    setResults([]);
    setError('');
  }
  function chooseLocation(location: PickedLocation) {
    setPicked(location);
    setKeyword(location.name);
    setResults([]);
    setError('');
    if (!titleEdited.current) setTitle(location.name);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!picked || !kind || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      let updated: Trip;
      if (kind === 'activity')
        updated = await api.saveActivity(
          trip.id,
          {
            expectedRevision: trip.revision,
            title: title.trim(),
            notes: notes.trim(),
            date,
            startTime,
            durationMinutes: Number(duration),
            poiId: picked.poiId!,
          },
          activity?.id,
        );
      else updated = await api.addScenic(trip.id, trip.revision, picked.id, date);
      const selectedId =
        kind === 'scenic'
          ? picked.id
          : (activity?.id ??
            updated.activities?.find((item) => !trip.activities?.some((old) => old.id === item.id))
              ?.id);
      onSaved(updated, selectedId ?? '');
    } catch (failure) {
      setError(tripErrorMessage(failure));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      className="trip-add-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      aria-labelledby="trip-add-title"
    >
      <header className="trip-add-header">
        <div>
          <span>MAKE ROOM FOR A LITTLE MORE</span>
          <h2 id="trip-add-title">{activity ? '编辑活动' : '为旅程加一站'}</h2>
          <p>
            {activity
              ? '调整活动安排，地点和备注都会保存在这份行程中。'
              : '景点来自精选目录，活动留给你的自由安排。'}
          </p>
        </div>
        <button
          type="button"
          className="trip-add-close"
          aria-label="关闭添加窗口"
          disabled={saving}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {!kind ? (
        <div className="trip-add-kind-grid">
          <button type="button" onClick={() => chooseKind('scenic')}>
            <span className="trip-add-kind-icon" aria-hidden="true">
              ▥
            </span>
            <strong>添加景点</strong>
            <span>从当前城市的景点目录中选择</span>
            <small>数据库景点 · 可加入游览安排</small>
            <b aria-hidden="true">↗</b>
          </button>
          <button type="button" onClick={() => chooseKind('activity')}>
            <span className="trip-add-kind-icon" aria-hidden="true">
              ⌖
            </span>
            <strong>添加活动</strong>
            <span>用高德寻找餐厅、咖啡馆或其他地点</span>
            <small>自定义标题、时间与备注</small>
            <b aria-hidden="true">↗</b>
          </button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          {!activity && (
            <div className="trip-add-tabs" role="group" aria-label="添加类型">
              <button
                type="button"
                disabled={saving}
                aria-pressed={kind === 'scenic'}
                onClick={() => chooseKind('scenic')}
              >
                景点 · 数据库
              </button>
              <button
                type="button"
                disabled={saving}
                aria-pressed={kind === 'activity'}
                onClick={() => chooseKind('activity')}
              >
                活动 · 高德地点
              </button>
            </div>
          )}
          <fieldset disabled={saving} className="trip-add-fields">
            <div className="trip-add-search-area">
              <label htmlFor="trip-add-search">
                {kind === 'activity' ? '搜索活动地点' : '搜索数据库景点'}
              </label>
              <div className="trip-add-search-box">
                <span aria-hidden="true">⌕</span>
                <input
                  id="trip-add-search"
                  type="search"
                  maxLength={80}
                  autoComplete="off"
                  value={keyword}
                  placeholder={
                    kind === 'activity'
                      ? '搜索餐厅、咖啡馆、商场等地点'
                      : '输入景点名称、地址或类别'
                  }
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    setPicked(null);
                  }}
                />
              </div>
              <p className="trip-add-search-note">
                {kind === 'activity'
                  ? '仅搜索行程所在城市；选中结果即可查看位置。'
                  : '只显示本市数据库中尚未加入行程的景点。'}
              </p>
              {searching && (
                <p role="status" className="trip-add-empty">
                  正在搜索高德地点…
                </p>
              )}
              {searchError && (
                <p role="alert" className="trip-add-error">
                  {searchError}
                </p>
              )}
              {results.length > 0 && (
                <ul className="trip-add-results" aria-label="地点搜索结果">
                  {results.map((location) => (
                    <li key={location.id}>
                      <button type="button" onClick={() => chooseLocation(location)}>
                        <span className="trip-add-result-pin" aria-hidden="true">
                          ⌖
                        </span>
                        <span>
                          <strong>{location.name}</strong>
                          <small>{location.address || '该地点暂无详细地址'}</small>
                        </span>
                        <span aria-hidden="true">↗</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {keyword.trim() && !searching && !searchError && !picked && !results.length && (
                <p className="trip-add-empty" role="status">
                  {kind === 'scenic'
                    ? '数据库中没有匹配的未添加景点。要安排目录外地点，可切换到“活动”。'
                    : '没有找到匹配地点，换一个关键词试试。'}
                </p>
              )}
              {picked && (
                <section className="trip-add-picked" aria-label="已选地点位置">
                  <div>
                    <span>已定位</span>
                    <strong>{picked.name}</strong>
                    <p>{picked.address || '暂无详细地址'}</p>
                  </div>
                  {picked.coordinates ? (
                    <>
                      <div className="trip-add-map">
                        <TripMap
                          pins={[
                            {
                              id: picked.id,
                              number: 1,
                              label: picked.name,
                              position: [picked.coordinates.longitude, picked.coordinates.latitude],
                              color: '#386653',
                            },
                          ]}
                          lines={[]}
                          selected={picked.id}
                          selectedLine={null}
                          onSelect={() => {}}
                          onSelectLine={() => {}}
                          onOverview={() => {}}
                        />
                      </div>
                      <small>
                        位置坐标：{picked.coordinates.longitude.toFixed(5)},{' '}
                        {picked.coordinates.latitude.toFixed(5)}
                      </small>
                    </>
                  ) : (
                    <small>此景点尚无地图坐标</small>
                  )}
                </section>
              )}
            </div>
            <div className="trip-add-form-grid">
              {kind === 'activity' && (
                <label className="trip-add-full">
                  活动名称
                  <input
                    required
                    maxLength={120}
                    value={title}
                    onChange={(event) => {
                      titleEdited.current = true;
                      setTitle(event.target.value);
                    }}
                    placeholder="例如：午餐、咖啡小憩、逛街"
                  />
                </label>
              )}
              <label>
                安排日期
                <select required value={date} onChange={(event) => setDate(event.target.value)}>
                  {trip.days.map((day, i) => (
                    <option key={day.date} value={day.date}>
                      第 {i + 1} 天 · {day.date}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'activity' ? (
                <>
                  <label>
                    开始时间
                    <input
                      type="time"
                      required
                      value={startTime}
                      onChange={(event) => setStartTime(event.target.value)}
                    />
                  </label>
                  <label>
                    活动时长（分钟）
                    <input
                      type="number"
                      min={5}
                      max={720}
                      step={1}
                      required
                      value={duration}
                      onChange={(event) => setDuration(event.target.value)}
                    />
                  </label>
                  <label className="trip-add-full">
                    活动备注 <span>选填</span>
                    <textarea
                      maxLength={1000}
                      rows={3}
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="预约信息、想点的菜，或留给自己的提醒…"
                    />
                  </label>
                </>
              ) : (
                <p className="trip-add-form-hint">
                  景点会追加到所选日期的现有景点之后，保留已有安排，并避开活动时段。当天容量不足时请改选日期。
                  {picked?.place && (
                    <strong>建议游览 {picked.place.suggestedDurationMinutes} 分钟</strong>
                  )}
                </p>
              )}
            </div>
          </fieldset>
          {error && (
            <p className="trip-add-error" role="alert">
              {error} 你的输入已保留。
            </p>
          )}
          <footer className="trip-add-footer">
            <span>
              {kind === 'activity'
                ? '活动仅保存在此行程，不会加入公共景点目录。'
                : '景点资料以数据库目录为准。'}
            </span>
            <button type="submit" className="workspace-primary" disabled={saving || !picked}>
              {saving
                ? '正在保存…'
                : activity
                  ? '保存修改'
                  : kind === 'activity'
                    ? '添加活动'
                    : '添加景点'}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
