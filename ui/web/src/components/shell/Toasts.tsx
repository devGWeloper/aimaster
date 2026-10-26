import { useEffect } from 'react';
import { dismissToast, useApp } from '@/store/store';
import { cn } from '@/lib/utils';

export default function Toasts() {
  const toasts = useApp((s) => s.toasts);
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => dismissToast(toasts[0].id), 6500);
    return () => clearTimeout(t);
  }, [toasts]);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[360px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cn('flash-in pointer-events-auto rounded-lg border border-line bg-popover px-3.5 py-2.5 text-[12.5px] shadow-xl',
          t.level === 'error' && 'border-bad/60', t.level === 'warn' && 'border-warn/60', t.level === 'ver' && 'border-l3/60', t.level === 'ok' && 'border-ok/50')} onClick={() => dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
