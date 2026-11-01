// 시연 — 시나리오 4개(신규 분석 기능 자동 추가 · 로그 포맷 변경 자동 대응 · 운영 결과로 추천 기준 보정 · 미사용 기능 정리)를
//   질문·사건 단위로 한 단계씩 실행한다. 가운데 Agent 명단이 시작 전과 비교해 무엇이 추가·수정·정리됐는지 보여준다.
import { useState } from 'react';
import { CheckCircle2, CircleDashed, Loader2, Play, RotateCcw } from 'lucide-react';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import { AGENT_KO, STATUS_KO, short } from '@/lib/ko';
import { SCENARIOS, type Scenario } from '@/lib/demo';
import type { RosterRow } from '@/store/live';
import type { Agent } from '@/lib/types';
import { cn } from '@/lib/utils';
import Blocks from '@/components/common/Blocks';
import OrchestrationMap from '@/components/map/OrchestrationMap';

const NO_AGENTS: Agent[] = [];
const TONE: Record<string, string> = { '': 'text-ink', ok: 'text-ok', bad: 'text-bad', ver: 'text-l3', gate: 'text-gate', warn: 'text-warn' };

export default function DemoPage() {
  const [sel, setSel] = useState(SCENARIOS[0].id);
  const sc = SCENARIOS.find((s) => s.id === sel)!;
  return (
    <div className="grid h-full grid-cols-[330px_minmax(0,1fr)_400px]">
      <ScenarioList sel={sel} onSel={setSel} />
      <div className="flex min-h-0 min-w-0 flex-col border-x border-line">
        <Now />
        <Roster scenario={sc} />
        <div className="min-h-0 flex-1"><OrchestrationMap live /></div>
      </div>
      <Steps sc={sc} />
    </div>
  );
}

function ScenarioList({ sel, onSel }: { sel: string; onSel: (id: string) => void }) {
  const demos = useApp((s) => s.snap?.demos);
  const running = useApp((s) => !!s.snap?.story?.running);
  const phase = useApp((s) => s.live.demo.phase);
  const chapter = useApp((s) => s.live.chapter);
  const toast = useApp((s) => s.toast);
  const refresh = useApp((s) => s.refresh);
  const ready = demos && SCENARIOS.every((x) => demos[x.id]);
  const preparing = phase === 'prepare:start' && running;
  const prepare = async () => {
    try { await api('/api/demo/prepare', {}); toast('시연 준비를 시작했습니다. 최대 속도로 약 6분 걸립니다.'); } catch (e) { toast((e as Error).message, 'error'); }
    refresh();
  };
  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <div className="px-5 pt-4 pb-2">
        <h2 className="text-[15px] font-extrabold">시연 시나리오</h2>
        <p className="mt-1 text-[12px] leading-snug text-ink-3">질문 하나, 사건 하나로 Agent 기능이 추가·수정·정리되는 과정을 단계별로 보여줍니다. 시나리오를 고르고 오른쪽 단계를 차례로 누르세요.</p>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-3">
        {SCENARIOS.map((s) => (
          <button key={s.id} type="button" onClick={() => onSel(s.id)}
            className={cn('w-full rounded-xl border px-4 py-3 text-left transition-colors', `lane-${s.c}`, sel === s.id ? 'border-[var(--c)] bg-[color-mix(in_oklab,var(--c)_10%,var(--panel-2))]' : 'border-line bg-panel-2 hover:border-line-2')}>
            <div className="flex items-center gap-2">
              <span className="flex size-6 flex-none items-center justify-center rounded-full bg-[var(--c)] text-[12px] font-extrabold text-[#0b1016]">{s.no}</span>
              <span className="text-[14.5px] font-bold text-ink">{s.title}</span>
              <span className="ml-auto font-mono text-[10px] text-ink-3">{s.tech}</span>
            </div>
            <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{s.situation}</p>
            <p className="mt-1 text-[11.5px] font-semibold text-[var(--c)]">→ {s.changes}</p>
          </button>
        ))}
      </div>
      <div className="border-t border-line px-4 py-3 text-[11.5px] text-ink-3">
        {preparing ? (
          <div className="flex items-center gap-2 text-ink-2"><Loader2 className="size-4 animate-spin" />시연 준비 중 — {chapter?.title || '초기 구축'} (최대 속도)</div>
        ) : ready ? (
          <>시연 준비 완료. 각 시나리오는 1단계를 누를 때마다 시작 직전 상태로 돌아가 같은 결과가 재현됩니다.</>
        ) : (
          <>
            <div className="mb-2 text-ink-2">처음 한 번 <b>시연 준비</b>가 필요합니다. 시나리오 시점까지의 운영 이력을 최대 속도로 미리 만들어 둡니다(약 6분).</div>
            <button type="button" disabled={running} onClick={prepare} className="rounded-md bg-l1 px-3 py-1.5 text-[12.5px] font-bold text-[#06221f] disabled:opacity-50">시연 준비</button>
          </>
        )}
      </div>
    </section>
  );
}

