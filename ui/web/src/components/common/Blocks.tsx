// 응답 블록 — Super Agent 응답(절차·챔버 상태·이력·추천·판정·생성·질문·재작업·에스컬레이션)
import { cn } from '@/lib/utils';
import type { Block } from '@/store/chat';

const CLS: Record<string, string> = { recommendation: 'border-l1/60 bg-l1/8', judgement: 'border-ok/50', grow: 'border-l2/60 bg-l2/8', ask: 'border-warn/60', rework: 'border-warn/60', escalate: 'border-bad/60', state: 'border-gate/60' };

export function Lesson({ text }: { text: string }) {
  const parts = String(text).split(/(\[교훈 L-\d+[^\]]*\]|교훈 L-\d+|L-\d{4})/);
  return <>{parts.map((p, i) => (/L-\d{4}/.test(p) ? <span key={i} className="rounded bg-l3/20 px-1 text-[#d9d7ff]">{p}</span> : <span key={i}>{p}</span>))}</>;
}

export default function Blocks({ blocks, compact }: { blocks: Block[]; compact?: boolean }) {
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => (
        <div key={i} className={cn('rounded-lg border border-line bg-panel px-3 py-2.5', CLS[b.kind], b.warn && 'border-warn/60')}>
          <h4 className={cn('mb-1 font-bold', compact ? 'text-[12px]' : 'text-[13px]', b.kind === 'recommendation' && 'text-l1')}>{b.title}</h4>
          <ul className={cn('list-disc space-y-0.5 pl-4 text-ink-2', compact ? 'text-[11.5px]' : 'text-[12.5px]')}>
            {(b.lines || []).map((ln, j) => <li key={j}><Lesson text={ln} /></li>)}
          </ul>
          {b.kind === 'recommendation' && b.count != null && !b.warn && (
            <div className="mt-2 flex items-baseline gap-2"><b className="text-[26px] font-extrabold tracking-tight text-l1">{b.count}매</b><span className="text-[12px] text-ink-3">Seasoning 웨이퍼 추천</span></div>
          )}
        </div>
      ))}
    </div>
  );
}
