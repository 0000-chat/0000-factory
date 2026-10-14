import {
  ArrowLeft,
  ArrowUpRight,
  History,
  Pencil,
  ShieldAlert,
} from 'lucide-react';
import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { legacyHashPath } from '../navigation.ts';
import { ItemBreadcrumbs } from '../item-breadcrumbs.tsx';
import { TrackerEmpty } from '../tracker-empty.tsx';
import { PersonLink } from '../person-link';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { taskDraftFieldValue } from '../task-drafts.ts';
import {
  ApprovalSummary,
  BadgeChip,
  HealthSummary,
  healthLabel,
  humanize,
  ItemChips,
  Markdown,
  ProgressSummary,
  ScheduleSummary,
  statusTone,
  formatDate,
  formatTimestamp,
  decisionHref,
  workHref,
} from '../shared.jsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../components/ui/sheet.tsx';
import './details.css';

function PersonMeta({ data, value, name, avatar = false, pill = false, className }) {
  if (!value && !name) return null;
  return <PersonLink data={data} value={value ?? null} name={name ?? null} avatar={avatar} pill={pill} className={className} />;
}

function itemById(data, id) {
  return data?.itemById?.get?.(id) ?? data?.items?.find(item => item.id === id) ?? null;
}

function historyById(data, id) {
  return (data?.history ?? []).find(entry => entry.id === id) ?? null;
}

function recordTitle(record, fallback) {
  return record?.title || fallback || 'Untitled record';
}

