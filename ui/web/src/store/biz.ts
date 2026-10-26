// AutoQual 업무 슬라이스 — PM Down → Qual 절차 → Seasoning 추천 → 측정 → Spec 판정 → 사람 승인 → UP (건별 단계 상태) + 처리 이력 + Fab 챔버 상태
import type { AnyEv, FabChamber } from '@/lib/types';
import { PM_KO, RTYPE_KO, agentKo } from '@/lib/ko';

export const STEPS = [['pm', 'PM 완료'], ['proc', 'Qual 절차'], ['reco', '매수 추천'], ['meas', 'Seasoning·측정'], ['judge', 'Spec 판정'], ['apr', '사람 승인'], ['up', 'UP']] as const;
export const STEPS_OTHER = [['parse', '요청 해석'], ['exec', 'Agent 편성·실행'], ['ans', '응답']] as const;
export type StepState = 'todo' | 'active' | 'wait' | 'done' | 'bad';
export interface Line { text: string; cls?: string }
export interface Qual {
  id: string; text: string; user: string; ts?: string; rtype: string | null; en: Record<string, any>; steps: Record<string, StepState>; lines: Record<string, Line[]>;
  attempts: { count?: number; result?: string; fail?: string[] }[]; alerts: Line[]; done: boolean; judge: any; judgeCount?: number; rec: { count: number | null; corrections: string[] } | null;
  meas: { text: string; live: boolean } | null; collapsed?: boolean;
}
export interface Case { id: string; request_id?: string; ts?: string; pm_end?: string; chamber_id?: string; pm_type?: string; eqp_model?: string; count?: number | null; corrections?: string[]; pass1?: boolean | null; fail_items?: string;
  attempts?: number; override?: any; engineer?: string; approver?: string; approved?: boolean; escalated?: boolean; versions?: Record<string, string>; base?: number; final_count?: number; final_pass?: boolean }
export interface BizState { quals: Record<string, Qual>; order: string[]; focus: string | null; cases: Case[]; caseIds: string[]; fab: Record<string, FabChamber>; aprMap: Record<string, string>; casesLoaded: boolean; reloadCases: number }
export const initialBiz = (): BizState => ({ quals: {}, order: [], focus: null, cases: [], caseIds: [], fab: {}, aprMap: {}, casesLoaded: false, reloadCases: 0 });

function qual(B: BizState, id: string, create = false): Qual | undefined {
  let q = B.quals[id];
  if (!q && create) {
    q = { id, text: '', user: '', rtype: null, en: {}, steps: {}, lines: {}, attempts: [], alerts: [], done: false, judge: null, rec: null, meas: null };
    B.quals[id] = q;
    B.order.push(id);
    if (B.order.length > 40) { const old = B.order.shift()!; delete B.quals[old]; }
  }
  return q;
}
function setStep(q: Qual, key: string, st: StepState, lines?: (Line | string | null)[]) {
  q.steps[key] = st;
  if (lines) q.lines[key] = lines.filter(Boolean).map((x) => (typeof x === 'string' ? { text: x } : x!));
}
export function addCase(B: BizState, c: Case) {
  const key = c.request_id || c.id;
  if (B.caseIds.includes(key)) return;
  B.caseIds.push(key);
  B.cases.unshift(c);
  if (B.cases.length > 400) B.cases.pop();
}

