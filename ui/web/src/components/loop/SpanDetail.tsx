// span 상세 — kind 별 렌더러 (코드·Jev·Agent 값·판정·승인·응답·테스트·후보·버전·리포트·리플레이)
import type { Span } from '@/store/trace';
import { useApp } from '@/store/store';
import { PM_KO } from '@/lib/ko';
import { signed } from '@/lib/format';
import CodeView from '@/components/common/CodeView';
import JevBars, { RouteBars } from '@/components/common/JevBars';
import JudgeTable from '@/components/common/JudgeTable';
import Blocks from '@/components/common/Blocks';
import AgentResult from '@/components/common/AgentResult';
import TestList from '@/components/common/TestList';
import ApprovalCard from '@/components/common/ApprovalCard';
import Entities from '@/components/common/Entities';
import { Line } from '@/components/common/Section';

export default function SpanDetail({ sp }: { sp: Span }) {
  const D = sp.data;
  const open = useApp((s) => s.openDrawer);
  const live = !D.backlog;
  switch (sp.kind) {
    case 'code': return <CodeView code={D.code || ''} diff={!!D.diff} live={live && !D.done} pipe={D.pipe} output={D.output} />;
    case 'jev': return <JevBars ev={D.ev} live={live} />;
    case 'route': return <RouteBars route={D.route} />;
    case 'agent': return <AgentResult D={D} />;
    case 'judge': return <JudgeTable j={D.judgement} count={D.count} />;
    case 'approval': return <ApprovalCard apr={D.apr} decided={D.decided} pending={D.pending} />;
    case 'response': return <Blocks blocks={D.blocks || []} compact />;
    case 'tests': return <TestList cases={D.cases} n={D.n} fails={D.fails} lane={sp.runKey.startsWith('HEAL') ? 'HEAL' : 'GROW'} />;
    case 'parse': return <Entities en={D.ev?.entities || {}} rtype={D.ev?.rtype} detail={D.ev?.detail} />;
    case 'memory': { const m = D.ev?.memory; return <div className="space-y-1.5"><Line cls="muted">장비 모델·PM 종류 정확 일치 조건으로 조회 (RAG 미사용, 리플레이 중에는 replay_clock 이전 기록만)</Line>{m?.lesson_ids?.length ? <div className="flex flex-wrap gap-1">{m.lesson_ids.map((x: string) => <span key={x} className="rounded bg-l3/20 px-2 py-0.5 font-mono text-[11px] text-[#d9d7ff]">{x}</span>)}</div> : <Line cls="muted">적용 교훈 없음</Line>}</div>; }
    case 'spec': return <dl className="kv text-[12px]">{Object.entries(D.ev?.spec || {}).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>)}</dl>;
    case 'thought': return <Line>{D.text}</Line>;
    case 'fab': { const ev = D.ev; return <div className="space-y-1"><Line>{ev.chamber_id} · {ev.attempt}회차 · Seasoning {ev.count}매 · 소요 약 {Math.floor((ev.minutes || 0) / 60)}시간 {(ev.minutes || 0) % 60}분 (가상 시각 진행)</Line>{ev.override && <Line cls="warn">엔지니어 Override: {ev.override.count}매 — 사유 "{ev.override.reason}" (경험 메모리에 기록 → L3 학습 재료)</Line>}</div>; }
    case 'candidate': { const ev = D.ev; return <div className="space-y-1.5"><dl className="kv text-[12px]"><dt>계층</dt><dd>{ev.layer || '-'}</dd><dt>Evolve셋</dt><dd className="font-mono">{signed(ev.dE, '%p')}{ev.accE != null ? ` (${ev.accE}%)` : ''}</dd><dt>검증셋 (Held-out)</dt><dd className="font-mono">{signed(ev.dV, '%p')}{ev.accV != null ? ` (${ev.accV}%)` : ''}</dd></dl><Line>{ev.reason}</Line></div>; }
    case 'version': return <div className="space-y-2">{D.note && <Line>{D.note}</Line>}{D.diff && <CodeView code={D.diff} diff />}</div>;
    case 'report': return <div className="space-y-2"><ReportLines kind={D.kind} c={D.content || {}} /><button type="button" className="rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-raise" onClick={() => open('report', D.report_id)}>리포트 전문</button></div>;
    case 'ops': { const ev = D.ev; return <div className="space-y-1"><Line>{ev.chamber_id} · {PM_KO[ev.pm_type] || ev.pm_type} · 추천 {ev.count}매 · 1차 {ev.result || '-'} · 시도 {ev.attempts}회 · 요청 {ev.request_id}</Line>{ev.override && <Line cls="warn">Override {ev.override.count}매 — {ev.override.reason}</Line>}</div>; }
    case 'rcase': { const ev = D.done; if (!ev) return null; const rec = ev.recommendation || {}, act = ev.actual || {}; return <div className="space-y-1"><Line>필요 추정 {rec.required_est ?? '-'}매 · 당시 실제 {act.n1}매 → 1차 {act.q1 === 'P' ? 'PASS' : 'FAIL'} · Time-Travel Guard: replay_clock 이후 데이터 차단</Line>{(rec.corrections || []).map((x: any) => <Line key={x.lesson_id}>{x.lesson_id} {x.amount > 0 ? '+' : ''}{x.amount}매 — {x.reason}</Line>)}</div>; }
    case 'qres': { const ev = D.ev; return <div className="space-y-1">{(ev.events || []).length ? ev.events.map((x: string, i: number) => <Line key={i}>{x}</Line>) : <Line cls="muted">{ev.split === 'heldout' ? 'Held-out — 진화 없이 평가만' : '진화 사건 없음'}</Line>}</div>; }
    default: return D.ev?.detail ? <Line>{D.ev.detail}</Line> : null;
  }
}

function ReportLines({ kind, c }: { kind: string; c: any }) {
  const lines: string[] = [];
  if (kind === 'heal') lines.push(`${c.agent_id} ${c.from_version} → ${c.to_version || '(미반영)'} · 유형 ${c.classification?.type} · ${c.status} · MTTR ${c.mttr}`, `원인: ${c.cause || '-'}`);
  if (kind === 'grow') lines.push(...(c.lines || []).slice(0, 4));
  if (['evolve', 'rollback', 'retire'].includes(kind)) lines.push(...(c.detect || []).slice(0, 3));
  return <>{lines.map((x, i) => <Line key={i}>{x}</Line>)}</>;
}
