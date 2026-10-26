// 실행 트레이스 — 런(요청·Heal·Grow·진화·배경·리플레이) 카드 안에 span 행. 펼치면 코드·확률·값·판정 표·diff·테스트.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useApp } from '@/store/store';
import type { Run, Span } from '@/store/trace';
import { LANE_C, LANE_KO } from '@/lib/ko';
import { hhmm } from '@/lib/format';
import { cn } from '@/lib/utils';
import SpanDetail from './SpanDetail';

const BADGE: Record<string, string> = { code: 'CodeAct', jev: 'Jev', agent: 'Agent', sandbox: 'Sandbox', judge: '결정적', approval: '사람', tests: '테스트', version: '버전', candidate: '하네스', response: '응답', fab: 'Fab', memory: '메모리',
  thought: '생각', report: '리포트', route: '편성', parse: '해석', state: 'Fab', wait: '대기', observe: '검증', heal: 'Heal', spec: '명세', ops: '자율', rcase: '재생', qres: '진화', quarter: '분기', registry: 'Registry', redirect: '경로', shadow: 'Shadow', note: '메모', q: '요청', node: '' };
const ST_C: Record<string, string> = { ok: 'bg-ok', bad: 'bg-bad', warn: 'bg-warn', wait: 'bg-gate glow', run: 'bg-l1 glow', ver: 'bg-l3', gone: 'bg-ink-3' };
const STATUS_C: Record<string, string> = { run: 'text-l1', done: 'text-ok', bad: 'text-bad', wait: 'text-gate', '': 'text-ink-2' };

