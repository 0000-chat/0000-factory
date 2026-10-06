import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  buildWorkGanttDependencySummary,
  layoutWorkGanttDependencies,
  normalizeWorkGanttDependencyEdges,
  selectWorkGanttDependencyPaths,
  WORK_GANTT_DEFAULT_ROW_HEIGHT,
} from './work-gantt-dependencies.mjs';

const EMPTY_PATHS = [];
const EMPTY_GEOMETRY = { width: 0, height: 0, paths: EMPTY_PATHS };

function rowLayoutSignature(rows) {
  return JSON.stringify((rows ?? []).map(row => ({
    id: row?.id,
    approved: (row?.marks ?? [])
      .filter(mark => mark?.sourceKind === 'approved')
      .map(mark => [mark.id, mark.point === true, mark.startDay, mark.endDay]),
  })));
}

function normalizedLayoutKey(layoutKey) {
  if (layoutKey === null || layoutKey === undefined) return '';
  if (typeof layoutKey === 'string' || typeof layoutKey === 'number' || typeof layoutKey === 'boolean') {
    return String(layoutKey);
  }
  try {
    return JSON.stringify(layoutKey);
  } catch {
    return String(layoutKey);
  }
}

function sameGeometry(left, right) {
  if (left.width !== right.width || left.height !== right.height || left.paths.length !== right.paths.length) return false;
  return left.paths.every((path, index) => {
    const other = right.paths[index];
    return path.id === other?.id && path.path === other.path;
  });
}

function measureGeometry(body, rows, dependencyEdges) {
  const bodyRect = body.getBoundingClientRect();
  const approvedIds = new Set((rows ?? [])
    .filter(row => row?.marks?.some(mark => mark?.sourceKind === 'approved'))
    .map(row => row.id));
  const anchors = new Map();
  const nodes = [...body.querySelectorAll('[data-work-approved-anchor]')];
  const rowBounds = new Map();
  for (const node of body.querySelectorAll('[data-gantt-feature-row]')) {
    const id = node.getAttribute('data-gantt-feature-row');
    if (!id || rowBounds.has(id)) continue;
    const rect = node.getBoundingClientRect();
    rowBounds.set(id, {
      left: rect.left - bodyRect.left,
      right: rect.right - bodyRect.left,
      top: rect.top - bodyRect.top,
      bottom: rect.bottom - bodyRect.top,
    });
  }

  for (const node of nodes) {
    const id = node.getAttribute('data-work-approved-anchor');
    if (!id || !approvedIds.has(id) || anchors.has(id)) continue;
    const rect = node.getBoundingClientRect();
    anchors.set(id, {
      left: rect.left - bodyRect.left,
      right: rect.right - bodyRect.left,
      top: rect.top - bodyRect.top,
      bottom: rect.bottom - bodyRect.top,
      point: node.getAttribute('data-work-approved-point') === 'true',
    });
  }

  const cssRowHeight = Number.parseFloat(window.getComputedStyle(body).getPropertyValue('--gantt-row-height'));
  const paths = layoutWorkGanttDependencies({
    rows,
    dependencyEdges,
    anchors,
    rowBounds,
    rowHeight: Number.isFinite(cssRowHeight) && cssRowHeight > 0 ? cssRowHeight : WORK_GANTT_DEFAULT_ROW_HEIGHT,
  });
  return {
    width: Math.max(1, body.clientWidth, bodyRect.width),
    height: Math.max(1, body.clientHeight, bodyRect.height),
    paths,
  };
}

