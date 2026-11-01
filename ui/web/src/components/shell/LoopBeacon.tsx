// 루프 비컨 — L2(Heal·Grow)·L3(Evolve)가 발동한 순간을 시연·라이브 화면에 알리고, 그 루프가 움직이는 탭으로 바로 넘긴다.
//   루프·진화 탭은 실시간이지만 평소엔 다른 화면을 보고 있어 "움직이는 순간"을 놓친다 → 발동 시점에 넘어갈 길을 만든다.
import { useEffect, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { useApp, type View } from '@/store/store';
import { LANE_SLOTS, type LaneState } from '@/store/live';
import { cn } from '@/lib/utils';

type BLane = 'HEAL' | 'GROW' | 'L3';
const RECENT = 25;   // 마지막 이벤트 후 이 시간(초)까지 '진행 중'으로 본다
const META: Record<BLane, { name: string; what: string; c: string; view: View; cta: string; end: string[] }> = {
  HEAL: { name: 'L2 Heal', what: '실행 오류 → Agent가 자기 코드를 고치는 중', c: 'l2', view: 'loop', cta: '루프에서 보기', end: ['reg'] },
  GROW: { name: 'L2 Grow', what: '처리 못 하는 요청 → 새 Agent를 만드는 중', c: 'l2', view: 'loop', cta: '루프에서 보기', end: ['reg'] },
  L3: { name: 'L3 Evolve', what: '쌓인 경험으로 Agent 자체를 바꾸는 중', c: 'l3', view: 'evolve', cta: '진화 사이클 보기', end: ['archive', 'promote'] },
};

export interface LoopActivity { lane: BLane; S: LaneState; done: boolean }

// 지금(최근 RECENT초) 움직인 L2·L3 루프 중 가장 최근 것
export function useLoopActivity(): LoopActivity | null {
  const lanes = useApp((s) => s.live.lanes);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const latest = Math.max(lanes.HEAL.at, lanes.GROW.at, lanes.L3.at);
  const live = now - latest < RECENT;
  useEffect(() => {
    setNow(Date.now() / 1000);
    if (Date.now() / 1000 - latest >= RECENT) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [latest]);
  if (!live) return null;
  const lane = (['HEAL', 'GROW', 'L3'] as BLane[]).reduce((a, b) => (lanes[b].at > lanes[a].at ? b : a));
  const S = lanes[lane];
  if (!S.run) return null;
  return { lane, S, done: S.stopped || (!!S.cur && META[lane].end.includes(S.cur)) };
}

export const beaconView = (a: LoopActivity | null): View | null => (a ? META[a.lane].view : null);

export default function LoopBeacon() {
  const view = useApp((s) => s.view);
  const go = useApp((s) => s.go);
  const act = useLoopActivity();
  const [hidden, setHidden] = useState<string | null>(null);
  if (!act || (view !== 'demo' && view !== 'live')) return null;
  const { lane, S, done } = act;
  const key = `${lane}:${S.run}`;
  if (hidden === key) return null;
  const M = META[lane];
  const slots = LANE_SLOTS[lane];
  const cur = slots.find((x) => x.key === S.cur)?.label;
  const state = S.stopped ? '중단 — 사람에게 넘김' : done ? '완료' : cur ? `지금: ${cur}` : '진행 중';
  return (
    <div className={cn(`lane-${M.c} flash-in pointer-events-auto absolute bottom-4 left-4 z-40 w-[340px] rounded-xl border-2 border-[var(--c)] bg-popover px-3.5 py-3 shadow-2xl`, S.stopped && 'lane-bad')} role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <span className={cn('size-2.5 flex-none rounded-full bg-[var(--c)]', !done && 'beat')} />
        <b className="text-[13px] text-[var(--c)]">{M.name} 발동</b>
        <span className="truncate font-mono text-[11px] text-ink-3">{S.status.replace(/ · 중단$/, '') || S.run}</span>
        <button type="button" aria-label="닫기" onClick={() => setHidden(key)} className="ml-auto rounded p-0.5 text-ink-3 hover:bg-raise hover:text-ink"><X className="size-3.5" /></button>
      </div>
      <div className="mt-1 text-[12.5px] text-ink">{M.what}</div>
      <div className="mt-2 flex items-center gap-1">
        {slots.map((x) => {
          const on = S.cur === x.key, vis = S.visited.includes(x.key);
          return <i key={x.key} title={x.label} className={cn('h-1.5 flex-1 rounded-full', on ? 'bg-[var(--c)]' : vis ? 'bg-[color-mix(in_oklab,var(--c)_40%,var(--raise))]' : 'bg-raise')} />;
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className={cn('truncate text-[11.5px]', S.stopped ? 'text-bad' : 'text-ink-2')}>{state}</span>
        <button type="button" onClick={() => go(M.view)}
          className="ml-auto inline-flex h-7 flex-none items-center gap-1 rounded-lg bg-[var(--c)] px-2.5 text-[12px] font-bold text-[#06221f] hover:brightness-110">
          {M.cta}<ArrowRight className="size-3.5" />
        </button>
        {lane === 'L3' && <button type="button" onClick={() => go('loop')} className="h-7 flex-none rounded-lg border border-line-2 px-2 text-[11.5px] text-ink-2 hover:text-ink">루프</button>}
      </div>
    </div>
  );
}