function resolveMarkdownLink(href, data) {
  const raw = String(href ?? '').trim();
  if (/^(?:https?:|mailto:)/i.test(raw)) return raw;
  if (raw.startsWith('//')) return null;
  if (raw.startsWith('#/')) return legacyHashPath(raw);
  if (raw.startsWith('/')) return raw;
  if (raw.startsWith('#')) return raw;

  const path = raw.split(/[?#]/, 1)[0].replace(/^\.\//, '');
  const target = path.split('/').at(-1)?.replace(/\.md$/i, '');
  if (!target) return null;
  const decision = (data?.decisions ?? []).find(candidate =>
    candidate.id === target || candidate.sourcePath === path || candidate.sourcePath?.endsWith(`/${path}`)
  );
  if (decision) return decisionHref(decision.id);
  const item = itemById(data, target) ?? (data?.items ?? []).find(candidate =>
    candidate.sourcePath === path || candidate.sourcePath?.endsWith(`/${path}`)
  );
  if (item) return workHref(item.id);
  const history = historyById(data, target) ?? (data?.history ?? []).find(candidate =>
    candidate.sourcePath === path || candidate.sourcePath?.endsWith(`/${path}`)
  );
  return history ? workHref(history.id) : null;
}

function orderedUpdates(updates = []) {
  const dateMillis = value => {
    if (!value) return null;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? null : parsed;
  };

  return [...updates].sort((left, right) => {
    const leftTime = dateMillis(left?.observedAt);
    const rightTime = dateMillis(right?.observedAt);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime === null && rightTime !== null) return 1;
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  });
}

function ItemLink({ id, label, data, renderItemLink, className }) {
  const target = itemById(data, id) ?? historyById(data, id);
  const text = label || recordTitle(target, id);
  const node = renderItemLink?.(id, text);
  return <span className={className || 'detail-item-link'}>{node ?? <Link to="/work/$itemId" params={{ itemId: id }}>{text}</Link>}</span>;
}

function MarkdownSection({ title, value, data, className = '' }) {
  return <section className={`detail-record-section ${className}`.trim()}>
    <h2>{title}</h2>
    {value ? <Markdown value={value} className="detail-record-markdown" resolveLink={href => resolveMarkdownLink(href, data)} /> : <p className="empty-copy">No {title.toLowerCase()} recorded.</p>}
  </section>;
}

function isComposingEnter(event, composing) {
  return composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
}

const anotherTabMessage = 'This field is being edited in another tab. The text remains in this open editor; retry after that edit ends.';

function useTaskFieldEdit({ itemId, field, value, fieldState, canonicalAtStart, taskEdit, multiline }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const [editMessage, setEditMessage] = useState('');
  const [completionPending, setCompletionPending] = useState(false);
  const editSession = useRef(null);
  const taskEditRef = useRef(taskEdit);
  const editorRef = useRef(null);
  const composing = useRef(false);
  taskEditRef.current = taskEdit;

  useEffect(() => {
    if (!editing && editSession.current === null) setDraft(value);
  }, [editing, value]);

  const completeSession = (session, disposition) => {
    if (editSession.current !== session || session.phase !== 'started') return;
    session.completionValue = session.currentValue;
    session.phase = disposition === 'cancel' ? 'canceling' : 'finishing';
    session.closeIntent = null;
    setCompletionPending(true);
    const acknowledgement = disposition === 'cancel'
      ? taskEditRef.current.cancelSession(session.sessionId)
      : taskEditRef.current.finishSession(session.sessionId);
    void acknowledgement.then(() => {
      taskEditRef.current.releasePendingSession(session.sessionId);
      if (editSession.current !== session) return;
      editSession.current = null;
      setCompletionPending(false);
      setEditing(false);
      setDraft(disposition === 'cancel' ? session.beforeValue : session.currentValue);
      setEditMessage('');
    }, () => {
      taskEditRef.current.releasePendingSession(session.sessionId);
      if (editSession.current !== session) return;
      session.phase = 'failed';
      session.failedDisposition = disposition;
      setCompletionPending(false);
      setEditing(true);
      setEditMessage(disposition === 'cancel'
        ? 'Could not confirm that this edit was canceled. The text remains in this open editor; retry editing this field.'
        : 'Could not confirm that this task edit was saved. The text remains in this open editor; retry editing this field.');
    });
  };

  const beginAttempt = session => {
    session.phase = 'acquiring';
    setEditMessage('');
    void taskEditRef.current.beginSession({
      sessionId: session.sessionId,
      itemId,
      field,
      beforeValue: session.beforeValue,
      beforeFieldState: session.beforeFieldState,
      canonicalAtStart: session.canonicalAtStart,
    }).then(result => {
      if (editSession.current !== session) {
        const shouldCancel = session.closeIntent === 'cancel' || (!multiline && !session.currentValue.trim());
        if (result === 'started') {
          if (!shouldCancel) {
            for (const nextValue of session.queuedValues) taskEditRef.current.changeSessionValue(session.sessionId, nextValue);
            session.queuedValues.length = 0;
          }
          const acknowledgement = shouldCancel
            ? taskEditRef.current.cancelSession(session.sessionId)
            : taskEditRef.current.finishSession(session.sessionId);
          void acknowledgement.then(
            () => taskEditRef.current.releasePendingSession(session.sessionId),
            () => taskEditRef.current.releasePendingSession(session.sessionId),
          );
        } else {
          taskEditRef.current.releasePendingSession(session.sessionId);
        }
        return;
      }
      session.phase = result;
      if (result !== 'started') {
        setEditMessage(result === 'busy'
          ? anotherTabMessage
          : result === 'pending'
            ? 'A previous edit to this field is still being acknowledged. The text remains in this open editor; retry shortly.'
            : result === 'unsupported'
            ? 'This browser cannot coordinate task edits across tabs. The text remains only in this open editor.'
            : 'Task edit history is still loading. The text remains in this open editor; retry shortly.');
        if (session.closeIntent === 'cancel') {
          editSession.current = null;
          setEditing(false);
          setDraft(session.beforeValue);
          taskEditRef.current.releasePendingSession(session.sessionId);
        } else if (session.closeIntent === 'finish') {
          session.closeIntent = null;
          setEditing(true);
        }
        return;
      }
      for (const nextValue of session.queuedValues) taskEditRef.current.changeSessionValue(session.sessionId, nextValue);
      session.queuedValues.length = 0;
      if (session.closeIntent !== null) {
        const disposition = !multiline && !session.currentValue.trim() ? 'cancel' : session.closeIntent;
        completeSession(session, disposition);
      }
    }).catch(() => {
      if (editSession.current !== session) {
        taskEditRef.current.releasePendingSession(session.sessionId);
        return;
      }
      session.phase = 'busy';
      setEditMessage('Could not start this edit session. The text remains only in this open editor; retry editing this field.');
      if (session.closeIntent === 'cancel') {
        editSession.current = null;
        setEditing(false);
        setDraft(session.beforeValue);
        taskEditRef.current.releasePendingSession(session.sessionId);
      } else if (session.closeIntent === 'finish') {
        session.closeIntent = null;
        setEditing(true);
      }
    });
  };

  const beginEditing = () => {
    if (editSession.current !== null) return;
    const session = {
      sessionId: crypto.randomUUID(),
      phase: 'acquiring',
      closeIntent: null,
      beforeValue: value,
      currentValue: value,
      completionValue: null,
      beforeFieldState: fieldState,
      canonicalAtStart,
      queuedValues: [],
    };
    editSession.current = session;
    taskEditRef.current.registerPendingSession(session.sessionId);
    setDraft(value);
    setInvalid(false);
    setEditMessage('');
    setEditing(true);
    beginAttempt(session);
  };

  const finishEditing = () => {
    const session = editSession.current;
    if (session === null) return;
    if (session.phase === 'finishing' || session.phase === 'canceling') return;
    if (!multiline && !session.currentValue.trim()) {
      if (session.phase === 'started') completeSession(session, 'cancel');
      else {
        session.closeIntent = 'cancel';
        if (session.phase === 'acquiring') setEditing(true);
        else {
          editSession.current = null;
          setEditing(false);
          setDraft(session.beforeValue);
        }
      }
      setInvalid(true);
      return;
    }
    if (session.phase === 'started') completeSession(session, !multiline && !session.currentValue.trim() ? 'cancel' : 'finish');
    else if (session.phase === 'acquiring') {
      session.closeIntent = 'finish';
      setEditing(true);
    }
  };

  const cancelEditing = event => {
    event.preventDefault();
    event.stopPropagation();
    const session = editSession.current;
    if (session === null) return;
    if (session.phase === 'finishing' || session.phase === 'canceling') return;
    if (session.phase === 'started') completeSession(session, 'cancel');
    else {
      session.closeIntent = 'cancel';
      if (session.phase === 'acquiring') setEditing(true);
      else {
        editSession.current = null;
        setEditing(false);
        setDraft(session.beforeValue);
        taskEditRef.current.releasePendingSession(session.sessionId);
      }
    }
    setInvalid(false);
  };

  const onChange = event => {
    const nextValue = event.currentTarget.value;
    const session = editSession.current;
    setDraft(nextValue);
    setInvalid(false);
    if (session === null) return;
    if (session.phase === 'finishing' || session.phase === 'canceling') return;
    session.currentValue = nextValue;
    if (session.phase === 'started') taskEditRef.current.changeSessionValue(session.sessionId, nextValue);
    else session.queuedValues.push(nextValue);
  };

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      cancelEditing(event);
      return;
    }
    if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey) && !isComposingEnter(event, composing)) {
      event.preventDefault();
      finishEditing();
    }
  };

  const retryEditing = () => {
    const session = editSession.current;
    if (session === null || session.phase === 'acquiring' || session.phase === 'started') return;
    if (session.phase === 'failed' && session.failedDisposition !== undefined) {
      const disposition = session.failedDisposition;
      const valueUnchangedSinceCompletion = session.currentValue === session.completionValue;
      session.failedDisposition = undefined;
      setEditMessage('');
      if (valueUnchangedSinceCompletion) {
        session.phase = 'started';
        taskEditRef.current.registerPendingSession(session.sessionId);
        completeSession(session, disposition);
      } else {
        // A failed completion may have already materialized locally and removed
        // its session row. Use a fresh identity and the materialized value as
        // the new baseline so the retry cannot duplicate the old history action
        // or give it a stale undo checkpoint.
        const retrySession = {
          sessionId: crypto.randomUUID(),
          phase: 'acquiring',
          closeIntent: disposition === 'finish' ? 'finish' : null,
          beforeValue: disposition === 'finish'
            ? (session.completionValue ?? session.beforeValue)
            : session.beforeValue,
          currentValue: session.currentValue,
          completionValue: null,
          beforeFieldState: fieldState,
          canonicalAtStart,
          queuedValues: [session.currentValue],
        };
        editSession.current = retrySession;
        setEditing(true);
        taskEditRef.current.registerPendingSession(retrySession.sessionId);
        beginAttempt(retrySession);
        requestAnimationFrame(() => editorRef.current?.focus());
      }
      return;
    }
    session.closeIntent = null;
    taskEditRef.current.registerPendingSession(session.sessionId);
    setEditing(true);
    beginAttempt(session);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  const cleanupSession = useRef(() => {});
  cleanupSession.current = () => {
    const session = editSession.current;
    if (session === null) return;
    if (session.phase === 'started') completeSession(session, !multiline && !session.currentValue.trim() ? 'cancel' : 'finish');
    else if (session.phase === 'acquiring') {
      if (session.closeIntent !== 'cancel') session.closeIntent = 'finish';
      editSession.current = null;
    } else if (session.phase === 'finishing' || session.phase === 'canceling') {
      return;
    } else {
      editSession.current = null;
      taskEditRef.current.releasePendingSession(session.sessionId);
    }
  };
  useEffect(() => () => cleanupSession.current(), [itemId, field]);

  return {
    editing,
    draft,
    invalid,
    editMessage,
    completionPending,
    editorRef,
    composing,
    beginEditing,
    finishEditing,
    cancelEditing,
    onChange,
    onKeyDown,
    retryEditing,
    setComposing: value => { composing.current = value; },
  };
}

