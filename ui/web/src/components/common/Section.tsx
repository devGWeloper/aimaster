import { cn } from '@/lib/utils';

export function Section({ title, children, className }: { title: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-1.5', className)}>
      <div className="text-[11.5px] font-semibold text-ink-3">{title}</div>
      {children}
    </section>
  );
}
export function Line({ children, cls }: { children: React.ReactNode; cls?: string }) {
  const c = cls === 'ok' ? 'text-ok' : cls === 'bad' ? 'text-[#ffd6d4]' : cls === 'warn' ? 'text-[#ffe9c6]' : cls === 'muted' ? 'text-ink-3' : cls === 'l2' ? 'text-l2' : 'text-ink-2';
  return <div className={cn('text-[12.5px] leading-relaxed', c)}>{children}</div>;
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-ink-3">{children}</div>;
}
