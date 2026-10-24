import { useRef, useState, type FormEvent } from 'react';
import { Archive, Copy, FileText, Plus } from 'lucide-react';
import { patch, post } from './api';
import { Badge } from './components';
import { useResource } from './workflow-ui';
import type { User } from './types';

type Visibility = 'personal' | 'practice';
type LibraryItem = {
  id: string;
  owner_id?: string;
  visibility: Visibility;
  revision: number;
  archived: boolean;
  can_edit: boolean;
  name?: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  shortcut?: string;
  text?: string;
};
type Draft = {
  name: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  shortcut: string;
  text: string;
  visibility: Visibility;
};
const soapSections = ['subjective', 'objective', 'assessment', 'plan'] as const;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);
const blankDraft = (): Draft => ({
  name: '', subjective: '', objective: '', assessment: '', plan: '',
  shortcut: '', text: '', visibility: 'personal',
});
const itemDraft = (item: LibraryItem): Draft => ({
  ...blankDraft(), ...item,
  visibility: item.visibility || 'practice',
});

export function TemplateSettings({ user }: { user: User }) {
  const [kind, setKind] = useState<'templates' | 'phrases'>('templates');
  if (user.role !== 'clinician')
    return <p className="muted">Clinical access is required to manage note templates.</p>;
  return (
    <div className="workflow-stack template-settings">
      <section className="panel account-panel">
        <h2><FileText size={20} /> Your documentation library</h2>
        <p className="muted">
          Build reusable SOAP templates and smart phrases for future notes. Keep
          them personal or share them with providers in this practice. Use generic
          prompts such as {'[[patient-reported symptoms]]'} and leave patient
          identifiers out of reusable text.
        </p>
        <div className="tabs" role="tablist" aria-label="Documentation library">
          <button type="button" role="tab" aria-selected={kind === 'templates'}
            className={kind === 'templates' ? 'active' : ''}
            onClick={() => setKind('templates')}>SOAP templates</button>
          <button type="button" role="tab" aria-selected={kind === 'phrases'}
            className={kind === 'phrases' ? 'active' : ''}
            onClick={() => setKind('phrases')}>Smart phrases</button>
        </div>
      </section>
      <div role="tabpanel" aria-label="SOAP templates" hidden={kind !== 'templates'}>
        <TemplateLibrary kind="templates" />
      </div>
      <div role="tabpanel" aria-label="Smart phrases" hidden={kind !== 'phrases'}>
        <TemplateLibrary kind="phrases" />
      </div>
    </div>
  );
}

