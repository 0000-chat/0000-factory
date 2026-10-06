import { Schema } from '@livestore/livestore';
import type { TrackerDraftOverlay } from './livestore-schema';
import type { TrackerItem, TrackerSnapshot } from './snapshot';
import { TASK_CONTENT_EDITABLE_FIELDS, type TaskContentEditableField } from './task-content-fields';

export const TASK_CONTENT_DRAFT_COLLECTION = 'task-content';

export const TASK_EDITABLE_FIELDS = TASK_CONTENT_EDITABLE_FIELDS;

export type TaskEditableField = TaskContentEditableField;

export const taskDraftFieldSchema = Schema.Union(
  Schema.Literal('title'),
  Schema.Literal('sections.outcome'),
  Schema.Literal('sections.completionCondition'),
  Schema.Literal('sections.nextStep'),
  Schema.Literal('sections.evidence'),
);

export const taskDraftFieldValueSchema = Schema.Struct({
  value: Schema.String,
  baseValue: Schema.String,
  baseSourceCommit: Schema.String,
  baseContentRevision: Schema.String,
});

const taskDraftFieldsSchema = Schema.Struct({
  title: Schema.optional(taskDraftFieldValueSchema),
  'sections.outcome': Schema.optional(taskDraftFieldValueSchema),
  'sections.completionCondition': Schema.optional(taskDraftFieldValueSchema),
  'sections.nextStep': Schema.optional(taskDraftFieldValueSchema),
  'sections.evidence': Schema.optional(taskDraftFieldValueSchema),
});

const taskDraftPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  fields: taskDraftFieldsSchema,
});

export type TaskDraftFieldValue = typeof taskDraftFieldValueSchema.Type;
export type TaskDraftPayload = typeof taskDraftPayloadSchema.Type;

export interface TaskDraftFieldChange {
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly value: string;
}

export interface TaskDraftFieldRestore {
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly fieldState: TaskDraftFieldValue | null;
}

export interface ParsedTaskContentDraft {
  readonly id: string;
  readonly recordId: string;
  readonly updatedAt: string;
  readonly payload: TaskDraftPayload;
}

type MutableTaskDraftFields = Partial<Record<TaskEditableField, TaskDraftFieldValue>>;

export function taskContentDraftId(itemId: string): string {
  return `${TASK_CONTENT_DRAFT_COLLECTION}:${itemId}`;
}

export function taskDraftFieldValue(item: TrackerItem, field: TaskEditableField): string {
  switch (field) {
    case 'title': return item.title;
    case 'sections.outcome': return item.sections.outcome;
    case 'sections.completionCondition': return item.sections.completionCondition;
    case 'sections.nextStep': return item.sections.nextStep;
    case 'sections.evidence': return item.sections.evidence;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

export function parseTaskDraftPayload(payloadJson: string): TaskDraftPayload {
  let decodedJson: unknown;
  try {
    decodedJson = JSON.parse(payloadJson);
  } catch (cause) {
    throw new Error('Saved task draft is not valid JSON.', { cause });
  }
  return Schema.decodeUnknownSync(taskDraftPayloadSchema, { onExcessProperty: 'error' })(decodedJson);
}

export function parseTaskContentDraftOverlays(
  rows: readonly TrackerDraftOverlay[],
): ParsedTaskContentDraft[] {
  const drafts: ParsedTaskContentDraft[] = [];
  for (const row of rows) {
    if (row.collection !== TASK_CONTENT_DRAFT_COLLECTION) continue;
    if (row.recordId.length === 0 || row.id !== taskContentDraftId(row.recordId)) {
      throw new Error(`Saved task draft ${row.id} has an invalid item identity.`);
    }
    const payload = parseTaskDraftPayload(row.payloadJson);
    if (TASK_EDITABLE_FIELDS.every(field => payload.fields[field] === undefined)) continue;
    drafts.push({ id: row.id, recordId: row.recordId, updatedAt: row.updatedAt, payload });
  }
  return drafts;
}

export function updateTaskDraftPayload({
  existing,
  field,
  value,
  canonicalValue,
  sourceCommit,
  contentRevision,
}: {
  readonly existing: TaskDraftPayload | null;
  readonly field: TaskEditableField;
  readonly value: string;
  readonly canonicalValue: string;
  readonly sourceCommit: string;
  readonly contentRevision: string;
}): TaskDraftPayload | null {
  const fields: MutableTaskDraftFields = { ...(existing?.fields ?? {}) };

  if (value === canonicalValue) {
    delete fields[field];
  } else {
    const previous = fields[field];
    fields[field] = {
      value,
      baseValue: previous?.baseValue ?? canonicalValue,
      baseSourceCommit: previous?.baseSourceCommit ?? sourceCommit,
      baseContentRevision: previous?.baseContentRevision ?? contentRevision,
    };
  }

  if (TASK_EDITABLE_FIELDS.every(candidate => fields[candidate] === undefined)) return null;
  return { schemaVersion: 1, fields };
}

export function restoreTaskDraftPayloadField({
  existing,
  field,
  fieldState,
}: {
  readonly existing: TaskDraftPayload | null;
  readonly field: TaskEditableField;
  readonly fieldState: TaskDraftFieldValue | null;
}): TaskDraftPayload | null {
  const fields: MutableTaskDraftFields = { ...(existing?.fields ?? {}) };
  if (fieldState === null) delete fields[field];
  else fields[field] = fieldState;
  if (TASK_EDITABLE_FIELDS.every(candidate => fields[candidate] === undefined)) return null;
  return { schemaVersion: 1, fields };
}

function withDraftField(item: TrackerItem, field: TaskEditableField, value: string): TrackerItem {
  switch (field) {
    case 'title':
      return item.title === value ? item : { ...item, title: value };
    case 'sections.outcome':
      return item.sections.outcome === value ? item : { ...item, sections: { ...item.sections, outcome: value } };
    case 'sections.completionCondition':
      return item.sections.completionCondition === value ? item : { ...item, sections: { ...item.sections, completionCondition: value } };
    case 'sections.nextStep':
      return item.sections.nextStep === value ? item : { ...item, sections: { ...item.sections, nextStep: value } };
    case 'sections.evidence':
      return item.sections.evidence === value ? item : { ...item, sections: { ...item.sections, evidence: value } };
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

export function composeTaskContentDrafts(
  canonical: TrackerSnapshot,
  rows: readonly TrackerDraftOverlay[],
): { readonly snapshot: TrackerSnapshot; readonly drafts: readonly ParsedTaskContentDraft[] } {
  const drafts = parseTaskContentDraftOverlays(rows);
  if (drafts.length === 0) return { snapshot: canonical, drafts };

  const draftByItem = new Map<string, ParsedTaskContentDraft>();
  for (const draft of drafts) draftByItem.set(draft.recordId, draft);
  let changed = false;
  const items = canonical.items.map(item => {
    const draft = draftByItem.get(item.id);
    if (draft === undefined) return item;

    let effective = item;
    for (const field of TASK_EDITABLE_FIELDS) {
      const change = draft.payload.fields[field];
      if (change !== undefined) effective = withDraftField(effective, field, change.value);
    }
    if (effective !== item) changed = true;
    return effective;
  });

  if (!changed) return { snapshot: canonical, drafts };
  const itemById = new Map<string, TrackerItem>();
  for (const item of items) itemById.set(item.id, item);
  return { snapshot: { ...canonical, items, itemById }, drafts };
}