export function EditableTaskTitle({ itemId, value, fieldState, canonicalAtStart, taskEdit, onEditingChange }) {
  const edit = useTaskFieldEdit({ itemId, field: 'title', value, fieldState, canonicalAtStart, taskEdit, multiline: false });

  useEffect(() => onEditingChange?.(edit.editing), [edit.editing, onEditingChange]);

  return <>
    {edit.editing
      ? <Input
          autoFocus
          ref={edit.editorRef}
          aria-label="Edit title"
          aria-invalid={edit.invalid}
          aria-busy={edit.completionPending}
          readOnly={edit.completionPending}
          aria-describedby={edit.invalid ? 'task-title-validation' : edit.editMessage ? 'task-title-edit-message' : undefined}
          className="detail-title-input"
          value={edit.draft}
          onChange={edit.onChange}
          onCompositionStart={() => edit.setComposing(true)}
          onCompositionEnd={() => edit.setComposing(false)}
          onKeyDown={edit.onKeyDown}
          onBlur={edit.finishEditing}
        />
      : <button className="detail-title-edit" type="button" aria-label="Edit title" onClick={edit.beginEditing}>
          <span>{value.trim() ? value : <span className="detail-edit-placeholder">Add a task title</span>}</span>
          <Pencil size={15} aria-hidden="true" />
        </button>}
    {edit.invalid ? <span id="task-title-validation" className="detail-edit-validation" role="alert">A task title cannot be empty.</span> : null}
    {edit.editMessage ? <span id="task-title-edit-message" className="detail-edit-validation" role="status">{edit.editMessage} {edit.editMessage.includes('open editor') ? <Button type="button" variant="outline" size="xs" onClick={edit.retryEditing}>Retry editing this field</Button> : null}</span> : null}
  </>;
}

