// 진화 사이클 — 5단계를 크게 놓고, 각 단계에 "이게 무엇인지" 한 줄과 "지금/최근 무슨 일이 있었는지"를 채운다.
import { useApp } from '@/store/store';
import type { LineageRow, Report } from '@/lib/types';
import { agentKo } from '@/lib/ko';
import { cn } from '@/lib/utils';

const STAGES = [
  { key: 'detect', title: '감지', what: '경험 메모리·Registry 지표에서 문제를 찾는다', how: '1차 Fail 편향 · 코드 중복 · 불필요 호출 · 미사용 Agent · 실행 오류 · 처리 불가 요청', c: 'l3' },
  { key: 'mutate', title: '변이 후보', what: '5계층 중 어디를 바꿀지 후보를 만든다', how: '① 파라미터·교훈 ② 스킬 ③ Agent 코드 ④ Agent 구성 ⑤ 편성 전략', c: 'l3' },
  { key: 'eval', title: '하네스 평가', what: '루프 밖에 고정된 하네스로 채점한다', how: 'Evolve셋 개선 ∧ Held-out(검증셋) 비하락이어야 통과. Agent가 평가 기준을 건드릴 수 없다', c: 'ok' },
  { key: 'select', title: '선택 · 승인', what: '가장 좋은 후보를 고르고 사람이 승인한다', how: '진화안 채택 · 정식 승격 · 폐기 확정은 사람 승인 필수', c: 'gate' },
  { key: 'apply', title: '반영 · 보관', what: 'Shadow 병행 → 승격, 불일치면 자동 롤백', how: '채택·기각·보류 후보 전부 아카이브 보관. 기각안은 다음 진화의 출발점', c: 'l1' },
];
const STEP_OF: Record<number, string> = { 0: 'detect', 1: 'mutate', 2: 'eval', 3: 'select' };

export default function EvolvePipeline({ reports, lineage }: { reports: Report[]; lineage: LineageRow[] }) {
  const live = useApp((s) => s.evolve.live);
  const order = useApp((s) => s.evolve.order);
  const L3 = useApp((s) => s.live.lanes.L3);
  const counts = useApp((s) => s.snap?.counts);
  const running = order.map((k) => live[k]).filter((c) => c && !c.done);
  const cur = running[0];
  const n = (k: string[]) => lineage.filter((r) => k.includes(r.kind) && (r.from_version !== r.to_version || r.kind === 'retire')).length;
  const evolveReports = reports.filter((r) => r.kind === 'evolve');
  const adopted = evolveReports.reduce((a, r) => a + ((r.content?.candidates || []).filter((x: any) => x.decision === 'adopt').length), 0);
  const cands = evolveReports.reduce((a, r) => a + ((r.content?.candidates || []).length), 0);
  const stats: [string, number | string, string][] = [['Grow 생성', n(['grow']), 'l2'], ['Heal 패치', n(['heal']), 'l2'], ['Evolve 채택', n(['evolve', 'compose']), 'l3'], ['정식 승격', n(['promote']), 'ok'], ['자동 롤백', n(['rollback']), 'bad'], ['폐기', n(['retire']), 'ink'], ['교훈', counts?.lessons ?? 0, 'l3'], ['아카이브', counts?.archive ?? 0, 'ink']];
  return (
    <section className="border-b border-line bg-panel px-5 pt-4 pb-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[18px] font-extrabold tracking-tight">Self-Evolving</h1>
        <p className="text-[12.5px] text-ink-2">Agent가 운영하면서 쌓인 경험으로 <b className="text-ink">자기 자신(코드·스킬·구성·편성 전략)</b>을 바꾸는 바깥 루프. 사람이 만든 1.0.0에서 출발해 Agent가 스스로 만들고, 고치고, 진화시키고, 불필요해지면 폐기합니다.</p>
        <div className="ml-auto flex items-center gap-4">
          {stats.map(([k, v, c]) => <div key={k} className={cn('text-right', `lane-${c}`)}><div className="font-mono text-[18px] font-bold leading-none text-[var(--c)]">{v}</div><div className="text-[10.5px] text-ink-3">{k}</div></div>)}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-5 gap-2">
        {STAGES.map((s, i) => {
          const active = cur && STEP_OF[cur.stepIdx] === s.key && cur.kind === 'evolve';
          const bad = active && cur?.stepState === 'bad';
          return (
            <div key={s.key} className={cn(`lane-${s.c} relative rounded-xl border bg-panel-2 px-3.5 py-3 transition-all`, active ? 'border-[var(--c)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--c)_18%,transparent)]' : 'border-line', bad && 'lane-bad border-bad')}>
              <div className="flex items-center gap-2">
                <span className={cn('flex size-6 items-center justify-center rounded-full text-[12px] font-extrabold', active ? 'bg-[var(--c)] text-[#06221f]' : 'bg-raise text-ink-2')}>{i + 1}</span>
                <b className="text-[14px]">{s.title}</b>
                {active && <span className="ml-auto inline-flex h-5 items-center rounded-full bg-[var(--c)] px-2 text-[10px] font-extrabold text-[#06221f]">지금</span>}
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">{s.what}</div>
              <div className="mt-1 text-[11px] leading-snug text-ink-3">{s.how}</div>
              {i < STAGES.length - 1 && <i className="absolute -right-[9px] top-1/2 z-10 size-4 -translate-y-1/2 rotate-45 border-r border-t border-line bg-panel-2" />}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3 text-[12px]">
        <span className={cn('inline-flex h-[20px] items-center rounded-full px-2 text-[10.5px] font-extrabold', L3.status === '대기' ? 'bg-raise text-ink-3' : 'bg-l3/25 text-l3')}>L3 Evolve</span>
        {cur ? <span className="text-ink"><b className="text-l3">{cur.title}</b> · {cur.note}</span> : <span className="text-ink-3">{L3.status === '대기' ? '지금은 진화 루프가 쉬고 있습니다. 야간(02:00)·분기 말·리플레이 중에 돕니다.' : L3.status}</span>}
        <span className="ml-auto font-mono text-[11px] text-ink-3">변이 후보 {cands} · 채택 {adopted}</span>
      </div>
      {running.slice(1).map((c) => <div key={c.id} className="mt-1 text-[11.5px] text-ink-2">{c.kind === 'heal' ? 'Heal' : c.kind === 'grow' ? 'Grow' : 'Evolve'} {c.id} · {agentKo(c.agent_id || '')} · {c.note}</div>)}
    </section>
  );
}
