import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ open, onClose, title, children, drawer = false, busy = false }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; drawer?: boolean; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); opener?.focus(); };
  }, [open]);
  return <dialog ref={dialog} className={drawer ? 'drawer' : 'confirm-dialog'} aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal-content">
      <div className="modal-heading"><h2>{title}</h2><button type="button" aria-label={`Закрыть: ${title}`} title="Закрыть" disabled={busy} onClick={onClose}>×</button></div>
      {children}
    </div>
  </dialog>;
}