export default function RunTimeline({ filter }: { filter: 'all' | 'L1' | 'L2' | 'L3' | 'OPS' }) {
  const T = useApp((s) => s.trace);
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => { const el = ref.current; if (el && follow) el.scrollTop = el.scrollHeight; }, [T.nspan, T.nmark, follow]);
  const items = useMemo(() => T.order.filter((x) => {
    if (typeof x !== 'string') return filter === 'all' || filter === 'L1';
    const r = T.runs[x]; if (!r) return false;
    if (filter === 'all') return true;
    if (filter === 'L1') return r.lane === 'L1';
    if (filter === 'L2') return r.lane === 'HEAL' || r.lane === 'GROW' || (r.lane === 'L1' && r.childKeys.length > 0);
    if (filter === 'L3') return r.lane === 'L3' || r.lane === 'REPLAY';
    return r.lane === 'OPS';
  }), [T.order, T.runs, filter]);
  return (
    <div ref={ref} onScroll={(e) => { const el = e.currentTarget; const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 60; setFollow(atEnd); }} className="relative min-h-0 flex-1 space-y-2 overflow-auto px-4 pb-4">
      {items.length === 0 && <div className="pt-8 text-center text-[12.5px] text-ink-3">Autopilot을 시작하거나 요청을 보내면 Agent가 한 모든 일이 런 단위로 여기 쌓입니다.</div>}
      {items.map((x) => (typeof x === 'string' ? <RunCard key={x} r={T.runs[x]} /> : <MarkRow key={`m${x.mark}`} m={T.marks[x.mark]} />))}
      {!follow && <button type="button" onClick={() => { setFollow(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }} className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-l1/60 bg-panel-2 px-3 py-1 text-[11.5px] shadow-lg">▼ 최신으로</button>}
    </div>
  );
}

function MarkRow({ m }: { m: { cls: string; text: string; vts?: string } }) {
  if (!m) return null;
  const c = m.cls.includes('chapter') ? 'border-l1/50 text-ink' : m.cls.includes('fault') ? 'border-bad/60 text-[#ffd6d4]' : m.cls.includes('gate') ? 'border-gate/60 text-[#ffe9c6]' : m.cls.includes('done') ? 'border-ok/50 text-ink-2' : m.cls.includes('warn') || m.cls.includes('bad') ? 'border-warn/50 text-ink-2' : 'border-line text-ink-3';
  return <div className={cn('flex items-start gap-3 border-l-2 py-1 pl-3 text-[12px]', c, m.cls.includes('chapter') && 'mt-3 text-[13px] font-bold')}><span className="w-[38px] flex-none font-mono text-[10.5px] text-ink-3">{hhmm(m.vts)}</span><span>{m.text}</span></div>;
}

function RunCard({ r }: { r: Run }) {
  const toggleRun = useApp((s) => s.toggleRun);
  if (!r) return null;
  const c = LANE_C[r.lane] || 'ink';
  return (
    <section className={cn(`lane-${c} rounded-xl border border-line bg-panel`, r.parentKey && 'ml-6 mt-1 border-dashed')}>
      <button type="button" onClick={() => toggleRun(r.key)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        {r.open ? <ChevronDown className="size-3.5 flex-none text-ink-3" /> : <ChevronRight className="size-3.5 flex-none text-ink-3" />}
        <span className="inline-flex h-[20px] flex-none items-center rounded-full bg-[color-mix(in_oklab,var(--c)_22%,transparent)] px-2 text-[10.5px] font-extrabold text-[var(--c)]">{LANE_KO[r.lane] || r.lane}</span>
        {!r.key.startsWith('ops:') && r.key !== 'replay' && r.key !== 'registry' && <span className="flex-none font-mono text-[11px] text-ink-3">{r.key}</span>}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{r.title}</span>
        {r.sub && <span className="flex-none text-[11px] text-ink-3">{r.sub}</span>}
        {r.meta && <span className="flex-none font-mono text-[11px] text-ink-3">{r.meta}</span>}
        <span className={cn('flex-none text-[11.5px] font-semibold', STATUS_C[r.statusCls] || STATUS_C[''])}>{r.status}</span>
      </button>
      {r.open && (
        <div className="space-y-px px-2 pb-2">
          {r.spanIds.map((id) => <TopSpan key={id} id={id} />)}
          {r.childKeys.map((k) => <ChildRun key={k} k={k} />)}
        </div>
      )}
    </section>
  );
}
function ChildRun({ k }: { k: string }) { const r = useApp((s) => s.trace.runs[k]); return r ? <RunCard r={r} /> : null; }
function TopSpan({ id }: { id: number }) { const sp = useApp((s) => s.trace.spans[id]); return sp && sp.parentId == null ? <SpanRow sp={sp} /> : null; }
function KidSpan({ id }: { id: number }) { const sp = useApp((s) => s.trace.spans[id]); return sp ? <SpanRow sp={sp} /> : null; }

function SpanRow({ sp }: { sp: Span }) {
  const toggle = useApp((s) => s.toggleSpan);
  const autoId = useApp((s) => s.trace.autoOpenId);
  const open = sp.pinned ? sp.open : sp.open || autoId === sp.id;
  const badge = BADGE[sp.kind];
  return (
    <div className={cn('rounded-md', open && 'bg-bg/50')} style={{ marginLeft: Math.min(sp.depth, 4) * 14 }}>
      <button type="button" onClick={() => sp.hasDetail && toggle(sp.id)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-panel-2', !sp.hasDetail && 'cursor-default')}>
        <i className={cn('size-[7px] flex-none rounded-full', ST_C[sp.status] || 'bg-ink-3')} />
        {badge ? <span className={cn('inline-flex h-[17px] w-[56px] flex-none items-center justify-center rounded-sm bg-raise text-[9.5px] font-bold text-ink-2', sp.kind === 'code' && 'bg-l1/20 text-l1', sp.kind === 'jev' && 'bg-jev/20 text-jev', sp.kind === 'judge' && 'bg-ok/20 text-ok', sp.kind === 'approval' && 'bg-gate/20 text-gate', (sp.kind === 'version' || sp.kind === 'candidate' || sp.kind === 'qres') && 'bg-l3/20 text-l3', (sp.kind === 'tests' || sp.kind === 'heal') && 'bg-l2/20 text-l2')}>{badge}</span> : <span className="w-[56px] flex-none" />}
        {sp.actor && <span className="flex-none text-[12px] font-semibold text-ink-2">{sp.actor}</span>}
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', sp.status === 'bad' ? 'text-[#ffd6d4]' : sp.status === 'warn' ? 'text-[#ffe9c6]' : 'text-ink')}>{sp.title}</span>
        <span className="flex-none font-mono text-[10.5px] text-ink-3">{sp.meta ? `${sp.meta} · ` : ''}{hhmm(sp.vts)}</span>
        {sp.hasDetail && <span className="flex-none text-[10px] text-ink-3">{open ? '▾' : '▸'}</span>}
      </button>
      {open && sp.hasDetail && <div className="px-3 pb-3 pt-1"><SpanDetail sp={sp} /></div>}
      {sp.childIds.length > 0 && <div className="space-y-px">{sp.childIds.map((id) => <KidSpan key={id} id={id} />)}</div>}
    </div>
  );
}
