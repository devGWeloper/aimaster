// 포커스 카드 — 지금 일어난 한 가지를 크게: CodeAct 코드(타자) · Jev 확률 · Agent가 가져온 값 · judge_qual 판정 · 사람 승인 · 응답 · 버전 diff · 후보 채점 · 테스트
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '@/store/store';
import type { Focus } from '@/store/live';
import { AGENT_KO, LANE_KO, PM_KO, VKIND, agentKo } from '@/lib/ko';
import { hhmm, signed } from '@/lib/format';
import { cn } from '@/lib/utils';
import CodeView from '@/components/common/CodeView';
import JevBars from '@/components/common/JevBars';
import JudgeTable from '@/components/common/JudgeTable';
import Blocks from '@/components/common/Blocks';
import AgentResult from '@/components/common/AgentResult';
import TestList from '@/components/common/TestList';
import ApprovalCard from '@/components/common/ApprovalCard';
import Entities from '@/components/common/Entities';
import { Line } from '@/components/common/Section';

const LANE_C: Record<string, string> = { L1: 'l1', HEAL: 'l2', GROW: 'l2', L3: 'l3', '': 'ink' };

export default function FocusCard() {
  const f = useApp((s) => s.live.focus);
  const [tall, setTall] = useState(false);
  const live = !!f && !f.ev.backlog && Date.now() / 1000 - f.at < 40;
  return (
    <div className={cn('flex flex-col border-t border-line bg-panel transition-[height]', tall ? 'h-[56%]' : 'h-[300px]')}>
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
        {f ? (
          <>
            <span className={cn('inline-flex h-[20px] items-center rounded-full px-2 text-[10.5px] font-extrabold', `lane-${LANE_C[f.lane]} bg-[color-mix(in_oklab,var(--c)_22%,transparent)] text-[var(--c)]`)}>{LANE_KO[f.lane] || '시스템'}</span>
            <h2 className="truncate text-[13.5px] font-bold">{f.title}</h2>
            <span className="font-mono text-[11px] text-ink-3">{hhmm(f.vts)}</span>
          </>
        ) : <h2 className="text-[13.5px] font-bold text-ink-3">자세히 보기</h2>}
        <button type="button" className="ml-auto rounded p-1 text-ink-3 hover:bg-raise hover:text-ink" onClick={() => setTall((v) => !v)} aria-label="크기 조절">{tall ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {f ? <Body f={f} live={live} /> : <div className="pt-6 text-center text-[12px] text-ink-3">Agent가 코드를 쓰고, 확률로 판단하고, 값을 가져오고, 판정하고, 승인을 기다리는 순간마다 여기 자세히 나옵니다.</div>}
      </div>
    </div>
  );
}

function Body({ f, live }: { f: Focus; live: boolean }) {
  const ev = f.ev;
  const tests = useApp((s) => (f.key && s.live.tests[f.key]) || null);
  switch (f.kind) {
    case 'request': return <div className="text-[15px] font-semibold leading-relaxed">“{ev.text}”<div className="mt-2 text-[12px] font-normal text-ink-3">{ev.user || '엔지니어'} · {ev.request_id} · Super Agent가 요청을 해석하고 Jev로 편성을 결정합니다</div></div>;
    case 'parse': return <Entities en={ev.entities || {}} rtype={ev.rtype} detail={ev.detail} big />;
    case 'memory': return <div className="space-y-2 text-[12.5px]"><Line>장비 모델·PM 종류 정확 일치 조건으로 조회 (RAG 미사용, 리플레이 중에는 replay_clock 이전 기록만)</Line>{ev.memory?.lesson_ids?.length ? <div className="flex flex-wrap gap-1">{ev.memory.lesson_ids.map((x: string) => <span key={x} className="rounded bg-l3/20 px-2 py-0.5 font-mono text-[11px] text-[#d9d7ff]">{x}</span>)}</div> : <Line cls="muted">적용 교훈 없음</Line>}{ev.detail && <Line cls="muted">{ev.detail}</Line>}</div>;
    case 'jev': return <JevBars ev={ev} live={live} big />;
    case 'code': return <CodeView code={ev.code || ''} diff={!!ev.diff} live={live} pipe={ev.agent === 'super_agent' ? 'plan' : ev.agent === 'healer' ? (ev.diff ? 'patch' : 'diag') : ev.agent === 'factory' ? (/스키마/.test(ev.purpose || '') ? 'explore' : 'gen') : 'plan'} output={ev.output} maxHeight={9999} />;
    case 'agent': return <AgentResult D={{ start: ev, inputs: ev.inputs, summary: ev.summary, tools: ev.tools, error: ev.error, error_type: ev.error_type, violations: ev.violations, audit_id: ev.audit_id, status: ev.status, end: ev }} />;
    case 'judge': return <JudgeTable j={ev.judgement || {}} count={ev.count} big />;
    case 'approval': return <ApprovalCard apr={ev.action === 'requested' ? ev : { ...ev, payload: ev.payload || {} }} decided={ev.action === 'decided' ? ev : null} pending={ev.action === 'requested'} />;
    case 'response': return <Blocks blocks={ev.blocks || []} />;
    case 'version': return (
      <div className="space-y-2">
        <div className="flex items-baseline gap-3"><b className="font-mono text-[22px] font-extrabold text-l3">{ev.from_version || '—'} → {ev.to_version}</b><span className="text-[12px] text-ink-2">{VKIND[ev.kind] || ev.kind}{ev.ref ? ` · ${ev.ref}` : ''} · +{ev.diff_add || 0}/−{ev.diff_del || 0}</span></div>
        {ev.note && <Line>{ev.note}</Line>}
        {ev.diff && <CodeView code={ev.diff} diff maxHeight={9999} />}
      </div>
    );
    case 'candidate': return (
      <div className="space-y-2">
        <div className="flex items-baseline gap-3"><b className={cn('text-[20px] font-extrabold', ev.ok ? 'text-ok' : 'text-bad')}>{ev.ok ? '채택' : '기각'}</b><span className="text-[13px] font-semibold">{ev.cid} {ev.title}</span></div>
        <dl className="kv text-[12.5px]"><dt>계층</dt><dd>{ev.layer || '-'}</dd><dt>Evolve셋</dt><dd className="font-mono">{signed(ev.dE, '%p')}{ev.accE != null ? ` (${ev.accE}%)` : ''}</dd><dt>검증셋 (Held-out)</dt><dd className="font-mono">{signed(ev.dV, '%p')}{ev.accV != null ? ` (${ev.accV}%)` : ''}</dd></dl>
        <Line>{ev.reason}</Line>
        <Line cls="muted">채택 조건: Evolve셋 개선 ∧ Held-out 비하락. 채택·기각 모두 아카이브에 보관</Line>
      </div>
    );
    case 'tests': return tests ? <TestList cases={tests.cases} n={tests.n} fails={tests.fails} lane={tests.lane} /> : null;
    case 'fault': return <div className="space-y-1"><div className="text-[15px] font-bold text-bad">{ev.text}</div><Line cls="muted">현실의 변화를 흉내 낸 장애 주입. Agent가 "확인 불가"로 멈추고 L2 Heal로 스스로 고치는지 봅니다.</Line></div>;
    case 'thought': return <div className="text-[14px] font-semibold text-warn">{ev.text}</div>;
    case 'replay_case': { const c = ev.compare || {}, rec = ev.recommendation || {}, act = ev.actual || {}; return (
      <div className="space-y-1.5 text-[12.5px]">
        <div className="text-[14px] font-bold">{ev.chamber_id} {PM_KO[ev.pm_type] || ev.pm_type} — 과거 건 재생 (replay_clock 기준 데이터만)</div>
        <Line>추천 {rec.count ?? '-'}매 (필요 추정 {rec.required_est ?? '-'}) · 당시 실제 {act.n1}매 → 1차 {act.q1 === 'P' ? 'PASS' : 'FAIL'}</Line>
        <Line cls={c.pred_ok && c.judge_ok ? 'ok' : 'warn'}>1차 Pass 예측 {c.pred_ok ? '일치' : '불일치'} · judge_qual 판정 {c.judge_ok ? '일치' : '불일치'}</Line>
        {(rec.corrections || []).map((x: any) => <Line key={x.lesson_id}>{x.lesson_id} {x.amount > 0 ? '+' : ''}{x.amount}매 — {x.reason}</Line>)}
      </div>); }
    case 'replay_quarter': return (
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-3"><b className="font-mono text-[22px] font-extrabold text-l3">{ev.accuracy}%</b><span className="text-[12.5px] text-ink-2">{ev.quarter} 판정 일치율 · 추천 오차 ±{ev.rec_error}매 · 교훈 +{ev.new_lessons || 0} / 만료 {ev.expired_lessons || 0}</span></div>
        {(ev.events || []).length ? (ev.events as string[]).map((x, i) => <Line key={i}>{x}</Line>) : <Line cls="muted">{ev.split === 'heldout' ? 'Held-out: 진화 없이 평가만' : '진화 사건 없음'}</Line>}
      </div>
    );
    case 'report': return <ReportMini ev={ev} />;
    case 'registry': return <div className="space-y-1"><div className="text-[14px] font-bold">{agentKo(ev.agent_id)} — {VKIND[ev.event] || ev.event}</div><Line>{ev.note}</Line></div>;
    case 'spec': return <dl className="kv text-[12.5px]">{Object.entries(ev.spec || {}).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>)}</dl>;
    case 'ops': return <div className="space-y-1"><div className="text-[14px] font-bold">배경 운영 {ev.n}건 — {ev.label}</div><Line>{String(ev.start).slice(0, 16)} → {String(ev.end).slice(0, 16)} · 가상 엔지니어 요청 · Override 행동 · Qual 결과 · 교대 리더 승인이 경험 메모리에 쌓입니다</Line></div>;
    case 'policy': return <div className="space-y-1"><div className="text-[14px] font-bold text-gate">{ev.section}.{ev.key} = {String(ev.value)}</div><Line>{ev.approver}: {ev.reason}</Line><Line cls="muted">평가 기준·예산·임계값은 루프 밖에 고정. 사람만 바꿀 수 있습니다.</Line></div>;
    default: return <div className="space-y-1"><div className="text-[14px] font-semibold leading-relaxed">{ev.detail || f.title}</div>{ev.agent_id && <Line cls="muted">{AGENT_KO[ev.agent_id] || ev.agent_id}{ev.version ? ` ${ev.version}` : ''}</Line>}</div>;
  }
}

function ReportMini({ ev }: { ev: Focus['ev'] }) {
  const open = useApp((s) => s.openDrawer);
  const c = ev.content || {};
  const lines: string[] = [];
  if (ev.kind === 'heal') lines.push(`${c.agent_id} ${c.from_version} → ${c.to_version || '(미반영)'} · 유형 ${c.classification?.type} · ${c.status} · MTTR ${c.mttr}`, `원인: ${c.cause || '-'}`);
  if (ev.kind === 'grow') lines.push(...(c.lines || []).slice(0, 4));
  if (['evolve', 'rollback', 'retire'].includes(ev.kind)) lines.push(...(c.detect || []).slice(0, 3));
  return (
    <div className="space-y-2">
      {lines.map((x, i) => <Line key={i}>{x}</Line>)}
      <button type="button" className="rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-raise" onClick={() => open('report', ev.report_id)}>리포트 전문</button>
    </div>
  );
}
