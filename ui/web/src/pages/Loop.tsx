// 루프 — Loop Engineering. 위: 3중 루프 다이어그램(토큰이 실제 노드를 따라 이동) + 예산 게이지 / 아래: 실행 트레이스
import { useState } from 'react';
import { useApp } from '@/store/store';
import LoopDiagram from '@/components/loop/LoopDiagram';
import RunTimeline from '@/components/loop/RunTimeline';
import { cn } from '@/lib/utils';

const FILTERS = [['all', '전체'], ['L1', 'L1 Task'], ['L2', 'L2 Heal·Grow'], ['L3', 'L3 Evolve'], ['OPS', '배경 운영']] as const;

export default function LoopPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const policy = useApp((s) => s.snap?.policy);
  const T = useApp((s) => s.trace);
  const L2 = policy?.loop_budget?.L2 || { max_attempts: 5, max_minutes: 15 };
  return (
    <div className="grid h-full grid-rows-[minmax(0,57%)_minmax(0,43%)]">
      <section className="relative flex min-h-0 flex-col border-b border-line bg-panel">
        <div className="flex items-baseline gap-3 px-5 pt-3">
          <h2 className="text-[14px] font-bold">Loop Engineering</h2>
          <span className="truncate text-[11.5px] text-ink-3">3중 루프. L1이 요청을 처리하고, 막히면 L2가 스스로 고치거나(Heal) 새 Agent를 만들고(Grow), L3가 쌓인 경험으로 Agent 자체를 바꿉니다. 빛나는 점 = 지금 실행 중인 위치</span>
          <div className="ml-auto flex flex-none items-center gap-3 text-[11px] text-ink-3">
            <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-l1" />CodeAct</span>
            <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-jev" />Jev 판단</span>
            <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-ok" />결정적 코드</span>
            <span className="flex items-center gap-1"><i className="size-2 rotate-45 rounded-[2px] bg-gate" />사람 승인</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 px-3 py-1"><LoopDiagram /></div>
      </section>
      <section className="flex min-h-0 flex-col">
        <div className="flex items-center gap-3 px-4 pt-3 pb-2">
          <h2 className="text-[13.5px] font-bold">실행 트레이스</h2>
          <span className="text-[11.5px] text-ink-3">누가 · 무엇을 · 어떤 값으로. 펼치면 코드·확률·값·diff</span>
          <div className="ml-3 inline-flex overflow-hidden rounded-lg border border-line-2">
            {FILTERS.map(([k, label]) => <button key={k} type="button" onClick={() => setFilter(k)} className={cn('h-7 px-2.5 text-[11.5px] text-ink-2 hover:text-ink', filter === k && 'bg-raise font-semibold text-ink')}>{label}</button>)}
          </div>
          <span className="ml-auto truncate text-[11px] text-ink-3">예산(루프 밖 고정, eval/policy.json): L2 최대 {L2.max_attempts}회 · {L2.max_minutes}분 / L1 재계획 {policy?.loop_budget?.L1?.max_replans ?? 3}회 / L3 후보 {policy?.loop_budget?.L3?.max_candidates ?? 3}개 · Jev 자율 편성 ≥{policy?.jev?.route_auto ?? 0.9}</span>
          <span className="flex-none font-mono text-[11px] text-ink-3">런 {Object.keys(T.runs).length} · 단계 {T.nspan.toLocaleString('ko-KR')}</span>
        </div>
        <RunTimeline filter={filter} />
      </section>
    </div>
  );
}