function TemplateLibrary({ kind }: { kind: 'templates' | 'phrases' }) {
  const isTemplate = kind === 'templates';
  const resource = useResource<LibraryItem[]>(
    `/workflow/${kind}?include_archived=true`, [],
  );
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [savedDraft, setSavedDraft] = useState<Draft>(blankDraft);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const readOnly = Boolean(selected && (!selected.can_edit || selected.archived));
  const noun = isTemplate ? 'template' : 'phrase';
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);

  function replaceDraft(item: LibraryItem | null, duplicate = false) {
    if (dirty && !window.confirm('Discard the unsaved library changes?')) return;
    const next = item ? itemDraft(item) : blankDraft();
    if (duplicate) {
      next.visibility = 'personal';
      if (isTemplate) next.name = `${next.name} (copy)`.slice(0, 200);
      else next.shortcut = '';
    }
    setSelected(duplicate ? null : item);
    setDraft(next);
    setSavedDraft(next);
    setError('');
    setSuccess('');
  }
  function remember(item: LibraryItem) {
    resource.setData((items) => {
      const exists = items.some((saved) => saved.id === item.id);
      return exists ? items.map((saved) => saved.id === item.id ? item : saved)
        : [...items, item];
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.current || readOnly) return;
    mutation.current = true;
    setBusy(true); setError(''); setSuccess('');
    const existing = selected;
    const values = isTemplate
      ? { name: draft.name, subjective: draft.subjective,
          objective: draft.objective, assessment: draft.assessment,
          plan: draft.plan, visibility: draft.visibility }
      : { shortcut: draft.shortcut, text: draft.text, visibility: draft.visibility };
    try {
      const item = existing
        ? await patch<LibraryItem>(`/workflow/${kind}/${existing.id}`,
            { ...values, revision: existing.revision || 1 })
        : await post<LibraryItem>(`/workflow/${kind}`, values);
      // Retain the returned identifier immediately: retrying a failed list
      // refresh must never create a second template.
      remember(item);
      setSelected(item);
      const next = itemDraft(item);
      setDraft(next); setSavedDraft(next);
      setSuccess(isTemplate
        ? existing ? 'Template changes saved' : 'Template saved'
        : existing ? 'Phrase changes saved' : 'Smart phrase saved');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      mutation.current = false; setBusy(false);
    }
  }
  async function archive(item: LibraryItem) {
    if (mutation.current || !item.can_edit) return;
    if (selected?.id === item.id && dirty &&
        !window.confirm('Discard unsaved changes and update the saved library item?')) return;
    mutation.current = true;
    setBusy(true); setError(''); setSuccess('');
    try {
      const saved = await patch<LibraryItem>(`/workflow/${kind}/${item.id}`, {
        revision: item.revision || 1, archived: !item.archived,
      });
      remember(saved);
      if (selected?.id === saved.id) {
        setSelected(saved);
        const next = itemDraft(saved);
        setDraft(next); setSavedDraft(next);
      }
      setSuccess(`${title(noun)} ${saved.archived ? 'archived' : 'restored'}`);
    } catch (cause) { setError((cause as Error).message); }
    finally { mutation.current = false; setBusy(false); }
  }
  function workersCompDraft() {
    if (dirty && !window.confirm('Discard the unsaved library changes?')) return;
    const next: Draft = {
      ...blankDraft(), name: 'Workers compensation follow-up',
      subjective: 'Claim number: [[confirm claim number]]\nAccepted body parts: [[confirm accepted body parts]]\nPatient report: [[symptoms, function, and interval change]]',
      objective: '[[Document findings actually obtained for the accepted body parts]]',
      assessment: '[[Assessment and relationship to the accepted work injury]]',
      plan: '[[Treatment requested, medical rationale, work status, and follow-up]]',
    };
    setSelected(null); setDraft(next); setSavedDraft(blankDraft());
    setError(''); setSuccess('');
  }
  const visible = resource.data.filter((item) => showArchived || !item.archived);
  return (
    <div className="template-library-grid">
      <section className="panel account-panel template-library-list">
        <div className="section-heading">
          <h2>Saved {isTemplate ? 'templates' : 'smart phrases'}</h2>
          <button type="button" className="button secondary small" disabled={busy}
            onClick={() => replaceDraft(null)}><Plus size={14} /> New {noun}</button>
        </div>
        <label className="account-check">
          <input type="checkbox" checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)} />
          Show archived {isTemplate ? 'templates' : 'phrases'}
        </label>
        {resource.loading && <p role="status">Loading library…</p>}
        {resource.error && <p className="form-error" role="alert">{resource.error}</p>}
        <button type="button" className="text-button" disabled={busy || resource.loading}
          onClick={() => void resource.reload().catch(() => {})}>Reload library</button>
        {!resource.loading && !visible.length &&
          <p className="muted">No saved {isTemplate ? 'templates' : 'phrases'} in this view. Create your first one.</p>}
        {visible.map((item) => (
          <article className={`template-library-item ${selected?.id === item.id ? 'selected' : ''}`}
            key={item.id} aria-label={`${title(noun)}: ${isTemplate ? item.name : item.shortcut}`}>
            <strong>{isTemplate ? item.name : item.shortcut}</strong>
            <div className="button-row">
              <Badge>{item.visibility === 'personal' ? 'Personal' : 'Practice shared'}</Badge>
              {item.archived && <Badge>Archived</Badge>}
            </div>
            {!isTemplate && <p className="template-phrase-excerpt">{item.text}</p>}
            <div className="button-row">
              <button type="button" className="text-button" disabled={busy}
                onClick={() => replaceDraft(item)}>
                {item.can_edit && !item.archived ? 'Edit' : 'View'} {noun}</button>
              <button type="button" className="text-button" disabled={busy}
                onClick={() => replaceDraft(item, true)}><Copy size={13} /> Duplicate {noun}</button>
              {item.can_edit && <button type="button" className="text-button" disabled={busy}
                onClick={() => void archive(item)}><Archive size={13} />
                {item.archived ? 'Restore' : 'Archive'} {noun}</button>}
            </div>
          </article>
        ))}
      </section>
      <section className="panel account-panel template-library-editor">
        <h2>{selected ? readOnly ? `View ${noun}` : `Edit ${noun}` : `Create ${isTemplate ? 'SOAP template' : 'smart phrase'}`}</h2>
        <p className="muted">
          Personal items are visible only to you. Practice items are available to
          clinical staff here. Changing or archiving a library item leaves existing
          notes unchanged.
        </p>
        {error && <p className="form-error" role="alert">{error} Reload the library to check for a newer saved version; your draft is retained.</p>}
        {success && <p className="inline-success" role="status">{success}</p>}
        {selected?.archived && <p className="form-hint">Restore this item before editing or using it in a new note.</p>}
        {selected && !selected.can_edit && <p className="form-hint">Duplicate this item to customize your own copy.</p>}
        <form className="account-form" onSubmit={save}>
          <fieldset disabled={busy || readOnly} className="account-form">
            {isTemplate ? <>
              <label>Template name
                <input required maxLength={200} value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label>Template visibility
                <select value={draft.visibility}
                  onChange={(event) => setDraft({ ...draft, visibility: event.target.value as Visibility })}>
                  <option value="personal">Personal — only me</option>
                  <option value="practice">Practice — clinical team</option>
                </select>
              </label>
              {soapSections.map((field) => <label key={field}>{title(field)}
                <textarea rows={4} maxLength={10000} value={draft[field]}
                  placeholder={`[[${title(field)} details to review for this visit]]`}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
              </label>)}
            </> : <>
              <label>Phrase shortcut
                <input required maxLength={32} pattern={String.raw`\.[a-z][a-z0-9_\-]{1,30}`}
                  placeholder=".myphrase" value={draft.shortcut}
                  onChange={(event) => setDraft({ ...draft, shortcut: event.target.value })} />
              </label>
              <p className="form-hint">Start with a period and a lowercase letter, followed by 1–30 lowercase letters, numbers, underscores, or hyphens.</p>
              <label>Phrase text
                <textarea required rows={6} maxLength={3000} value={draft.text}
                  placeholder="Reusable text with [[details to review]]"
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
              </label>
              <label>Phrase visibility
                <select value={draft.visibility}
                  onChange={(event) => setDraft({ ...draft, visibility: event.target.value as Visibility })}>
                  <option value="personal">Personal — only me</option>
                  <option value="practice">Practice — clinical team</option>
                </select>
              </label>
            </>}
            {!readOnly && <div className="button-row">
              <button className="button primary" disabled={busy}>
                {busy ? 'Saving…' : isTemplate
                  ? selected ? 'Save template changes' : 'Save template'
                  : selected ? 'Save phrase changes' : 'Save smart phrase'}
              </button>
            </div>}
          </fieldset>
        </form>
        {isTemplate && <>
          {!selected && <button type="button" className="text-button" disabled={busy}
            onClick={workersCompDraft}>Start workers compensation template</button>}
          <p className="form-hint">
            Workers compensation prompts support the narrative. Complete the
            visit’s structured claim and accepted-body-part documentation as well.
            Resolve every {'[[prompt]]'} and review the inserted text before signing.
          </p>
          <details className="template-preview">
            <summary>Preview SOAP template</summary>
            {soapSections.map((field) => <div key={field}>
              <h3>{title(field)}</h3>
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {draft[field] || 'No reusable text entered.'}
              </p>
            </div>)}
          </details>
        </>}
      </section>
    </div>
  );
}
