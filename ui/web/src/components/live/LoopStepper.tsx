// 루프 스테퍼 — 현재 루프(L1/L2/L3)의 단계 점. 지나온 점은 채워지고, 지금 점은 커지며, 대기(사람·측정)는 앰버로 깜빡인다.
import { useApp } from '@/store/store';
import { LANE_SLOTS } from '@/store/live';
import { LANE_KO } from '@/lib/ko';
import type { Lane } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function LoopStepper({ lane, compact }: { lane: Lane; compact?: boolean }) {
  const S = useApp((s) => s.live.lanes[lane]);
  const slots = LANE_SLOTS[lane];
  const c = lane === 'L1' ? 'l1' : lane === 'L3' ? 'l3' : 'l2';
  const curIdx = S.cur ? slots.findIndex((x) => x.key === S.cur) : -1;
  return (
    <div className={`lane-${c}`}>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span><b className="text-[var(--c)]">{LANE_KO[lane]}</b>{lane === 'L1' ? ' · 요청 1건을 처리하는 루프' : lane === 'L3' ? ' · 쌓인 경험으로 Agent를 바꾸는 바깥 루프' : lane === 'HEAL' ? ' · 실행 오류 → 자기 코드를 고친다' : ' · 처음 보는 요청 → 새 Agent를 만든다'}</span>
        <span className="max-w-[46%] truncate pl-2 font-mono">{S.status}</span>
      </div>
      <div className={cn('relative mt-2 flex items-center', compact ? 'h-5' : 'h-7')}>
        <i className="absolute inset-x-[7px] top-1/2 h-[2px] -translate-y-1/2 bg-line-2" />
        {curIdx >= 0 && <i className="absolute left-[7px] top-1/2 h-[2px] -translate-y-1/2 bg-[var(--c)] transition-[width] duration-500" style={{ width: `calc(${(curIdx / Math.max(1, slots.length - 1)) * 100}% - 0px)` }} />}
        {slots.map((s, i) => {
          const visited = S.visited.includes(s.key);
          const cur = S.cur === s.key;
          const wait = S.wait === s.key;
          const stop = S.stopped && cur;
          return (
            <div key={s.key} className="relative flex flex-1 items-center justify-start first:flex-none last:flex-none" title={s.label}>
              <span className={cn('relative z-10 block rounded-full border-2 transition-all', compact ? 'size-3' : 'size-3.5', visited || cur ? 'border-[var(--c)] bg-[var(--c)]' : 'border-line-2 bg-panel',
                cur && !wait && 'scale-[1.45] shadow-[0_0_0_4px_color-mix(in_oklab,var(--c)_25%,transparent)]', wait && 'lane-gate beat scale-[1.45] border-gate bg-gate', stop && 'lane-bad border-bad bg-bad', s.kind === 'gate' && !visited && !cur && 'rotate-45 rounded-[3px]')} />
              {cur && !compact && (
                <span className={cn('absolute left-1/2 top-full z-10 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold', wait ? 'bg-gate text-[#2a1a00]' : stop ? 'bg-bad text-white' : 'bg-[var(--c)] text-[#06221f]', i === 0 && 'left-0 translate-x-0', i === slots.length - 1 && 'left-auto right-0 translate-x-0')}>{S.stopped ? '중단' : wait ? `${s.label} 대기` : s.label}</span>
              )}
            </div>
          );
        })}
      </div>
      {!compact && <div className="h-5" />}
    </div>
  );
}