function EditableTaskSection({ itemId, field, title, value, fieldState, canonicalAtStart, data, taskEdit }) {
  const edit = useTaskFieldEdit({ itemId, field, value, fieldState, canonicalAtStart, taskEdit, multiline: true });
  const inputId = `edit-${itemId}-${field.replaceAll('.', '-')}`;
  const previewId = `${inputId}-preview`;

  return <section
    className={`detail-record-section detail-editable-section${edit.editing ? ' is-editing' : ''}`}
    data-editable-field={field}
    onClick={event => {
      if (edit.editing) return;
      if (event.target instanceof Element && event.target.closest('a, button')) return;
      edit.beginEditing();
    }}
  >
    <div className="detail-editable-heading">
      <h2>{title}</h2>
      {!edit.editing ? <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit ${title.toLowerCase()}`} onClick={edit.beginEditing}><Pencil size={14} aria-hidden="true" /></Button> : null}
    </div>
    {edit.editing
      ? <div className="detail-edit-form">
          <Textarea
            autoFocus
            ref={edit.editorRef}
            id={inputId}
            aria-label={`Edit ${title.toLowerCase()}`}
            aria-busy={edit.completionPending}
            readOnly={edit.completionPending}
            aria-describedby={edit.editMessage ? `${previewId} ${inputId}-message` : previewId}
            value={edit.draft}
            onChange={edit.onChange}
            onCompositionStart={() => edit.setComposing(true)}
            onCompositionEnd={() => edit.setComposing(false)}
            onKeyDown={edit.onKeyDown}
            onBlur={edit.finishEditing}
          />
          <div id={previewId} className="detail-edit-live-preview" aria-label={`${title} draft preview`}>
            <span className="eyebrow">Live preview</span>
            {edit.draft.trim() ? <Markdown value={edit.draft} className="detail-record-markdown" resolveLink={href => resolveMarkdownLink(href, data)} /> : <p className="empty-copy">No {title.toLowerCase()} recorded.</p>}
          </div>
          <p className="detail-edit-hint">Press Ctrl+Enter or ⌘+Enter to finish. Press Escape to cancel.</p>
          {edit.editMessage ? <p id={`${inputId}-message`} className="detail-edit-validation" role="status">{edit.editMessage} {edit.editMessage.includes('open editor') ? <Button type="button" variant="outline" size="xs" onClick={edit.retryEditing}>Retry editing this field</Button> : null}</p> : null}
        </div>
      : <div className="detail-editable-preview" data-testid={`task-field-${field.replaceAll('.', '-')}`}>
          {value.trim()
            ? <Markdown value={value} className="detail-record-markdown" resolveLink={href => resolveMarkdownLink(href, data)} />
            : <button type="button" className="detail-edit-placeholder-button" onClick={edit.beginEditing}>Add {title.toLowerCase()}</button>}
        </div>}
  </section>;
}

function DetailSource({ record, label = 'Snapshot record' }) {
  if (!record) return null;
  return <section className="detail-record-section detail-source-record" aria-label={label}>
    <h2>{label}</h2>
    <p>Updated {formatDate(record.updatedAt)}. Source <code>{record.sourcePath || 'Unknown'}</code>{record.completedAt ? ` · completed ${formatDate(record.completedAt)}` : ''}.</p>
  </section>;
}

function DetailNotFound({ id, kind = 'work item' }) {
  const recordName = kind === 'decision' ? 'decision record' : kind;
  const message = id
    ? <>No {recordName} named <code>{id}</code> is present in this snapshot.</>
    : kind === 'decision'
      ? <>No decision record is available in this snapshot.</>
      : <>No work item or historical record is available in this snapshot.</>;
  return <section className="detail-not-found">
    <TrackerEmpty
      className="detail-not-found-card"
      headerClassName="items-start text-left"
      icon={<ShieldAlert size={25} aria-hidden="true" />}
      title={<><p className="eyebrow">Unavailable record</p><h1>{kind === 'decision' ? 'Decision record unavailable' : 'Work item unavailable'}</h1></>}
      description={message}
      action={<Link className="detail-back-link" to="/"><ArrowLeft size={16} aria-hidden="true" />Back to tracker</Link>}
    />
  </section>;
}

function RelationList({ title, ids, data, onSelectItem, renderItemLink, action = 'link', empty = 'None recorded.' }) {
  const values = ids ?? [];
  return <section className="detail-record-section detail-relation-section">
    <h2>{title}</h2>
    {values.length ? <ul className="detail-relation-list">{values.map(id => {
      const related = itemById(data, id) ?? historyById(data, id);
      const label = recordTitle(related, id);
      return <li key={id}>
        {action === 'select' ? <button className="detail-relation-link" type="button" onClick={() => onSelectItem?.(id)}><ArrowUpRight size={14} aria-hidden="true" />{label}</button> : <ItemLink id={id} label={label} data={data} renderItemLink={renderItemLink} />}
        <span className="detail-relation-meta">{related ? `${humanize(related.commitment ?? related.status ?? 'recorded')}${related.health?.state ? ` · ${healthLabel(related.health.state).toLowerCase()} health` : ''}` : 'Not present in this snapshot'}</span>
      </li>;
    })}</ul> : <p className="empty-copy">{empty}</p>}
  </section>;
}

function CompactDecisionList({ decisions, data }) {
  return decisions?.length ? <section className="detail-block compact-detail-block">
    <h3>Linked decisions</h3>
    <ul className="linked-list">{decisions.map(decision => <li key={decision.id}>
      <span><Link className="text-link" to="/decisions/$decisionId" params={{ decisionId: decision.id }}><ArrowUpRight size={14} aria-hidden="true" />{decision.title}</Link><small>{humanize(decision.state)} · {decision.ownerName || decision.owner ? <PersonMeta data={data} value={decision.owner} name={decision.ownerName} /> : 'Owner unknown'}</small></span>
      <BadgeChip tone={decision.state === 'approved' ? 'green' : 'amber'}>{humanize(decision.state)}</BadgeChip>
    </li>)}</ul>
  </section> : null;
}

function CompactUpdates({ updates }) {
  const latest = orderedUpdates(updates).slice(0, 4);
  if (!latest.length) return null;
  return <section className="detail-block compact-detail-block" aria-label="Recent updates">
    <h3>Recent updates</h3>
    <ul className="update-list">{latest.map(update => <li key={update.id} data-update-id={update.id}>
      <span>{update.source || update.title || update.id}</span><time dateTime={update.observedAt || undefined}>{formatDate(update.observedAt)}</time>
    </li>)}</ul>
  </section>;
}

function CompactHistoryDetail({ entry, data, onSelectItem }) {
  const replacement = entry.supersededBy ? itemById(data, entry.supersededBy) : null;
  return <div className="detail-body history-detail">
    <div className="detail-title-row"><div><p className="eyebrow">Historical record</p><h2>{entry.title}</h2><p className="detail-id">{entry.id}</p></div><BadgeChip tone="slate">History</BadgeChip></div>
    <section className="detail-block compact-detail-block"><h3>Replacement</h3>{replacement ? <button className="text-link" type="button" onClick={() => onSelectItem?.(replacement.id)}><ArrowUpRight size={14} aria-hidden="true" />{replacement.title}</button> : entry.supersededBy ? <p className="source-note">Replaced by {entry.supersededBy}, which is not present in this snapshot.</p> : <p className="empty-copy">No replacement is recorded.</p>}</section>
    <div className="detail-grid"><section><h3>Outcome</h3><Markdown value={entry.sections?.outcome} /></section><section><h3>Evidence</h3><Markdown value={entry.evidence ?? entry.sections?.evidence} /></section></div>
    <DetailSource record={entry} />
  </div>;
}

function CompactItemDetail({ item, data, onSelectItem }) {
  const dependencies = (item.dependsOn ?? []).map(id => itemById(data, id)).filter(Boolean);
  const linked = item.linked ?? {};
  const historicalRecords = (data?.history ?? []).filter(entry => entry.supersededBy === item.id);
  return <div className="detail-body">
    <div className="detail-title-row"><div><p className="eyebrow">Selected work</p><h2>{item.title}</h2><p className="detail-id">{item.referenceCode ? <><span>{item.referenceCode}</span> · </> : null}{item.id}</p></div><ItemChips item={item} /></div>
    <ProgressSummary item={item} />
    <HealthSummary health={item.health} />
    <ApprovalSummary item={item} />
    <ScheduleSummary item={item} />
    <div className="detail-grid">
      <section><h3>Outcome</h3><Markdown value={item.sections?.outcome} /></section>
      <section><h3>Next step</h3><Markdown value={item.sections?.nextStep} /></section>
      <section><h3>Completion condition</h3><Markdown value={item.sections?.completionCondition} /></section>
      <section><h3>Evidence</h3><Markdown value={item.sections?.evidence} /></section>
    </div>
    {item.sections?.blocker ? <section className="detail-block compact-detail-block"><h3>Blocker</h3><Markdown value={item.sections.blocker} /></section> : null}
    <section className="detail-block compact-detail-block"><h3>Dependencies</h3>{dependencies.length ? <ul className="linked-list">{dependencies.map(dependency => <li key={dependency.id}><button className="text-link" type="button" onClick={() => onSelectItem?.(dependency.id)}><ArrowUpRight size={14} aria-hidden="true" />{dependency.title}</button><span>{humanize(dependency.commitment ?? dependency.status)} · {dependency.health?.state === 'unknown' ? 'health unknown' : humanize(dependency.status)}</span></li>)}</ul> : <p className="empty-copy">No dependencies recorded.</p>}</section>
    <CompactDecisionList decisions={linked.decisions} data={data} />
    <CompactUpdates updates={linked.updates} />
    {historicalRecords.length ? <section className="detail-block compact-detail-block"><h3>Retired records</h3><ul className="linked-list">{historicalRecords.map(entry => <li key={entry.id}><button className="text-link" type="button" onClick={() => onSelectItem?.(entry.id)}><History size={14} aria-hidden="true" />{entry.title}</button><span>Historical evidence</span></li>)}</ul></section> : null}
    <DetailSource record={item} />
  </div>;
}

export function CompactDetails({ item, history, data, onSelectItem }) {
  if (history) return <CompactHistoryDetail entry={history} data={data} onSelectItem={onSelectItem} />;
  if (item) return <CompactItemDetail item={item} data={data} onSelectItem={onSelectItem} />;
  return <TrackerEmpty className="detail-not-found-inline" headerClassName="items-start text-left" icon={<ShieldAlert size={23} aria-hidden="true" />} title={<h2>Work item unavailable</h2>} description="No work item or historical record is available in this snapshot." />;
}

/** @param {import('./contracts').ItemDetailSheetProps} props */
export function ItemDetailSheet({ item, history, data, open, onOpenChange, onSelectItem, fullPageLink, onCloseAutoFocus }) {
  const title = history?.title ?? item?.title ?? 'Work item details';
  const contentRef = useRef(null);
  const onOpenAutoFocus = event => {
    event.preventDefault();
    const focusTarget = contentRef.current?.querySelector('.details-sheet-full-page-link') ?? contentRef.current;
    focusTarget?.focus({ preventScroll: true });
  };
  return <Sheet open={Boolean(open)} onOpenChange={onOpenChange}>
    <SheetContent ref={contentRef} className="details-sheet" side="right" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
      <SheetHeader className="details-sheet-sr-header">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{history ? 'Historical evidence and replacement details.' : 'Outcome, current health, next step, and evidence for this work item.'}</SheetDescription>
      </SheetHeader>
      <div className="details-sheet-toolbar"><span>Work item details</span>{fullPageLink ? <span className="details-sheet-open-page">{isValidElement(fullPageLink) ? cloneElement(fullPageLink, { 'aria-label': 'Open full page', className: [fullPageLink.props.className, 'details-sheet-full-page-link'].filter(Boolean).join(' ') }) : fullPageLink}</span> : null}</div>
      <div className="details-sheet-scroll"><CompactDetails item={item} history={history} data={data} onSelectItem={onSelectItem} /></div>
    </SheetContent>
  </Sheet>;
}

function canonicalFieldBaseline(canonicalData, item, field, visibleValue) {
  const canonicalItem = canonicalData?.itemById?.get?.(item.id);
  const sourceCommit = canonicalData?.source?.commit ?? 'unknown';
  return {
    value: canonicalItem ? taskDraftFieldValue(canonicalItem, field) : visibleValue,
    sourceCommit,
    contentRevision: canonicalData?.source?.contentRevision ?? sourceCommit,
  };
}

function ItemPageHeader({ item, data, canonicalData, renderItemLink, returnLink, taskDraft, taskEdit }) {
  const [titleEditing, setTitleEditing] = useState(false);
  return <header className="detail-page-header">
    <div className="detail-page-nav">{returnLink ? <span className="detail-page-return">{returnLink}</span> : null}</div>
    <div className="detail-page-heading">
      <div className="detail-page-title"><p className="eyebrow">Work item</p><h1 aria-label={titleEditing ? 'Editing task title' : (item.title || 'Untitled task')}><EditableTaskTitle
        itemId={item.id}
        value={item.title}
        fieldState={taskDraft?.payload.fields.title ?? null}
        canonicalAtStart={canonicalFieldBaseline(canonicalData, item, 'title', item.title)}
        taskEdit={taskEdit}
        onEditingChange={setTitleEditing}
      /></h1><p className="detail-id">{item.referenceCode ? <><span>{item.referenceCode}</span> · </> : null}{item.id}</p></div>
      <ItemChips item={item} />
    </div>
    <ItemBreadcrumbs item={item} data={data} renderItemLink={renderItemLink} />
  </header>;
}

function DecisionAndReleaseRecords({ item, data }) {
  const decisions = item.linked?.decisions ?? [];
  const releases = item.linked?.releases ?? [];
  return <div className="detail-linked-records">
    <section className="detail-page-section"><div className="detail-section-heading"><h2>Linked decisions</h2><span>{decisions.length}</span></div>{decisions.length ? <ul className="detail-decision-list">{decisions.map(decision => <li key={decision.id}>
      <Link to="/decisions/$decisionId" params={{ decisionId: decision.id }}><span><strong>{decision.title}</strong><small>{decision.id}</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link>
      <div className="detail-decision-meta"><BadgeChip tone={decision.state === 'approved' ? 'green' : 'amber'}>{humanize(decision.state)}</BadgeChip>{decision.ownerName || decision.owner ? <PersonMeta data={data} value={decision.owner} name={decision.ownerName} /> : <span>Owner unknown</span>}<time>{formatDate(decision.updatedAt)}</time></div>
    </li>)}</ul> : <p className="empty-copy">No linked decisions recorded.</p>}</section>
    <section className="detail-page-section"><div className="detail-section-heading"><h2>Linked releases</h2><span>{releases.length}</span></div>{releases.length ? <ul className="detail-release-list">{releases.map(release => <li key={release.id}>
      <div><strong>{release.title || release.id}</strong><small>{release.id}</small></div>
      <p>{release.status ? `Status · ${humanize(release.status)}` : 'Status not recorded'}{release.target ? ` · Target ${formatDate(release.target)}` : ''}{release.ownerName || release.owner ? <> · Owner <PersonMeta data={data} value={release.owner} name={release.ownerName} /></> : ''}</p>
      <p className="detail-record-source">Source <code>{release.sourcePath || release.path || 'Unknown'}</code></p>
    </li>)}</ul> : <p className="empty-copy">No linked releases recorded.</p>}</section>
  </div>;
}

function UpdateSections({ update, data }) {
  const sections = Object.entries(update.sections ?? {}).filter(([, value]) => String(value ?? '').trim());
  if (!sections.length) return <p className="empty-copy">No update body was captured.</p>;
  return <div className="detail-update-sections">{sections.map(([name, value]) => <section key={name}>
    <h3>{humanize(name)}</h3>
    <Markdown value={value} className="detail-record-markdown" resolveLink={href => resolveMarkdownLink(href, data)} />
  </section>)}</div>;
}

function FullUpdates({ updates, data }) {
  const sorted = orderedUpdates(updates);
  return <section className="detail-page-section detail-updates" aria-label="Recent updates">
    <div className="detail-section-heading"><h2>Updates</h2><span>{sorted.length}</span></div>
    {sorted.length ? <ol className="detail-update-list">{sorted.map(update => <li key={update.id} data-update-id={update.id}>
      <div className="detail-update-header"><div><h3>{update.title || update.id}</h3><p>{update.source || 'Source not recorded'} · <code>{update.id}</code></p></div><time dateTime={update.observedAt || undefined}>{formatTimestamp(update.observedAt)}</time></div>
      <UpdateSections update={update} data={data} />
      <p className="detail-record-source">Source <code>{update.sourcePath || update.path || 'Unknown'}</code></p>
    </li>)}</ol> : <p className="empty-copy">No updates recorded.</p>}
  </section>;
}

function ItemPageRelated({ item, data, renderItemLink }) {
  const children = (item.childIds ?? []).map(id => itemById(data, id)).filter(Boolean);
  const dependencies = item.dependsOn ?? [];
  const retired = (data?.history ?? []).filter(entry => entry.supersededBy === item.id);
  return <div className="detail-page-related">
    <section className="detail-page-section" aria-label="Child work">
      <div className="detail-section-heading"><h2>Child work</h2><span>{children.length}</span></div>
      {children.length ? <ul className="detail-child-list">{children.map(child => <li key={child.id}>
        <ItemLink id={child.id} label={child.title} data={data} renderItemLink={renderItemLink} />
        <span>{humanize(child.type)} · {humanize(child.status)} · {humanize(child.commitment)}</span>
        <BadgeChip tone={statusTone(child.status)}>{humanize(child.status)}</BadgeChip>
      </li>)}</ul> : <p className="empty-copy">No direct child work recorded.</p>}
    </section>
    <RelationList title="Dependencies" ids={dependencies} data={data} renderItemLink={renderItemLink} empty="No dependencies recorded." />
    <DecisionAndReleaseRecords item={item} data={data} />
    <FullUpdates updates={item.linked?.updates ?? []} data={data} />
    <section className="detail-page-section">
      <div className="detail-section-heading"><h2>Retired records</h2><span>{retired.length}</span></div>
      {retired.length ? <ul className="detail-child-list">{retired.map(entry => <li key={entry.id}>
        <ItemLink id={entry.id} label={entry.title} data={data} renderItemLink={renderItemLink} />
        <span>{entry.id} · Historical evidence</span>
        <BadgeChip tone="slate">Retired</BadgeChip>
      </li>)}</ul> : <p className="empty-copy">No retired records point to this item.</p>}
    </section>
  </div>;
}

function ItemPageBody({ item, data, canonicalData, renderItemLink, returnLink, taskDraft, taskEdit }) {
  const fields = taskDraft?.payload.fields;
  return <article className="item-detail-page">
    <ItemPageHeader
      item={item}
      data={data}
      canonicalData={canonicalData}
      renderItemLink={renderItemLink}
      returnLink={returnLink}
      taskDraft={taskDraft}
      taskEdit={taskEdit}
    />
    <div className="detail-page-content">
      <div className="detail-page-layout">
        <div className="detail-page-primary">
          <EditableTaskSection itemId={item.id} field="sections.outcome" title="Outcome" value={item.sections?.outcome ?? ''} fieldState={fields?.['sections.outcome'] ?? null} canonicalAtStart={canonicalFieldBaseline(canonicalData, item, 'sections.outcome', item.sections?.outcome ?? '')} data={data} taskEdit={taskEdit} />
          <EditableTaskSection itemId={item.id} field="sections.nextStep" title="Next step" value={item.sections?.nextStep ?? ''} fieldState={fields?.['sections.nextStep'] ?? null} canonicalAtStart={canonicalFieldBaseline(canonicalData, item, 'sections.nextStep', item.sections?.nextStep ?? '')} data={data} taskEdit={taskEdit} />
          <EditableTaskSection itemId={item.id} field="sections.completionCondition" title="Completion condition" value={item.sections?.completionCondition ?? ''} fieldState={fields?.['sections.completionCondition'] ?? null} canonicalAtStart={canonicalFieldBaseline(canonicalData, item, 'sections.completionCondition', item.sections?.completionCondition ?? '')} data={data} taskEdit={taskEdit} />
          <EditableTaskSection itemId={item.id} field="sections.evidence" title="Evidence" value={item.sections?.evidence ?? ''} fieldState={fields?.['sections.evidence'] ?? null} canonicalAtStart={canonicalFieldBaseline(canonicalData, item, 'sections.evidence', item.sections?.evidence ?? '')} data={data} taskEdit={taskEdit} />
          {item.sections?.blocker ? <MarkdownSection title="Blocker" value={item.sections.blocker} data={data} /> : null}
        </div>
        <aside className="detail-page-sidebar" aria-label="Work status and planning">
          <ProgressSummary item={item} />
          <HealthSummary health={item.health} />
          <ScheduleSummary item={item} />
          <ApprovalSummary item={item} />
        </aside>
      </div>
      <ItemPageRelated item={item} data={data} renderItemLink={renderItemLink} />
      <DetailSource record={item} />
    </div>
  </article>;
}

function FullHistoryPage({ entry, data, renderItemLink, returnLink }) {
  const replacement = entry.supersededBy ? itemById(data, entry.supersededBy) : null;
  return <article className="item-detail-page historical-item-page">
    <header className="detail-page-header">
      <div className="detail-page-nav">{returnLink ? <span className="detail-page-return">{returnLink}</span> : null}</div>
      <div className="detail-page-heading">
        <div className="detail-page-title"><p className="eyebrow">Historical record</p><h1>{entry.title}</h1><p className="detail-id">{entry.id}</p></div>
        <BadgeChip tone="slate">History</BadgeChip>
      </div>
      <section className="detail-history-replacement"><h2>Replacement</h2>{entry.supersededBy ? replacement ? <ItemLink id={replacement.id} label={replacement.title} data={data} renderItemLink={renderItemLink} /> : <span className="source-note">Replacement {entry.supersededBy} is not present in this snapshot.</span> : <p className="empty-copy">No replacement is recorded.</p>}</section>
    </header>
    <div className="detail-page-content history-page-content">
      <div className="detail-page-layout history-page-layout">
        <div className="detail-page-primary">
          <MarkdownSection title="Outcome" value={entry.sections?.outcome} data={data} />
          <MarkdownSection title="Evidence" value={entry.evidence ?? entry.sections?.evidence} data={data} />
        </div>
        <aside className="detail-page-sidebar" aria-label="Historical record metadata">
          <section className="detail-page-section"><h2>Record details</h2><p>Updated {formatDate(entry.updatedAt)}.</p><p>Source <code>{entry.sourcePath || 'Unknown'}</code></p><p>Status · {humanize(entry.status)}</p></section>
          {entry.sections?.completionCondition ? <MarkdownSection title="Completion condition" value={entry.sections.completionCondition} data={data} /> : null}
        </aside>
      </div>
    </div>
  </article>;
}

/** @param {import('./contracts').ItemPageProps} props */
export function ItemPage({ item, history, data, canonicalData, taskDraft, taskEdit, renderItemLink, returnLink }) {
  if (history) return <FullHistoryPage entry={history} data={data} renderItemLink={renderItemLink} returnLink={returnLink} />;
  if (!item) return <DetailNotFound />;
  return <ItemPageBody key={item.id} item={item} data={data} canonicalData={canonicalData} renderItemLink={renderItemLink} returnLink={returnLink} taskDraft={taskDraft} taskEdit={taskEdit} />;
}

function DecisionMetaRow({ label, value, name, code = false, data, person = false, avatar = false, pill = false }) {
  if (!value && !name) return null;
  const renderedValue = person
    ? <PersonMeta data={data} value={value} name={name} avatar={avatar} pill={pill} className="decision-meta-person" />
    : value;
  return <div className="decision-meta-row"><dt>{label}</dt><dd className={code ? 'decision-meta-code' : ''}>{renderedValue}</dd></div>;
}

function DecisionPageBody({ decision, data }) {
  const affectedItems = (decision.affects ?? []).map(id => itemById(data, id)).filter(Boolean);
  const missingAffectedIds = (decision.affects ?? []).filter(id => !itemById(data, id));
  const replacement = decision.supersededBy ? (data?.decisions ?? []).find(candidate => candidate.id === decision.supersededBy) : null;
  return <div className="decision-page-shell">
    <header className="decision-page-header">
      <Link className="decision-back-link" to="/"><ArrowLeft size={16} aria-hidden="true" />Back to tracker</Link>
      <div className="decision-page-heading"><div><p className="eyebrow">Decision record</p><h1>{decision.title}</h1><p className="decision-page-id">{decision.id}</p></div><BadgeChip tone={statusTone(decision.state)}>{humanize(decision.state)}</BadgeChip></div>
    </header>
    <section className="decision-page-content">
      <div className="decision-page-layout">
        <article className="decision-record-card surface-card"><Markdown value={decision.body} className="decision-markdown" resolveLink={href => resolveMarkdownLink(href, data)} /></article>
        <aside className="decision-page-sidebar">
          <section className="decision-meta-card surface-card" aria-labelledby="decision-meta-heading"><h2 id="decision-meta-heading">Record metadata</h2><dl><DecisionMetaRow label="Owner" value={decision.owner} name={decision.ownerName} data={data} person avatar pill /><DecisionMetaRow label="Updated" value={formatDate(decision.updatedAt)} /><DecisionMetaRow label="Approved by" value={decision.approvedBy} data={data} person avatar pill /><DecisionMetaRow label="Approved" value={formatDate(decision.approvedAt)} /><DecisionMetaRow label="Approval time" value={formatTimestamp(decision.approvalTimeUtc)} /><DecisionMetaRow label="Approval source" value={decision.approvalSource} /><DecisionMetaRow label="Approval reference" value={decision.approvalRef} code /><DecisionMetaRow label="Source" value={decision.sourcePath} code /></dl></section>
          <section className="decision-meta-card surface-card" aria-labelledby="decision-affects-heading"><div className="decision-sidebar-heading"><h2 id="decision-affects-heading">Affected work</h2><span>{affectedItems.length}</span></div>{affectedItems.length ? <ul className="decision-work-list">{affectedItems.map(item => <li key={item.id}><Link className="decision-work-link" to="/work/$itemId" params={{ itemId: item.id }}><span><strong>{item.title}</strong><small>{item.id}</small></span><ArrowUpRight size={15} aria-hidden="true" /></Link></li>)}</ul> : <p className="empty-copy">No affected work is recorded.</p>}{missingAffectedIds.length ? <p className="source-note">{missingAffectedIds.length} linked ID{missingAffectedIds.length === 1 ? '' : 's'} is outside this snapshot.</p> : null}</section>
          {replacement ? <section className="decision-meta-card surface-card"><h2>Replacement</h2><Link className="decision-replacement-link" to="/decisions/$decisionId" params={{ decisionId: replacement.id }}><span>{replacement.title}</span><ArrowUpRight size={15} aria-hidden="true" /></Link></section> : null}
        </aside>
      </div>
    </section>
  </div>;
}

/** @param {import('./contracts').DecisionPageProps} props */
export function DecisionPage({ decision, data }) {
  if (!decision) return <DecisionNotFound />;
  return <DecisionPageBody decision={decision} data={data} />;
}

export function DecisionNotFound({ id }) {
  return <DetailNotFound id={id} kind="decision" />;
}

export function ItemNotFound({ id }) {
  return <DetailNotFound id={id} />;
}