function Now() {
  const now = useApp((s) => s.live.now);
  const idle = !now.say;
  return (
    <div className="flex-none border-b border-line px-5 pt-3.5 pb-3">
      <div className="text-[11px] font-bold tracking-wide text-ink-3">지금 일어나는 일</div>
      <h1 key={now.at} className={cn('flash-in mt-1 text-[20px] font-extrabold leading-snug tracking-tight', idle ? 'text-ink-3' : TONE[now.tone])}>
        {idle ? '오른쪽에서 단계를 누르면 Agent가 하는 일이 여기 한 문장으로 나옵니다' : now.say}
      </h1>
      {now.detail && <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-2">{now.detail}</p>}
    </div>
  );
}

type Mark = { text: string; c: string } | null;
function diff(b: RosterRow | undefined, a: RosterRow): Mark {
  if (!b || b.status === 'candidate') return a.status === 'candidate' ? null : { text: '새로 추가', c: 'l2' };
  if (b.status === 'retired' && a.status !== 'retired') return { text: '보관함에서 복원', c: 'l2' };
  if (b.status !== 'retired' && a.status === 'retired') return { text: '정리됨 · 보관', c: 'ink' };
  if (b.status !== 'deprecated' && a.status === 'deprecated') return { text: '정리 예정', c: 'warn' };
  if (b.version !== a.version) return { text: `${b.version} → ${a.version}`, c: 'l3' };
  if (b.status !== a.status) return { text: `${STATUS_KO[b.status] || b.status} → ${STATUS_KO[a.status] || a.status}`, c: 'ok' };
  return null;
}

function Roster({ scenario }: { scenario: Scenario }) {
  const agents = useApp((s) => s.snap?.registry.agents) ?? NO_AGENTS;   // 선택자에서 새 배열을 만들면 zustand가 무한 재렌더링
  const D = useApp((s) => s.live.demo);
  const base = D.id === scenario.id ? D.baseline : null;
  const bmap = new Map((base || []).map((r) => [r.agent_id, r]));
  const rows = agents.filter((a) => a.status !== 'candidate').map((a) => {
    const now: RosterRow = { agent_id: a.agent_id, kind: a.kind, version: a.active_version, status: a.status };
    return { a, mark: base ? diff(bmap.get(a.agent_id), now) : null };
  }).sort((x, y) => (x.a.kind === y.a.kind ? 0 : x.a.kind === 'agent' ? -1 : 1));
  const changed = rows.filter((r) => r.mark).length;
  return (
    <div className="flex-none border-b border-line px-5 py-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13.5px] font-bold">Agent 명단</h2>
        <span className="text-[11.5px] text-ink-3">{base ? (changed ? `시작 전과 비교해 ${changed}곳이 바뀌었습니다` : '시작 전 상태 — 단계를 진행하면 바뀐 곳이 표시됩니다') : '시나리오 1단계를 누르면 시작 전 상태를 기준으로 변화를 표시합니다'}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {rows.map(({ a, mark }) => {
          const gone = a.status === 'retired';
          return (
            <div key={a.agent_id} className={cn('rounded-lg border px-2.5 py-1.5', mark ? `lane-${mark.c} border-[var(--c)] bg-[color-mix(in_oklab,var(--c)_12%,transparent)]` : 'border-line bg-panel-2', gone && !mark && 'opacity-45', a.kind === 'skill' && 'border-dashed')}>
              <div className="flex items-baseline gap-1.5">
                <span className={cn('text-[12.5px] font-semibold', gone ? 'text-ink-3 line-through' : 'text-ink')}>{AGENT_KO[a.agent_id] || short(a.agent_id)}{a.kind === 'agent' && a.agent_id !== 'super_agent' ? ' Agent' : ''}</span>
                <span className="font-mono text-[10.5px] text-ink-3">{a.active_version}</span>
              </div>
              <div className="text-[10.5px]">
                {mark ? <b className="text-[var(--c)]">{mark.text}</b> : <span className="text-ink-3">{a.kind === 'skill' ? '공용 스킬' : STATUS_KO[a.status] || a.status}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Steps({ sc }: { sc: Scenario }) {
  const D = useApp((s) => s.live.demo);
  const ready = useApp((s) => !!s.snap?.demos?.[sc.id]);
  const running = useApp((s) => !!s.snap?.story?.running);
  const toast = useApp((s) => s.toast);
  const refresh = useApp((s) => s.refresh);
  const msgs = useApp((s) => s.chat.msgs);
  const mine = D.id === sc.id;
  const last = [...msgs].reverse().find((m) => m.kind !== 'user' && m.kind !== 'replay' && m.blocks.length);
  const run = async (i: number) => {
    try { await api('/api/demo/run', { id: sc.id, step: i }); } catch (e) { toast((e as Error).message, 'error'); }
    refresh();
  };
  return (
    <section className={cn('flex min-h-0 flex-col bg-panel', `lane-${sc.c}`)}>
      <div className="px-5 pt-4 pb-2">
        <div className="text-[11px] font-bold text-[var(--c)]">시나리오 {sc.no} · {sc.tech}</div>
        <h2 className="text-[17px] font-extrabold">{sc.title}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-3">
        {sc.steps.map((st, i) => {
          const done = mine && D.done.includes(i);
          const active = mine && D.step === i && D.phase === 'start';
          const err = mine && D.step === i && (D.phase === 'error' || D.phase === 'stopped');
          const enabled = ready && !running && (i === 0 || (mine && D.done.includes(i - 1)));
          return (
            <div key={i} className={cn('rounded-xl border px-4 py-3', active ? 'border-[var(--c)] bg-[color-mix(in_oklab,var(--c)_10%,transparent)]' : done ? 'border-ok/50' : 'border-line bg-panel-2')}>
              <div className="flex items-center gap-2">
                {done ? <CheckCircle2 className="size-5 flex-none text-ok" /> : active ? <Loader2 className="size-5 flex-none animate-spin text-[var(--c)]" /> : <CircleDashed className="size-5 flex-none text-ink-3" />}
                <span className="text-[11px] font-bold text-ink-3">{i + 1}단계</span>
                <span className="text-[14px] font-bold">{st.label}</span>
                <button type="button" disabled={!enabled} onClick={() => run(i)}
                  className={cn('ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-bold', enabled ? 'bg-[var(--c)] text-[#0b1016] hover:opacity-90' : 'bg-raise text-ink-3')}>
                  {done && i === 0 ? <><RotateCcw className="size-3.5" />처음부터</> : <><Play className="size-3.5 fill-current" />{st.question ? '질문 보내기' : '실행'}</>}
                </button>
              </div>
              {st.question && <div className="mt-2 rounded-md bg-bg/60 px-3 py-2 text-[12.5px] font-semibold text-ink">“{st.question}”</div>}
              {st.event && <div className="mt-2 rounded-md border border-dashed border-line-2 px-3 py-2 text-[12px] text-ink-2">{st.event}</div>}
              <div className="mt-2 text-[10.5px] font-bold text-ink-3">이때 볼 것</div>
              <ul className="mt-0.5 space-y-0.5">
                {st.watch.map((w) => <li key={w} className="flex gap-1.5 text-[12px] leading-snug text-ink-2"><span className="text-[var(--c)]">·</span>{w}</li>)}
              </ul>
              {err && <div className="mt-2 text-[12px] text-bad">{D.phase === 'stopped' ? '중단되었습니다.' : `오류: ${D.error}`}</div>}
            </div>
          );
        })}
        {!ready && <div className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-ink-3">왼쪽 아래 「시연 준비」를 먼저 눌러 주세요.</div>}
      </div>
      <div className="max-h-[38%] min-h-[120px] overflow-auto border-t border-line px-4 py-3">
        <div className="mb-1.5 text-[11px] font-bold text-ink-3">Agent 답변 (최근)</div>
        {last ? <Blocks blocks={last.blocks} compact /> : <div className="text-[12px] text-ink-3">아직 답변이 없습니다.</div>}
      </div>
    </section>
  );
}
