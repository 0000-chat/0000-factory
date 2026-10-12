import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  getProposedScheduleKind,
  getWorkDateDetails,
  getWorkDateLabel,
} from '../src/work-schedule-labels.mjs';

function row(timeline = {}, overrides = {}) {
  return {
    entry: {
      timeline: {
        ownPlannedStart: null,
        ownPlannedDue: null,
        ownProposedStart: null,
        ownProposedDue: null,
        ownForecastStart: null,
        ownForecastDue: null,
        ...timeline,
      },
    },
    ...overrides,
  };
}

test('schedule labels distinguish unscheduled rows from proposals awaiting approval', () => {
  assert.equal(getWorkDateLabel(row()), 'Unscheduled');
  assert.equal(getWorkDateLabel(row({ ownProposedStart: '2026-10-14', ownProposedDue: '2026-10-16' })), 'Dates awaiting approval');
});

test('proposed child dates count as dated without promoting approval', () => {
  const proposal = {
    startDay: '2026-10-14',
    endDay: '2026-10-16',
    marks: [{ sourceKind: 'proposed', proposedScheduleKind: 'slice' }],
  };
  const details = getWorkDateDetails(row({}, {
    hasChildren: true,
    eligibleChildCount: 2,
    undatedChildCount: 2,
    childSummaryIntervals: [
      { childId: 'approved', sourceKind: 'approved', startDay: '2026-10-10', endDay: '2026-10-12' },
      { childId: 'proposal', sourceKind: 'proposed', startDay: '2026-10-14', endDay: '2026-10-16' },
    ],
    childApprovedEnvelope: { startDay: '2026-10-10', endDay: '2026-10-12', marks: [{ sourceKind: 'approved' }] },
    childProposedEnvelope: proposal,
  }));

  assert.equal(details.hasApprovedDates, true);
  assert.equal(details.hasProposedDates, true);
  assert.equal(details.childCounts.undated, 0);
  assert.equal(details.label, 'Scheduled');
  assert.equal(details.childProposed.kind, 'slice');
  assert.equal(getProposedScheduleKind(proposal), 'slice');
});

test('partial child schedules do not inflate the undated count', () => {
  const details = getWorkDateDetails(row({ ownPlannedStart: '2026-10-10', ownPlannedDue: '2026-10-12' }, {
    hasChildren: true,
    eligibleChildCount: 3,
    undatedChildCount: 3,
    childDateCounts: { total: 3, dated: 2, undated: 1 },
  }));
  assert.deepEqual(details.childCounts, { total: 3, dated: 2, undated: 1 });
  assert.equal(details.label, '1 child undated');
});

test('observed-only child activity remains undated', () => {
  const details = getWorkDateDetails(row({}, {
    hasChildren: true,
    eligibleChildCount: 1,
    childSummaryIntervals: [{ childId: 'active', sourceKind: 'observed', startDay: '2026-10-10', endDay: '2026-10-12' }],
  }));
  assert.equal(details.childCounts.undated, 1);
  assert.equal(details.label, 'Unscheduled');
});

test('forecast-only dates remain visible without becoming approved dates', () => {
  const details = getWorkDateDetails(row({ ownForecastStart: '2026-10-20', ownForecastDue: '2026-10-22' }));
  assert.equal(details.hasApprovedDates, false);
  assert.equal(details.hasProposedDates, false);
  assert.equal(details.hasForecastDates, true);
  assert.equal(details.forecastLabel, 'Forecast dates');
  assert.equal(details.label, 'Forecast only');
});

test('forecast child dates count as dated while proposals still await approval', () => {
  const details = getWorkDateDetails(row({ ownProposedStart: '2026-10-24', ownProposedDue: '2026-10-26' }, {
    hasChildren: true,
    eligibleChildCount: 3,
    childSummaryIntervals: [
      { childId: 'approved', sourceKind: 'approved', startDay: '2026-10-10', endDay: '2026-10-12' },
      { childId: 'proposal', sourceKind: 'proposed', startDay: '2026-10-14', endDay: '2026-10-16' },
      { childId: 'forecast', sourceKind: 'forecast', startDay: '2026-10-18', endDay: '2026-10-19' },
    ],
  }));
  assert.equal(details.childCounts.undated, 0);
  assert.equal(details.approvalPending, true);
  assert.equal(details.label, 'Dates awaiting approval');
});
