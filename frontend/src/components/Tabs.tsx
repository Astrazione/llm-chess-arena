import { useId } from 'react';

export function Tabs<T extends string>({ label, items, value, onChange, prefix }: {
  label: string; items: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void; prefix: string;
}) {
  const id = useId();
  return <div className="tabs" role="tablist" aria-label={label} id={id}>
    {items.map((item, index) => <button type="button" key={item.id} role="tab" id={`${prefix}-tab-${item.id}`}
      aria-controls={`${prefix}-panel-${item.id}`} aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1}
      onClick={() => onChange(item.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); onChange(items[next]!.id);
        document.getElementById(`${prefix}-tab-${items[next]!.id}`)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
