import { useState, type FormEvent } from 'react';
import { FilePenLine, Plus, ShieldCheck } from 'lucide-react';
import { patch, post } from './api';
import { Badge, Modal } from './components';
import { useResource } from './workflow-ui';
import { rfaDisplayTime } from '../server/rfa-engine';
import type {
  AddendumSource,
  NoteAddendum,
  SignedNoteCorrection,
} from '../server/note-addenda';

type AddendaView = {
  encounter_id: string;
  note_status: string;
  original_signed_at: string | null;
  author_name: string;
  can_edit: boolean;
  addenda: NoteAddendum[];
  corrections: SignedNoteCorrection[];
  sources: AddendumSource[];
};
const empty: AddendaView = {
  encounter_id: '',
  note_status: '',
  original_signed_at: null,
  author_name: '',
  can_edit: false,
  addenda: [],
  corrections: [],
  sources: [],
};
const base = '/workflow/note-addenda';

export function NoteAddenda({
  encounterId,
  onChanged,
}: {
  encounterId: string;
  onChanged?: () => Promise<unknown> | void;
}) {
  const resource = useResource<AddendaView>(
    `${base}?encounter_id=${encodeURIComponent(encounterId)}`,
    empty,
  );
  const [editing, setEditing] = useState<NoteAddendum | 'new' | null>(null);
  const [reviewing, setReviewing] = useState<NoteAddendum | null>(null);
  const [initialCorrection, setInitialCorrection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const view = resource.data;
  const pending = view.corrections.filter((c) => c.status === 'Needs addendum');
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await resource.reload();
      await onChanged?.();
      setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function create(correction = '') {
    setError('');
    setInitialCorrection(correction);
    setEditing('new');
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const content = {
        reason: f.get('reason'),
        text: f.get('text'),
        correction_ids: f.getAll('correction_ids'),
        affected_result_ids: f.getAll('affected_result_ids'),
      };
      if (editing && editing !== 'new')
        await patch(`${base}/${editing.id}`, {
          ...content,
          revision: editing.revision,
        });
      else await post(base, { ...content, encounter_id: encounterId });
      setEditing(null);
    }, 'Draft addendum saved. Review and sign it when ready.');
  }
  async function sign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reviewing) return;
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await post(`${base}/${reviewing.id}/sign`, {
        revision: reviewing.revision,
        signed_name: f.get('signed_name'),
        attested: f.get('attested') === 'on',
      });
      setReviewing(null);
    }, 'Addendum signed and appended to the original note.');
  }
  const draft = editing && editing !== 'new' ? editing : undefined;
  return (
    <section
      className="ops-subsection"
      aria-label="Note addenda and source corrections"
    >
      <div className="section-heading">
        <div>
          <h4>Addenda and source corrections</h4>
          <p className="muted">
            Add a dated clarification while retaining the original signed note.
          </p>
        </div>
        {view.can_edit && (
          <button className="button secondary small" onClick={() => create()}>
            <Plus size={14} />
            Add addendum
          </button>
        )}
      </div>
      {resource.loading && <p className="muted">Loading addenda…</p>}
      {(resource.error || error) && (
        <p className="form-error" role="alert">
          {error || resource.error}
        </p>
      )}
      {message && (
        <p className="inline-success" role="status">
          {message}
        </p>
      )}
      {pending.map((c) => (
        <div className="finance-notice" key={c.id}>
          <strong>Signed source needs clinical review</strong>
          <p>{c.reason}</p>
          <p className="muted">
            {c.source.source_kind} · {c.source.source_sender} · Received{' '}
            {rfaDisplayTime(c.source.received_at)}
          </p>
          {view.can_edit && (
            <button
              className="button secondary small"
              onClick={() => create(c.id)}
            >
              <FilePenLine size={14} />
              Document correction
            </button>
          )}
        </div>
      ))}
      {!resource.loading && !view.addenda.length && !pending.length && (
        <p className="muted">
          {view.note_status === 'Draft'
            ? 'Addenda become available after the original note is signed.'
            : 'No addenda or unresolved source corrections.'}
        </p>
      )}
      {!view.can_edit && view.note_status === 'Signed' && (
        <p className="muted">
          The original note author, {view.author_name}, can create and sign
          addenda.
        </p>
      )}
      <div className="workflow-stack">
        {view.addenda.map((a) => {
          const content = a.signed_snapshot || a;
          return (
            <article className="finance-card" key={a.id}>
              <div className="section-heading">
                <strong>{content.reason}</strong>
                <Badge>{a.status}</Badge>
              </div>
              <p style={{ whiteSpace: 'pre-wrap' }}>{content.text}</p>
              <p className="muted">
                {a.signed_name || a.author_name} ·{' '}
                {a.status === 'Signed'
                  ? `Signed ${rfaDisplayTime(a.signed_at!)}`
                  : `Updated ${rfaDisplayTime(a.updated_at)}`}{' '}
                · Revision {a.revision}
              </p>
              {content.correction_ids.length > 0 && (
                <p className="muted">
                  Addresses {content.correction_ids.length} source correction
                  {content.correction_ids.length === 1 ? '' : 's'}
                  {a.status === 'Draft' ? ' after signing' : ''}.
                </p>
              )}
              {a.signed_snapshot?.sources.map((s) => (
                <p className="muted" key={s.note_result_id}>
                  Referenced source: {s.source_kind} · {s.source_sender} ·
                  Received {rfaDisplayTime(s.received_at)}
                </p>
              ))}
              {a.status === 'Draft' && view.can_edit && (
                <div className="table-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setError('');
                      setEditing(a);
                    }}
                  >
                    Edit draft
                  </button>
                  <button
                    className="button secondary small"
                    onClick={() => {
                      setError('');
                      setReviewing(a);
                    }}
                  >
                    <ShieldCheck size={14} />
                    Review and sign
                  </button>
                </div>
              )}
              <details>
                <summary>Revision history</summary>
                {a.history.map((h) => (
                  <div key={h.revision}>
                    <strong>
                      {h.action} · Revision {h.revision} ·{' '}
                      {rfaDisplayTime(h.at)}
                    </strong>
                    <p>{h.reason}</p>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{h.text}</p>
                  </div>
                ))}
              </details>
            </article>
          );
        })}
      </div>
      {editing && (
        <Modal
          title={draft ? 'Edit draft addendum' : 'Add note addendum'}
          subtitle="The signed original remains unchanged."
          onClose={() => !busy && setEditing(null)}
          wide
        >
          <form onSubmit={save}>
            <div className="modal-body form-grid">
              {error && (
                <p className="form-error span-2" role="alert">
                  {error}
                </p>
              )}
              <label className="span-2">
                Reason for addendum
                <input
                  name="reason"
                  defaultValue={
                    draft?.reason ||
                    (initialCorrection
                      ? 'Review source document correction'
                      : '')
                  }
                  required
                  minLength={5}
                  maxLength={1000}
                />
              </label>
              <label className="span-2">
                Clarification and clinical impact
                <textarea
                  name="text"
                  defaultValue={draft?.text || ''}
                  required
                  minLength={10}
                  maxLength={30000}
                  rows={7}
                  placeholder="Explain the clarification, whether prior findings remain relevant, and any changes to the assessment or plan."
                />
              </label>
              {pending.length > 0 && (
                <fieldset className="span-2">
                  <legend>Source corrections addressed by this addendum</legend>
                  {pending.map((c) => (
                    <label className="checkbox-label" key={c.id}>
                      <input
                        type="checkbox"
                        name="correction_ids"
                        value={c.id}
                        defaultChecked={
                          draft?.correction_ids.includes(c.id) ||
                          c.id === initialCorrection
                        }
                      />
                      {c.source.source_kind} · {c.source.source_sender} ·
                      Flagged {rfaDisplayTime(c.created_at)}
                    </label>
                  ))}
                </fieldset>
              )}
              {view.sources.length > 0 && (
                <fieldset className="span-2">
                  <legend>Other received results referenced (optional)</legend>
                  {view.sources.map((s) => (
                    <label className="checkbox-label" key={s.note_result_id}>
                      <input
                        type="checkbox"
                        name="affected_result_ids"
                        value={s.note_result_id}
                        defaultChecked={draft?.affected_result_ids.includes(
                          s.note_result_id,
                        )}
                      />
                      {s.source_kind} · {s.source_sender} · Received{' '}
                      {rfaDisplayTime(s.received_at)}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save draft addendum'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {reviewing && (
        <Modal
          title="Review and sign addendum"
          onClose={() => !busy && setReviewing(null)}
          wide
        >
          <form onSubmit={sign}>
            <div className="modal-body form-grid">
              {error && (
                <p className="form-error span-2" role="alert">
                  {error}
                </p>
              )}
              <div className="finance-notice span-2">
                <strong>{reviewing.reason}</strong>
                <p style={{ whiteSpace: 'pre-wrap' }}>{reviewing.text}</p>
                <p>
                  Original note signed{' '}
                  {rfaDisplayTime(view.original_signed_at!)}. This addendum will
                  be appended with its own signature and date.
                </p>
                <p>
                  {reviewing.correction_ids.length} source correction
                  {reviewing.correction_ids.length === 1 ? '' : 's'} will be
                  marked addressed after signing.
                </p>
                {view.sources
                  .filter((s) =>
                    reviewing.affected_result_ids.includes(s.note_result_id),
                  )
                  .map((s) => (
                    <p key={s.note_result_id}>
                      Referenced signed source: {s.source_kind} ·{' '}
                      {s.source_sender} · Received{' '}
                      {rfaDisplayTime(s.received_at)}
                    </p>
                  ))}
              </div>
              <label className="checkbox-label span-2">
                <input type="checkbox" name="attested" required />I reviewed
                this addendum and its referenced sources and attest that the
                clarification is accurate.
              </label>
              <label className="span-2">
                Type your full account name: {view.author_name}
                <input
                  name="signed_name"
                  autoComplete="off"
                  required
                  maxLength={200}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setReviewing(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                <ShieldCheck size={16} />
                {busy ? 'Signing…' : 'Sign addendum'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