export function bizReduce(B: BizState, ev: AnyEv) {
  const rid: string | undefined = ev.request_id;
  switch (ev.type) {
    case 'fab': { const c = B.fab[ev.chamber_id] || { chamber_id: ev.chamber_id, state: 'RUN', since: '' }; B.fab[ev.chamber_id] = { ...c, state: ev.state, note: ev.note, since: ev.vts || '' }; break; }
    case 'request': {
      if (ev.source === 'sim' || !rid) break;
      const q = qual(B, rid, true)!;
      Object.assign(q, { text: ev.text, user: ev.user, ts: ev.vts, collapsed: false });
      B.focus = rid;
      break;
    }
    case 'node': onNode(B, ev); break;
    case 'response': onResponse(B, ev); break;
    case 'fab_progress': {
      const q = rid ? qual(B, rid) : undefined;
      if (!q) break;
      q.meas = { text: ev.text, live: !ev.backlog };
      setStep(q, 'meas', 'active', [{ text: `${ev.attempt}회차 · 가상 시각 ${String(ev.vts || '').slice(11, 16)} 시작`, cls: 'muted' }, ev.override ? { text: `엔지니어 Override: ${ev.override.count}매 (${ev.override.reason})`, cls: 'warn' } : null]);
      if (q.steps.judge) q.steps.judge = 'todo';
      break;
    }
    case 'judge': {
      const q = rid ? qual(B, rid) : undefined;
      if (!q) break;
      const j = ev.judgement || {};
      q.judge = j; q.judgeCount = ev.count;
      q.attempts.push({ count: ev.count, result: j.result, fail: j.fail_items });
      setStep(q, 'meas', 'done');
      setStep(q, 'judge', j.result === 'PASS' ? 'done' : j.result === 'FAIL' ? 'bad' : 'wait', []);
      if (j.result === 'PASS') setStep(q, 'apr', 'wait', [{ text: '사람(운영자) 승인 대기. 무승인 장비 상태 변경 0건', cls: 'gate' }]);
      break;
    }
    case 'approval': {
      if (ev.kind !== 'state_change') break;
      const key = ev.action === 'requested' ? (ev.payload || {}).request_id : B.aprMap[ev.request_id];
      const q = key ? qual(B, key) : undefined;
      if (!q) break;
      if (ev.action === 'requested') { B.aprMap[ev.request_id] = key; setStep(q, 'apr', 'wait', [{ text: `승인 요청 ${ev.request_id}: ${ev.title}`, cls: 'gate' }]); }
      else {
        setStep(q, 'apr', ev.approved ? 'done' : 'bad', [{ text: `${ev.approved ? '승인' : '반려'} — ${ev.approver}${ev.reason ? ` (${ev.reason})` : ''} · ${String(ev.vts || '').slice(11, 16)}`, cls: ev.approved ? 'ok' : 'bad' }]);
        if (!ev.approved) setStep(q, 'up', 'bad', ['상태 DOWN 유지. 반려 사유를 경험 메모리에 기록']);
      }
      break;
    }
    case 'thought': {
      const q = rid ? qual(B, rid) : undefined;
      if (q && ev.kind !== 'think') q.alerts.push({ text: ev.text, cls: ev.kind === 'warn' ? 'warn' : 'ask' });
      break;
    }
    case 'ops_case':
      addCase(B, { id: `ops:${ev.seq}`, request_id: ev.request_id, ts: ev.vts, pm_end: ev.vts, chamber_id: ev.chamber_id, pm_type: ev.pm_type, count: ev.count,
        pass1: ev.result === 'PASS' ? true : ev.result === 'FAIL' ? false : null, attempts: ev.attempts, override: ev.override, engineer: ev.engineer, approver: '교대 리더', approved: true });
      break;
    case 'ops_batch': if (ev.phase === 'end' && !ev.backlog) B.reloadCases += 1; break;
    case 'chapter': if (ev.phase === 'done' && !ev.backlog) B.reloadCases += 1; break;
    default: break;
  }
}

