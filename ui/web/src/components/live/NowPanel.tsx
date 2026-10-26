// Now 패널 — 시나리오 · 요청 · "지금 Agent가 하는 일"(큰 자막) · 루프 위치 · Agentic 지표 · 행동 일지
import { useEffect, useRef } from 'react';
import { useApp } from '@/store/store';
import { LANE_KO } from '@/lib/ko';
import { hhmm } from '@/lib/format';
import { cn } from '@/lib/utils';
import LoopStepper from './LoopStepper';
import type { Focus } from '@/store/live';

const TONE: Record<string, string> = { '': 'text-ink', ok: 'text-ok', bad: 'text-bad', ver: 'text-l3', gate: 'text-gate', warn: 'text-warn' };
const KIND_BADGE: Record<string, [string, string]> = { request: ['요청', 'l1'], parse: ['해석', 'l1'], route: ['편성', 'jev'], jev: ['Jev', 'jev'], code: ['CodeAct', 'l1'], agent: ['Agent', 'l1'], judge: ['판정', 'ok'], approval: ['사람', 'gate'],
  response: ['응답', 'l1'], version: ['버전', 'l3'], candidate: ['후보', 'l3'], tests: ['테스트', 'l2'], fault: ['장애', 'bad'], thought: ['생각', 'warn'], replay_case: ['리플레이', 'l3'], replay_quarter: ['분기', 'l3'], report: ['리포트', 'l3'],
  registry: ['Registry', 'l3'], node: ['단계', 'ink'], spec: ['명세', 'l2'], memory: ['메모리', 'l1'], ops: ['배경', 'ink'], policy: ['정책', 'gate'] };

export default function NowPanel() {
  const live = useApp((s) => s.live);
  const snap = useApp((s) => s.snap);
  const setFocus = useApp((s) => s.setFocus);
  const focusId = useApp((s) => s.live.focus?.id);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = 0; }, [live.acts.length]);
  const lane = live.now.lane || 'L1';
  const laneC = lane === 'L1' ? 'l1' : lane === 'L3' ? 'l3' : 'l2';
  const idle = !live.now.say;
  const sb = snap?.counts?.sandbox || {};
  const counters: [string, number, string][] = [
    ['CodeAct 실행', Math.max(live.counters.code, sb.executions || 0), 'l1'], ['Agent 호출', live.counters.calls, 'l1'], ['Jev 판단', Math.max(live.counters.jev, snap?.jev?.calls || 0), 'jev'],
    ['Self-Heal', Math.max(live.counters.heal, snap?.counts?.heals || 0), 'l2'], ['Agent 생성', Math.max(live.counters.grow, snap?.counts?.grows || 0), 'l2'], ['진화 반영', Math.max(live.counters.evolve, snap?.counts?.evolves || 0), 'l3'],
    ['사람 승인', live.counters.human, 'gate'], ['무승인 변경', 0, 'ok'],
  ];
  const m = /^(SC-\d+)\s+(.*)$/.exec(live.chapter?.title || '');

  return (
    <section className="flex min-h-0 flex-col bg-panel">
      {/* 시나리오 · 요청 */}
      <div className="border-b border-line px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
          <span className="rounded bg-raise px-1.5 py-0.5 font-semibold text-ink-2">{m ? m[1] : live.chapter ? '챕터' : 'Autopilot 대기'}</span>
          <span>{live.chapter?.date || ''}</span>
          <span className="truncate font-semibold text-ink-2">{m ? m[2] : live.chapter?.title || ''}</span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-ink-2">{live.story || '상단 Autopilot을 누르면 Agent가 시나리오(SC-006 → SC-009)를 스스로 수행합니다. 오른쪽 대화창에서 엔지니어처럼 직접 요청할 수도 있습니다.'}</p>
      </div>

      {/* 지금 하는 일 */}
      <div className={cn('border-b border-line px-5 pt-4 pb-4', `lane-${laneC}`)}>
        {live.question && (
          <div className="mb-3 rounded-lg border border-line bg-bg/60 px-3 py-2">
            <div className="text-[11px] text-ink-3">{live.question.who} · {live.question.tag}</div>
            <div className="mt-0.5 text-[13px] font-semibold leading-snug text-ink">“{live.question.text}”</div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] font-extrabold tracking-wide', idle ? 'bg-raise text-ink-3' : 'bg-[color-mix(in_oklab,var(--c)_22%,transparent)] text-[var(--c)]')}>{idle ? 'READY' : LANE_KO[lane]}</span>
          {!idle && <i className="h-[3px] flex-1 rounded-full bg-raise"><i className="flowing block h-full w-full rounded-full opacity-70" /></i>}
        </div>
        <h1 key={live.now.at} className={cn('flash-in mt-2.5 text-[22px] font-extrabold leading-[1.25] tracking-tight', idle ? 'text-ink-3' : TONE[live.now.tone])}>
          {idle ? 'Agent가 움직이면 지금 하는 일이 여기 한 문장으로 나옵니다' : live.now.say}
        </h1>
        {live.now.detail && <p className="mt-2 line-clamp-3 text-[12.5px] leading-snug text-ink-2">{live.now.detail}</p>}
        <div className="mt-4"><LoopStepper lane={lane} /></div>
      </div>

      {/* Agentic 지표 */}
      <div className="grid grid-cols-4 gap-px border-b border-line bg-line">
        {counters.map(([label, v, c]) => (
          <div key={label} className={cn('bg-panel px-3 py-2', `lane-${c}`)}>
            <div className="text-[10.5px] text-ink-3">{label}</div>
            <div className="font-mono text-[17px] font-bold leading-tight text-[var(--c)]">{v.toLocaleString('ko-KR')}</div>
          </div>
        ))}
      </div>

      {/* 행동 일지 */}
      <div className="flex items-baseline gap-2 px-5 pt-3 pb-1.5">
        <h2 className="text-[12.5px] font-bold">행동 일지</h2>
        <span className="text-[11px] text-ink-3">클릭하면 가운데 아래에 자세히</span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {live.acts.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-ink-3">아직 행동이 없습니다.</div>}
        {[...live.acts].reverse().map((a: Focus) => {
          const [k, c] = KIND_BADGE[a.kind] || ['', 'ink'];
          const on = a.id === focusId;
          return (
            <button key={a.id} type="button" onClick={() => setFocus(a.id)} className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2', on && 'bg-panel-2')}>
              <span className="w-[38px] flex-none pt-0.5 font-mono text-[10.5px] text-ink-3">{hhmm(a.vts)}</span>
              <span className={cn('mt-[3px] inline-flex h-[16px] w-[52px] flex-none items-center justify-center rounded-sm text-[9.5px] font-bold', `lane-${c} bg-[color-mix(in_oklab,var(--c)_20%,transparent)] text-[var(--c)]`)}>{k}</span>
              <span className={cn('min-w-0 flex-1 truncate text-[12px]', on ? 'text-ink' : 'text-ink-2')}>{a.title}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
