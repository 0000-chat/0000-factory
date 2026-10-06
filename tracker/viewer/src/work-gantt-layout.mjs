export const WORK_GANTT_ROW_HEIGHT = 60;

export const WORK_GANTT_LANES = Object.freeze({
  approved: Object.freeze({ index: 0, count: 2 }),
  proposed: Object.freeze({ index: 4, count: 8 }),
  observed: Object.freeze({ index: 5, count: 8 }),
  forecast: Object.freeze({ index: 6, count: 8 }),
});

/** Source lanes used by a collapsed parent envelope (6px top/bottom gutters). */
export const WORK_GANTT_COLLAPSED_PARENT_LANES = Object.freeze({
  approved: Object.freeze({ index: 4, count: 10 }),
  proposed: Object.freeze({ index: 5, count: 10 }),
  observed: Object.freeze({ index: 6, count: 10 }),
  forecast: Object.freeze({ index: 7, count: 10 }),
});

export const WORK_GANTT_APPROVED_MARK_HEIGHT = 22;
export const WORK_GANTT_SECONDARY_MARK_HEIGHT = 8;
export const WORK_GANTT_ROLLUP_TRACK_HEIGHT = 3;
export const WORK_GANTT_ROLLUP_TRACK_COUNT = 2;
export const WORK_GANTT_ROLLUP_TRACK_GAP = 2;
export const WORK_GANTT_ROLLUP_BAND_HEIGHT = WORK_GANTT_ROW_HEIGHT / 8;

function dayOrdinal(day) {
  if (typeof day !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(year, month - 1, date);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return Math.floor(check.valueOf() / 86400000);
}

/** Greedily place approved child rollups onto two inclusive-day tracks. */
export function placeWorkGanttRollups(rollups) {
  const ordered = (Array.isArray(rollups) ? rollups : [])
    .map((rollup, index) => ({ rollup, index }))
    .sort((left, right) => String(left.rollup?.startDay ?? '').localeCompare(String(right.rollup?.startDay ?? ''))
      || String(left.rollup?.childId ?? '').localeCompare(String(right.rollup?.childId ?? ''))
      || left.index - right.index);
  const trackEnds = [null, null];
  const positionedRollups = [];
  let overflowCount = 0;

  for (const { rollup } of ordered) {
    const start = dayOrdinal(rollup?.startDay);
    const end = rollup?.point === true ? start : dayOrdinal(rollup?.endDay);
    if (start === null || end === null || end < start) {
      overflowCount += 1;
      continue;
    }
    const trackIndex = trackEnds.findIndex(trackEnd => trackEnd === null || trackEnd < start);
    if (trackIndex < 0) {
      overflowCount += 1;
      continue;
    }
    trackEnds[trackIndex] = end;
    positionedRollups.push({ ...rollup, trackIndex });
  }

  return { positionedRollups, overflowCount };
}
