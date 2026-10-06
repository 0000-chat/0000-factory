export const TASK_CONTENT_EDITABLE_FIELDS = [
  'title',
  'sections.outcome',
  'sections.completionCondition',
  'sections.nextStep',
  'sections.evidence',
] as const;

export type TaskContentEditableField = typeof TASK_CONTENT_EDITABLE_FIELDS[number];
