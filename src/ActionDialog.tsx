import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export function useAction(onDone: () => void) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<unknown>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try { await action(); onDone(); }
    catch (cause) {
      if (!(cause instanceof ApiError) || cause.status === 503) setUncertain(true);
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar el cambio.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { run, busy, uncertain, error };
}

type Props = {
  title: string; busy: boolean; uncertain: boolean; error: string; submitLabel: string;
  onClose: () => void; onSubmit: () => void; children: ReactNode; disabled?: boolean;
};

export function ActionDialog({ title, busy, uncertain, error, submitLabel, onClose, onSubmit, children, disabled }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={ref} className="action-dialog" aria-labelledby="action-title" onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <h2 id="action-title">{title}</h2>
      <fieldset disabled={busy || uncertain}>{children}</fieldset>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>{uncertain ? 'Cerrar' : 'Cancelar'}</button>
        <button className="primary-btn" disabled={busy || disabled} type="submit">
          {busy ? 'Guardando…' : uncertain ? 'Comprobar de nuevo' : submitLabel}
        </button>
      </div>
    </form>
  </dialog>;
}
