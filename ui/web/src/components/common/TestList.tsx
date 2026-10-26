// 테스트 결과 목록 — 루프 밖 평가 하네스가 채점
import { cn } from '@/lib/utils';

export default function TestList({ cases, n, fails, lane }: { cases: { ok: boolean | null; label: string; why?: string }[]; n?: number; fails?: number; lane?: string }) {
  const passed = cases.filter((c) => c.ok !== false).length;
  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex items-baseline gap-3">
        <b className={cn('text-[20px] font-extrabold', fails ? 'text-bad' : 'text-ok')}>{passed}{n ? ` / ${n}` : ` / ${cases.length}`}</b>
        <span className="text-ink-3">{lane === 'HEAL' ? '회귀 테스트' : '정상·엣지 케이스 + 하네스 불변식'} · 루프 밖 고정 하네스가 채점 (Agent가 수정 불가)</span>
      </div>
      <div className="grid max-h-[220px] grid-cols-2 gap-x-3 gap-y-0.5 overflow-auto">
        {cases.slice(-60).map((c, i) => (
          <div key={i} className={cn('flex items-start gap-1.5 truncate', c.ok === false ? 'text-[#ffd6d4]' : 'text-ink-2')}>
            <i className={cn('mt-[5px] size-2 flex-none rounded-full', c.ok === false ? 'bg-bad' : 'bg-ok')} />
            <span className="truncate">{c.label}{c.why && c.ok === false ? <em className="text-ink-3"> — {c.why}</em> : null}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