function onNode(B: BizState, ev: AnyEv) {
  if (ev.loop !== 'L1') {
    if (ev.loop === 'L2' && ev.request_id) {
      const q = qual(B, ev.request_id);
      if (!q) return;
      if (ev.node === 'start') q.alerts.push({ text: `${ev.sub === 'grow' ? 'Agent Factory' : 'Self-Healing'} 기동 — ${ev.detail}`, cls: 'l2' });
      if (ev.node === 'register_version' || ev.node === 'register_probation') q.alerts.push({ text: ev.detail, cls: 'ok' });
    }
    return;
  }
  const q = ev.request_id ? qual(B, ev.request_id) : undefined;
  if (!q) return;
  const n = ev.node;
  if (n === 'parse_request') {
    q.rtype = ev.rtype;
    q.en = ev.entities || {};
    const en = q.en;
    if (q.rtype === 'autoqual') {
      setStep(q, 'pm', 'done', [`${PM_KO[en.pm_type] || en.pm_type || 'PM'} ${en.pm_start ? `${String(en.pm_start).slice(5, 16)} ~ ${String(en.pm_end).slice(5, 16)}` : ''}`,
        (en.parts || []).length ? `교체 부품: ${en.parts.join(', ')}` : null, `장비 ${en.eqp_id} (${en.eqp_model} · ${en.eqp_group}) → 챔버 ${en.chamber_id} Down 상태`]);
      setStep(q, 'proc', 'active', []);
    } else {
      setStep(q, 'parse', 'done', [`${RTYPE_KO[q.rtype || ''] || q.rtype} — ${[en.eqp_id || en.eqp_prefix, en.chamber_id, en.pm_type ? PM_KO[en.pm_type] : null, en.lot].filter(Boolean).join(' · ')}`]);
      setStep(q, 'exec', 'active', []);
    }
  } else if (n === 'jev_route' && ev.route) {
    const key = q.rtype === 'autoqual' ? 'proc' : 'exec';
    const sel = (ev.route.selected || []).map((x: string) => agentKo(x)).join(' + ');
    q.lines[key] = [...(q.lines[key] || []), { text: `Agent 편성: ${sel}`, cls: 'muted' }];
  } else if (n === 'mark_unavailable') {
    q.alerts.push({ text: `사후 검증 실패 항목 "확인 불가" 표시 → ${ev.detail}`, cls: 'warn' });
  } else if (n === 'rework_plan') {
    q.lines.judge = [...(q.lines.judge || []), { text: `재작업 계획: ${ev.detail}`, cls: 'warn' }];
    setStep(q, 'meas', 'active');
  } else if (n === 'apply_state_change') {
    const ok = !/반려/.test(ev.detail);
    setStep(q, 'up', ok ? 'done' : 'bad', [{ text: ev.detail, cls: ok ? 'ok' : 'bad' }]);
  } else if (n === 'log_experience') {
    q.done = true;
    if (q.rtype === 'autoqual' && q.attempts.length) {
      const first = q.attempts[0];
      addCase(B, { id: q.id, request_id: q.id, ts: ev.vts, pm_end: q.en.pm_end, chamber_id: q.en.chamber_id, pm_type: q.en.pm_type, count: q.rec?.count,
        corrections: q.rec?.corrections || [], pass1: first.result === 'PASS', fail_items: (first.fail || []).join(','), attempts: q.attempts.length,
        approver: (q.lines.apr?.[0]?.text || '').match(/— ([^(·]+)/)?.[1]?.trim() || '운영자', approved: q.steps.up === 'done', escalated: q.steps.up !== 'done' && q.attempts.length >= 3 });
    }
  }
}
function onResponse(B: BizState, ev: AnyEv) {
  const q = ev.request_id ? qual(B, ev.request_id) : undefined;
  if (!q) return;
  const auto = q.rtype === 'autoqual';
  for (const b of ev.blocks || []) {
    const k = b.kind;
    if (k === 'procedure' && auto) setStep(q, 'proc', 'done', [...(q.lines.proc || []).filter((x) => x.cls === 'muted'), ...b.lines.map((x: string) => ({ text: x, cls: b.warn ? 'warn' : '' }))]);
    if ((k === 'chamber' || k === 'history' || k === 'trend' || k === 'part') && auto) q.lines.reco = [...(q.lines.reco || []), { text: `${String(b.title).split(' · ')[0]}: ${b.lines[0] || ''}`, cls: b.warn ? 'warn' : 'muted' }];
    if (k === 'recommendation' && auto) {
      const m = /Seasoning (\d+)매/.exec(b.lines.join(' '));
      q.rec = { count: b.count ?? (m ? Number(m[1]) : null), corrections: (b.lines.join(' ').match(/L-\d{4}/g) || []) };
      setStep(q, 'reco', b.warn ? 'bad' : 'done', [...(q.lines.reco || []), ...b.lines.map((x: string) => ({ text: x, cls: b.warn ? 'warn' : '' }))]);
      if (!b.warn) setStep(q, 'meas', 'wait', [{ text: 'Mock Fab이 Seasoning·측정을 수행하면 측정값이 들어옵니다 (채팅으로 직접 입력도 가능)', cls: 'muted' }]);
    }
    if (k === 'ask') { q.alerts.push({ text: b.lines[0], cls: 'ask' }); q.done = true; }
    if (k === 'grow') q.alerts.push({ text: `${b.title}: ${b.lines[0] || ''}`, cls: b.warn ? 'bad' : 'l2' });
    if (k === 'rework') q.lines.judge = [...(q.lines.judge || []), ...b.lines.map((x: string) => ({ text: x, cls: 'warn' }))];
    if (k === 'escalate') { setStep(q, 'up', 'bad', b.lines.map((x: string) => ({ text: x, cls: 'bad' }))); q.done = true; }
    if (!auto && ['analysis', 'trend', 'history', 'procedure', 'judgement', 'chamber'].includes(k)) {
      setStep(q, 'exec', 'done');
      setStep(q, 'ans', b.warn ? 'bad' : 'done', [...(q.lines.ans || []), ...b.lines.slice(0, 5).map((x: string) => ({ text: x, cls: b.warn ? 'warn' : '' }))]);
      if (k === 'judgement') q.done = true;
    }
    if (k === 'routing' && !auto) q.lines.exec = [...(q.lines.exec || []), ...b.lines.slice(0, 1).map((x: string) => ({ text: x, cls: 'muted' }))];
  }
  if (!auto && ev.rtype && ev.rtype !== 'autoqual' && !['rework', 'state', 'judge'].includes(ev.rtype)) q.done = true;
}