/** SVG dependency overlay. The body ref owns the approved-anchor coordinate origin. */
export function WorkGanttDependencies({
  bodyRef,
  rows = [],
  dependencyEdges = [],
  activeId = null,
  showAll = false,
  layoutKey = '',
}) {
  const markerId = `work-gantt-dependency-arrow-${useId().replaceAll(':', '')}`;
  const rowsKey = useMemo(() => rowLayoutSignature(rows), [rows]);
  const edgesKey = useMemo(() => JSON.stringify(normalizeWorkGanttDependencyEdges(dependencyEdges)), [dependencyEdges]);
  const layoutVersion = normalizedLayoutKey(layoutKey);
  const rowsRef = useRef(rows);
  const edgesRef = useRef(dependencyEdges);
  rowsRef.current = rows;
  edgesRef.current = dependencyEdges;
  const [geometry, setGeometry] = useState(EMPTY_GEOMETRY);
  const selectedPaths = useMemo(() => selectWorkGanttDependencyPaths(geometry.paths, { activeId, showAll }), [
    geometry.paths,
    activeId,
    showAll,
  ]);

  useEffect(() => {
    const body = bodyRef?.current;
    if (!body || typeof window === 'undefined') {
      setGeometry(EMPTY_GEOMETRY);
      return undefined;
    }

    let frame = null;
    let observer = null;
    const requestFrame = window.requestAnimationFrame?.bind(window)
      ?? (callback => window.setTimeout(callback, 16));
    const cancelFrame = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window);
    const schedule = () => {
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        if (!body.isConnected) return;
        const next = measureGeometry(body, rowsRef.current, edgesRef.current);
        setGeometry(previous => sameGeometry(previous, next) ? previous : next);
      });
    };

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule);
      observer.observe(body);
      const approvedIds = new Set((rowsRef.current ?? [])
        .filter(row => row?.marks?.some(mark => mark?.sourceKind === 'approved'))
        .map(row => row.id));
      for (const node of body.querySelectorAll('[data-work-approved-anchor]')) {
        if (approvedIds.has(node.getAttribute('data-work-approved-anchor'))) observer.observe(node);
      }
      for (const node of body.querySelectorAll('[data-gantt-feature-row]')) observer.observe(node);
    }
    window.addEventListener('resize', schedule);
    body.addEventListener('scroll', schedule, { passive: true });
    schedule();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      body.removeEventListener('scroll', schedule);
      if (frame !== null) cancelFrame(frame);
    };
  }, [bodyRef, rowsKey, edgesKey, layoutVersion]);

  if (!selectedPaths.length || geometry.width <= 0 || geometry.height <= 0) return null;

  return <svg
    className="work-gantt-dependency-overlay"
    aria-hidden="true"
    focusable="false"
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      zIndex: 8,
      width: `${geometry.width}px`,
      height: `${geometry.height}px`,
      overflow: 'visible',
      pointerEvents: 'none',
    }}
    width={geometry.width}
    height={geometry.height}
    viewBox={`0 0 ${geometry.width} ${geometry.height}`}
  >
    <defs>
      <marker
        id={markerId}
        markerWidth="7"
        markerHeight="7"
        refX="6"
        refY="3.5"
        orient="auto"
        markerUnits="userSpaceOnUse"
      >
        <path d="M 0 0 L 7 3.5 L 0 7 z" fill="context-stroke" />
      </marker>
    </defs>
    {selectedPaths.map(path => {
      const active = activeId === path.fromId || activeId === path.toId;
      return <path
        key={path.id}
        d={path.path}
        fill="none"
        stroke={active ? 'var(--primary)' : 'color-mix(in srgb, var(--muted-foreground) 58%, transparent)'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={`url(#${markerId})`}
        vectorEffect="non-scaling-stroke"
        data-work-dependency-edge-id={path.id}
        data-work-dependency-from-id={path.fromId}
        data-work-dependency-to-id={path.toId}
        data-work-dependency-source-x={path.fromX}
        data-work-dependency-source-y={path.fromY}
        data-work-dependency-target-x={path.toX}
        data-work-dependency-target-y={path.toY}
      />;
    })}
  </svg>;
}

function DependencyList({ title, relationships }) {
  if (!relationships.length) return null;
  return <div>
    <h4>{title}</h4>
    <ul>
      {relationships.map(relationship => <li key={relationship.id}>
        <span>{relationship.title}</span>
        {relationship.missingReason ? <small>{relationship.missingReason}</small> : null}
      </li>)}
    </ul>
  </div>;
}

/** Accessible textual dependency explanation for a selected task. */
export function WorkGanttDependencySummary({ activeId, rows = [], dependencyEdges = [], entries = new Map() }) {
  const summary = buildWorkGanttDependencySummary({ activeId, rows, dependencyEdges, entries });
  if (!summary || (!summary.prerequisites.length && !summary.dependents.length)) return null;

  return <section className="work-gantt-dependency-summary" aria-label={`Recorded dependencies for ${summary.activeTitle}`}>
    <p>Recorded prerequisite links describe tracker relationships. Arrow placement does not establish a scheduling constraint.</p>
    <DependencyList title="Prerequisites" relationships={summary.prerequisites} />
    <DependencyList title="Dependents" relationships={summary.dependents} />
  </section>;
}
