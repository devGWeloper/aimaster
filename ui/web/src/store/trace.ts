// 트레이스 슬라이스 — Agent가 한 모든 일을 런(요청·Heal·Grow·진화·배경 운영·리플레이) 단위로 묶어 남긴다.
//   span = 누가(actor) · 무엇을(title) · 결과(status) + 펼치면 나오는 원본 데이터(kind별 렌더러가 해석)
import type { AnyEv } from '@/lib/types';
import { AGENT_KO, BAD, NODE_KO, PM_KO, RTYPE_KO, STATUS_KO, VKIND, actorKo, agentKo, runTitle, short } from '@/lib/ko';
import { laneOf } from './live';

export type TLane = 'L1' | 'HEAL' | 'GROW' | 'L3' | 'OPS' | 'REPLAY' | 'SYS';
export type SpanKind = 'q' | 'node' | 'code' | 'jev' | 'agent' | 'sandbox' | 'judge' | 'approval' | 'tests' | 'version' | 'candidate' | 'response' | 'fab' | 'memory' | 'thought'
  | 'report' | 'route' | 'parse' | 'state' | 'wait' | 'observe' | 'heal' | 'spec' | 'ops' | 'rcase' | 'qres' | 'quarter' | 'registry' | 'redirect' | 'shadow' | 'note';
export type SpanStatus = 'ok' | 'bad' | 'warn' | 'wait' | 'run' | 'ver' | 'gone';
export interface Span {
  id: number; runKey: string; kind: SpanKind; actor: string; title: string; status: SpanStatus; vts?: string; meta: string; depth: number; parentId: number | null; childIds: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>; hasDetail: boolean; pinned: boolean; open: boolean;
}
export interface Run {
  key: string; lane: TLane; title: string; sub: string; status: string; statusCls: string; meta: string; parentKey: string | null; childKeys: string[]; open: boolean; active: boolean;
  spanIds: number[]; t0?: string; pendingCodeId: number | null; pendingNodeId: number | null; sandboxId: number | null; agentOpen: Record<string, number>; agentByKey: Record<string, number>; vts?: string;
}
export interface Mark { id: number; cls: string; text: string; vts?: string }
export interface TraceState { runs: Record<string, Run>; order: (string | { mark: number })[]; spans: Record<number, Span>; marks: Record<number, Mark>; apr: Record<string, number>; tests: Record<string, number>;
  lastL1: string | null; lastL3: string | null; ops: string | null; replay: string | null; autoOpenId: number | null; nspan: number; nmark: number }
export const initialTrace = (): TraceState => ({ runs: {}, order: [], spans: {}, marks: {}, apr: {}, tests: {}, lastL1: null, lastL3: null, ops: null, replay: null, autoOpenId: null, nspan: 0, nmark: 0 });

const AUTO_OPEN = new Set(['code', 'jev', 'agent', 'response', 'judge', 'approval', 'version', 'candidate', 'tests', 'parse', 'route', 'spec', 'rcase', 'qres', 'report']);
const CODE_NODES = new Set(['plan_codeact', 'rework_plan', 'diagnose_codeact', 'write_patch', 'explore_schema', 'generate_code_and_tests']);
const HIDE_NODES = new Set(['synthesize', 'respond', 'deterministic_judge', 'approval_gate', 'jev_route', 'jev_classify_error', 'jev_need_evolve', 'jev_need_grow', 'jev_need_retire', 'jev_need_merge']);
const laneRun = (ev: AnyEv): [TLane | null, string | null] => (ev.heal_id ? ['HEAL', ev.heal_id] : ev.grow_id ? ['GROW', ev.grow_id] : ev.run_id ? ['L3', ev.run_id] : ev.request_id ? ['L1', ev.request_id] : [null, null]);
const keyOf = (ev: AnyEv): string | null => ev.heal_id || ev.grow_id || ev.run_id || ev.request_id || null;

function run(T: TraceState, key: string, lane: TLane, title: string, sub: string, parentKey: string | null = null): Run {
  let r = T.runs[key];
  if (r) return r;
  const parent = parentKey ? T.runs[parentKey] : null;
  r = { key, lane, title, sub, status: '진행 중', statusCls: 'run', meta: '', parentKey: parent ? parent.key : null, childKeys: [], open: true, active: true, spanIds: [], pendingCodeId: null, pendingNodeId: null, sandboxId: null, agentOpen: {}, agentByKey: {} };
  T.runs[key] = r;
  if (parent) parent.childKeys.push(key); else T.order.push(key);
  trim(T);
  return r;
}
function trim(T: TraceState) {
  const keys = T.order.filter((x) => typeof x === 'string') as string[];
  while (keys.length > 90) {
    const k = keys.shift()!;
    const r = T.runs[k];
    if (!r) continue;
    const drop = (rr: Run) => { for (const id of rr.spanIds) delete T.spans[id]; for (const ck of rr.childKeys) { const c = T.runs[ck]; if (c) drop(c); delete T.runs[ck]; } };
    drop(r);
    delete T.runs[k];
    T.order.splice(T.order.indexOf(k), 1);
  }
}
function setStatus(r: Run, status: string, cls = '') { r.status = status; r.statusCls = cls; if (cls && cls !== 'run') r.active = false; }
function span(T: TraceState, r: Run, o: { kind?: SpanKind; actor?: string; title?: string; status?: SpanStatus; vts?: string; depth?: number; parentId?: number | null; bad?: boolean; data?: Record<string, unknown>; hasDetail?: boolean; meta?: string }): Span {
  T.nspan += 1;
  const sp: Span = { id: T.nspan, runKey: r.key, kind: o.kind || 'node', actor: o.actor || '', title: o.title || '', status: o.bad ? 'bad' : (o.status || 'ok'), vts: o.vts, meta: o.meta ?? '', depth: o.depth || 0, parentId: o.parentId ?? null, childIds: [], data: o.data || {}, hasDetail: !!o.hasDetail, pinned: false, open: false };
  T.spans[sp.id] = sp;
  r.spanIds.push(sp.id);
  if (sp.parentId != null && T.spans[sp.parentId]) T.spans[sp.parentId].childIds.push(sp.id);
  return sp;
}
function update(sp: Span, o: { title?: string; status?: SpanStatus; actor?: string; meta?: string; data?: Record<string, unknown>; hasDetail?: boolean }) {
  if (o.title != null) sp.title = o.title;
  if (o.actor != null) sp.actor = o.actor;
  if (o.status) sp.status = o.status;
  if (o.meta != null) sp.meta = o.meta;
  if (o.data) Object.assign(sp.data, o.data);
  if (o.hasDetail) sp.hasDetail = true;
}
function autoOpen(T: TraceState, sp: Span, ev: AnyEv) {
  if (!sp.hasDetail || ev.backlog) { if (ev.backlog && sp.hasDetail && AUTO_OPEN.has(sp.kind)) T.autoOpenId = sp.id; return; }
  T.autoOpenId = sp.id;
}
function mark(T: TraceState, cls: string, text: string, ev: AnyEv) {
  T.nmark += 1;
  T.marks[T.nmark] = { id: T.nmark, cls, text, vts: ev.vts };
  T.order.push({ mark: T.nmark });
}
function sysRun(T: TraceState): Run {
  let r = T.runs.registry;
  const idx = T.order.indexOf('registry');
  if (!r || idx < T.order.length - 12) {
    if (r) { T.order.splice(idx, 1); delete T.runs.registry; }
    r = run(T, 'registry', 'SYS', 'Registry · 버전 반영', '');
  }
  return r;
}
function replayRun(T: TraceState): Run {
  const r = T.runs.replay || run(T, 'replay', 'REPLAY', '이력 리플레이 — 과거 Qual 이력 시간순 재생 (Walk-forward 진화 · Time-Travel Guard)', '');
  T.replay = r.key;
  return r;
}
function getRun(T: TraceState, ev: AnyEv): Run | null {
  const [lane, key] = laneRun(ev);
  if (!key || !lane) return null;
  let r = T.runs[key];
  if (!r) {
    const replayActive = T.replay && T.runs[T.replay]?.active ? 'replay' : null;
    if (lane === 'L1') {
      const bg = T.ops && T.runs[T.ops]?.active ? T.ops : null;
      r = run(T, key, key.startsWith('RP') ? 'REPLAY' : 'L1', bg ? `배경 요청 ${key} — 복구 후 재분석·추가 응답` : `요청 ${key}`, '', replayActive || bg);
      if (!bg) T.lastL1 = r.key;
    } else if (lane === 'L3') { r = run(T, key, 'L3', runTitle(key), '', replayActive); T.lastL3 = r.key; }
    else r = run(T, key, lane, key, '', ev.request_id || null);
  }
  return r;
}
function sandboxBox(T: TraceState, r: Run, ev: AnyEv): Span {
  const box = span(T, r, { kind: 'sandbox', actor: 'Sandbox', title: '샌드박스 실행 — 계획 코드가 하위 Agent를 호출합니다 (허용 import · 권한 프록시 · 감사 로그)', vts: ev.vts, status: 'run', data: { backlog: ev.backlog } });
  r.sandboxId = box.id;
  return box;
}

function onNode(T: TraceState, ev: AnyEv) {
  const lane = laneOf(ev);
  const key = keyOf(ev);
  if (!lane || !key) return;
  let r = T.runs[key];
  const B = { backlog: ev.backlog };
  const replayActive = T.replay && T.runs[T.replay]?.active ? 'replay' : null;
  if (!r) {
    if (lane === 'HEAL') r = run(T, key, 'HEAL', `${agentKo(ev.agent_id)} ${ev.version || ''} 자가 복구 (Self-Healing)`, '', ev.request_id || null);
    else if (lane === 'GROW') r = run(T, key, 'GROW', `새 Agent 생성 (Agent Factory)${ev.agent_id ? ` — ${agentKo(ev.agent_id)}` : ''}`, '', ev.request_id || null);
    else if (lane === 'L3') r = run(T, key, 'L3', runTitle(key), '', replayActive);
    else r = run(T, key, key.startsWith('RP') ? 'REPLAY' : 'L1', `요청 ${key}`, '', replayActive);
  }
  if (lane === 'L1') T.lastL1 = r.key;
  if (lane === 'L3') { T.lastL3 = r.key; r.active = true; }
  if (lane === 'GROW' && ev.agent_id && !r.title.includes(ev.agent_id) && !r.title.includes(AGENT_KO[ev.agent_id] || '∅')) r.title += ` — ${agentKo(ev.agent_id)}`;
  const bad = !!BAD[ev.node]?.test(ev.detail || '');
  const n: string = ev.node;
  const actor = lane === 'HEAL' ? 'Healer' : lane === 'GROW' ? 'Agent Factory' : lane === 'L3' ? 'Evolver' : 'Super Agent';
  if (HIDE_NODES.has(n) && !(n === 'jev_classify_error' && /에스컬레이션/.test(ev.detail || ''))) {
    if (n === 'jev_route' && ev.route) {
      const sp = span(T, r, { kind: 'route', actor: 'Super Agent', title: `Agent 편성 → ${(ev.route.selected || []).map((x: string) => agentKo(x)).join(' + ') || '-'}`, vts: ev.vts, data: { ...B, route: ev.route }, hasDetail: true });
      autoOpen(T, sp, ev);
    }
    return;
  }
  if (CODE_NODES.has(n)) {
    const pend = r.pendingCodeId != null ? T.spans[r.pendingCodeId] : null;
    if (pend && !pend.data.node) { update(pend, { title: `${pend.title} — ${ev.detail}`, data: { node: n } }); r.pendingCodeId = null; return; }
    const sp = span(T, r, { kind: 'node', actor, title: ev.detail, vts: ev.vts, bad, data: { ...B, node: n, awaitCode: true } });
    r.pendingNodeId = sp.id;
    return;
  }
  if (n === 'execute_sandbox') {
    const box = r.sandboxId != null && T.spans[r.sandboxId] && !T.spans[r.sandboxId].data.closed ? T.spans[r.sandboxId] : sandboxBox(T, r, ev);
    const runs = ev.runs || [];
    const fails = runs.filter((x: AnyEv) => !x.ok).length;
    update(box, { title: `${ev.detail}${fails ? ` · 실패 ${fails}건` : ''}`, status: fails ? 'warn' : 'ok', data: { closed: true } });
    r.sandboxId = null;
    for (const id of r.spanIds) { const sp = T.spans[id]; if (sp && sp.kind === 'code' && sp.data.pipe) sp.data.done = fails ? 'bad' : 'ok'; }
    return;
  }
  const KIND: Record<string, SpanKind> = { parse_request: 'parse', retrieve_memory: 'memory', log_experience: 'memory', observe: 'observe', mark_unavailable: 'heal', await_qual_result: 'wait',
    apply_state_change: 'state', write_spec: 'spec', start: 'node', escalate_operator: 'node', abort_with_reason: 'node' };
  const kind = KIND[n] || 'node';
  let title = ev.detail || NODE_KO[n] || n;
  let hasDetail = false;
  if (n === 'parse_request') {
    const en = ev.entities || {};
    title = `요청 해석 → ${RTYPE_KO[ev.rtype] || ev.rtype || ''} · ${en.chamber_id || en.eqp_id || en.eqp_prefix || ''}${en.pm_type ? ` · ${PM_KO[en.pm_type] || en.pm_type}` : ''}`;
    hasDetail = true;
  } else if (n === 'retrieve_memory' && ev.memory) hasDetail = true;
  else if (n === 'write_spec' && ev.spec) hasDetail = true;
  else if (n === 'start') title = ev.detail;
  else if (ev.detail && ev.detail.length > 110) hasDetail = true;
  if (n === 'start' && lane === 'HEAL') setStatus(r, '복구 중', 'run');
  if (n === 'start' && lane === 'GROW') setStatus(r, '생성 중', 'run');
  const sp = span(T, r, { kind, actor, title, vts: ev.vts, bad, status: n === 'await_qual_result' || n === 'mark_unavailable' ? 'wait' : bad ? 'bad' : 'ok', hasDetail, data: { ...B, node: n, ev } });
  if (n === 'mark_unavailable') sp.status = 'warn';
  if (['parse_request', 'write_spec'].includes(n)) autoOpen(T, sp, ev);
  if (n === 'register_version') setStatus(r, `복구 완료 → ${String(ev.detail).match(/→ ([\d.]+)/)?.[1] || ''}`, 'done');
  if (n === 'escalate_operator') setStatus(r, '중단 → 운영자', 'bad');
  if (n === 'register_probation') setStatus(r, 'probation 등록', 'done');
  if (n === 'abort_with_reason') setStatus(r, '생성 중단', 'bad');
  if (n === 'log_experience') { setStatus(r, '완료', 'done'); r.active = false; }
  if (n === 'compare_actual') { setStatus(r, '채점 완료', 'done'); r.active = false; }
  if (n === 'apply_state_change') update(sp, { status: /반려/.test(ev.detail) ? 'bad' : 'ok' });
  if (lane === 'L3' && ['promote', 'archive', 'auto_rollback'].includes(n)) setStatus(r, n === 'auto_rollback' ? '자동 롤백' : '완료', n === 'auto_rollback' ? 'bad' : 'done');
}

export function traceReduce(T: TraceState, ev: AnyEv) {
  const B = { backlog: ev.backlog };
  switch (ev.type) {
    case 'chapter':
      if (ev.phase !== 'start') break;
      mark(T, 'chapter', `${ev.title} · ${ev.date}`, ev);
      if (T.replay && T.runs[T.replay]) T.runs[T.replay].active = false;
      T.lastL3 = null;
      break;
    case 'story': {
      const cls = ({ done: 'done', warn: 'warn', error: 'bad', approval: 'gate', ops: 'ops' } as Record<string, string>)[ev.level] || '';
      if (T.ops && T.runs[T.ops]?.active && ev.level === 'ops') break;
      mark(T, `story ${cls}`, ev.text, ev);
      break;
    }
    case 'fault': mark(T, 'fault', ev.text, ev); break;
    case 'policy': mark(T, 'gate', `평가 기준 변경(사람만 가능): ${ev.section}.${ev.key} = ${ev.value} — ${ev.approver}: ${ev.reason}`, ev); break;
    case 'request': {
      if (ev.source === 'sim') break;
      const r = run(T, ev.request_id, 'L1', ev.text, `${ev.user || '엔지니어'}`);
      r.t0 = ev.vts; r.vts = ev.vts;
      T.lastL1 = r.key;
      span(T, r, { kind: 'q', actor: ev.user || '엔지니어', title: ev.text, vts: ev.vts, data: B });
      break;
    }
    case 'node': onNode(T, ev); break;
    case 'code': {
      const r = getRun(T, ev);
      if (!r) break;
      const kind = ev.agent === 'super_agent' ? 'plan' : ev.agent === 'healer' ? (ev.diff ? 'patch' : 'diag') : ev.agent === 'factory' ? (/스키마/.test(ev.purpose || '') ? 'explore' : 'gen') : 'plan';
      const actor = actorKo(ev.agent);
      const model = ev.model ? `${ev.model}${ev.source && ev.source !== 'online' ? ' · 오프라인 Playbook' : ''}` : (ev.template_id ? `편성 템플릿 ${ev.template_id} (LLM 생략)` : '');
      const title = `${ev.purpose || 'CodeAct'}${model ? ` · ${model}` : ''}`;
      const lines = String(ev.code || '').split('\n').length;
      const pend = r.pendingNodeId != null ? T.spans[r.pendingNodeId] : null;
      let sp: Span;
      if (pend && pend.data.awaitCode && !pend.data.code) {
        sp = pend;
        sp.kind = 'code';
        update(sp, { title: `${pend.title} — ${title}`, actor, data: { code: ev.code, diff: !!ev.diff, output: ev.output, pipe: kind, node: pend.data.node, awaitCode: false }, hasDetail: true });
        r.pendingNodeId = null;
      } else {
        sp = span(T, r, { kind: 'code', actor, title: `${title} · ${lines} lines`, vts: ev.vts, hasDetail: true, data: { ...B, code: ev.code, diff: !!ev.diff, output: ev.output, pipe: kind } });
        r.pendingCodeId = sp.id;
      }
      sp.meta = `${lines}줄`;
      autoOpen(T, sp, ev);
      break;
    }
    case 'jev': {
      const r = getRun(T, ev) || (T.lastL3 ? T.runs[T.lastL3] : null) || sysRun(T);
      const sel = Array.isArray(ev.answer) ? ev.answer : [ev.answer];
      const ans = sel.map((x: string) => AGENT_KO[x] || x).join(', ');
      const top = Math.max(...Object.values((ev.probs || { a: 0 }) as Record<string, number>));
      const sp = span(T, r, { kind: 'jev', actor: 'Jev', title: `${ev.question || ev.head} → ${ans || '-'} (p=${top.toFixed(2)}${ev.threshold ? `, 자율 ≥${ev.threshold}` : ''})`, vts: ev.vts, hasDetail: true, data: { ...B, ev } });
      autoOpen(T, sp, ev);
      break;
    }
    case 'agent_start': {
      const r = getRun(T, ev) || (T.lastL1 ? T.runs[T.lastL1] : null);
      if (!r) break;
      const key = `${ev.agent_id}:${ev.action}:${ev.indirect ? ev.caller : ''}`;
      let parent: Span | null = null;
      if (ev.indirect && ev.caller && r.agentOpen[ev.caller] != null) parent = T.spans[r.agentOpen[ev.caller]] || null;
      else { if (r.sandboxId == null || !T.spans[r.sandboxId] || T.spans[r.sandboxId].data.closed) sandboxBox(T, r, ev); parent = T.spans[r.sandboxId!]; }
      const inputs = ev.inputs || {};
      const where = inputs.chamber_id || inputs.eqp_id || inputs.eqp_prefix || inputs.lot || '';
      const sp = span(T, r, { kind: 'agent', actor: `${agentKo(ev.agent_id)} ${ev.version}`, title: `${ev.action}(${where}) 실행 중…`, vts: ev.vts, status: 'run', parentId: parent?.id ?? null,
        depth: (parent?.depth || 0) + 1, data: { ...B, agent_id: ev.agent_id, inputs, tools_allowed: ev.tools_allowed, start: ev } });
      r.agentOpen[ev.agent_id] = sp.id;
      r.agentByKey[key] = sp.id;
      break;
    }
    case 'agent_end': {
      const r = getRun(T, ev) || (T.lastL1 ? T.runs[T.lastL1] : null);
      if (!r) break;
      const key = `${ev.agent_id}:${ev.action}:${ev.indirect ? ev.caller : ''}`;
      let sp = r.agentByKey[key] != null ? T.spans[r.agentByKey[key]] : undefined;
      if (!sp) {
        const parent = (r.sandboxId == null || !T.spans[r.sandboxId] || T.spans[r.sandboxId].data.closed) ? sandboxBox(T, r, ev) : T.spans[r.sandboxId];
        sp = span(T, r, { kind: 'agent', actor: `${agentKo(ev.agent_id)} ${ev.version}`, title: '', vts: ev.vts, parentId: parent.id, depth: 1, data: { ...B, agent_id: ev.agent_id, inputs: ev.inputs } });
      }
      delete r.agentByKey[key];
      if (r.agentOpen[ev.agent_id] === sp.id) delete r.agentOpen[ev.agent_id];
      const sum: string[] = ev.summary || [];
      const head = ev.ok ? (sum[0] || `status=${ev.status || 'ok'}`) : `✗ ${ev.error_type || '오류'}: ${String(ev.error || '').slice(0, 90)}`;
      const nTools = (ev.tools || []).reduce((a: number, x: AnyEv) => a + (x.n || 0), 0);
      update(sp, { title: `${ev.action} → ${head}`, status: ev.ok ? 'ok' : 'bad', meta: `도구 ${nTools}회 · ${Math.round(ev.io_ms || 0)}ms`, hasDetail: true,
        data: { end: ev, summary: sum, tools: ev.tools, error: ev.error, error_type: ev.error_type, violations: ev.violations, audit_id: ev.audit_id, status: ev.status } });
      if (!ev.ok || sum.length) autoOpen(T, sp, ev);
      break;
    }
    case 'thought': {
      const r = getRun(T, ev);
      if (!r) break;
      span(T, r, { kind: 'thought', actor: actorKo(ev.agent), title: ev.text, vts: ev.vts, bad: ev.kind === 'warn', status: ev.kind === 'ask' ? 'wait' : 'ok', hasDetail: String(ev.text).length >= 120, data: { ...B, text: ev.text } });
      break;
    }
    case 'response': {
      const r = getRun(T, ev);
      if (!r) break;
      const rt = RTYPE_KO[ev.rtype] || ev.rtype || '';
      const warn = (ev.blocks || []).some((b: AnyEv) => b.warn);
      const sp = span(T, r, { kind: 'response', actor: 'Super Agent', title: `응답 — ${rt}${ev.latency_ms ? ` · 가상 응답 ${(ev.latency_ms / 1000).toFixed(1)}s` : ''}`, vts: ev.vts, status: warn ? 'warn' : 'ok', hasDetail: true, data: { ...B, blocks: ev.blocks || [] } });
      if (ev.rtype !== 'rework') autoOpen(T, sp, ev);
      break;
    }
    case 'fab_progress': {
      const r = getRun(T, ev);
      if (!r) break;
      span(T, r, { kind: 'fab', actor: 'Mock Fab', title: ev.text, vts: ev.vts, status: ev.override ? 'warn' : 'ok', hasDetail: true, data: { ...B, ev } });
      break;
    }
    case 'judge': {
      const r = getRun(T, ev);
      if (!r) break;
      const j = ev.judgement || {};
      const sp = span(T, r, { kind: 'judge', actor: 'judge_qual', title: `Spec 판정 → ${j.result}${j.fail_items?.length ? ` (${j.fail_items.join(', ')})` : ''} — 결정적 코드, LLM 미개입`, vts: ev.vts,
        status: j.result === 'PASS' ? 'ok' : j.result === 'FAIL' ? 'bad' : 'warn', hasDetail: true, data: { ...B, judgement: j, count: ev.count } });
      autoOpen(T, sp, ev);
      break;
    }
    case 'approval': {
      if (ev.action === 'requested') {
        const p = ev.payload || {};
        let r: Run | null = null;
        if (ev.kind === 'state_change' && p.request_id) r = T.runs[p.request_id] || null;
        if (!r && T.lastL3 && T.runs[T.lastL3]?.active && ev.kind !== 'state_change') r = T.runs[T.lastL3];
        if (!r) r = run(T, ev.request_id, ev.kind === 'state_change' ? 'L1' : 'L3', ev.title, `승인 요청 ${ev.request_id}`);
        const sp = span(T, r, { kind: 'approval', actor: '사람(운영자)', title: `승인 요청 — ${ev.title} · 대기 중`, vts: ev.vts, status: 'wait', hasDetail: true, data: { ...B, apr: ev, pending: true } });
        T.apr[ev.request_id] = sp.id;
        setStatus(r, '사람 승인 대기', 'wait');
        autoOpen(T, sp, ev);
      } else {
        const id = T.apr[ev.request_id];
        const sp = id != null ? T.spans[id] : undefined;
        if (!sp) break;
        update(sp, { title: `${ev.approved ? '승인' : '반려'} — ${ev.title} · ${ev.approver || ''}${ev.reason ? ` (${ev.reason})` : ''}`, status: ev.approved ? 'ok' : 'bad', data: { pending: false, decided: ev } });
        const r = T.runs[sp.runKey];
        if (r && r.status === '사람 승인 대기') setStatus(r, ev.approved ? '승인됨 · 진행' : '반려됨', ev.approved ? 'run' : 'bad');
        if (!ev.approved) autoOpen(T, sp, ev);
      }
      break;
    }
    case 'budget': {
      const r = T.runs[ev.heal_id || ev.grow_id];
      if (r) r.meta = `예산 ${ev.attempts}/${ev.max_attempts}회 · ${ev.minutes}/${ev.max_minutes}분`;
      break;
    }
    case 'tests': {
      const r = T.runs[ev.heal_id || ev.grow_id];
      if (!r) break;
      const key = `${r.key}:${ev.version}`;
      let sp = T.tests[key] != null ? T.spans[T.tests[key]] : undefined;
      if (!sp) {
        sp = span(T, r, { kind: 'tests', actor: '평가 하네스', title: `테스트 — ${agentKo(ev.agent_id)} ${ev.version}`, vts: ev.vts, status: 'run', hasDetail: true, data: { ...B, cases: [], n: 0, fails: 0 } });
        T.tests[key] = sp.id;
      }
      const D = sp.data;
      if (ev.n != null) D.n = Math.max(D.n, ev.n);
      D.cases.push({ ok: ev.ok, label: ev.label || ev.case, why: ev.why });
      if (ev.ok === false) D.fails += 1;
      const total = ev.heal_id ? `회귀 ${D.n}건 진행` : `${D.cases.length}건`;
      update(sp, { title: `테스트 — ${agentKo(ev.agent_id)} ${ev.version} · ${total}${D.fails ? ` · 실패 ${D.fails}` : ''}`, status: D.fails ? 'bad' : 'run' });
      if (ev.ok === false) autoOpen(T, sp, ev);
      break;
    }
    case 'heal': {
      const r = T.runs[ev.heal_id] || (T.lastL1 ? T.runs[T.lastL1] : null);
      if (r) span(T, r, { kind: 'note', actor: 'Healer', title: ev.text || `${ev.event} ${ev.signature || ''}`, vts: ev.vts, data: B });
      break;
    }
    case 'report': {
      const r = T.runs[ev.report_id];
      const sp = span(T, r || sysRun(T), { kind: 'report', actor: '', title: ev.title, vts: ev.vts, hasDetail: true, data: { ...B, report_id: ev.report_id, kind: ev.kind, content: ev.content } });
      if (r) { r.active = false; if (r.status === '진행 중') setStatus(r, '완료', 'done'); }
      void sp;
      break;
    }
    case 'version': {
      if (ev.kind === 'baseline' && ev.backlog) break;
      const r = T.runs[ev.ref] || ((T.lastL3 && T.runs[T.lastL3]?.active) ? T.runs[T.lastL3] : sysRun(T));
      const sp = span(T, r, { kind: 'version', actor: 'Registry', title: `${agentKo(ev.agent_id)} ${ev.from_version || '—'} → ${ev.to_version} · ${VKIND[ev.kind] || ev.kind}${ev.diff_add || ev.diff_del ? ` (+${ev.diff_add}/−${ev.diff_del})` : ''}`,
        vts: ev.vts, status: ev.kind === 'rollback' ? 'bad' : 'ver', hasDetail: !!(ev.note || ev.diff), data: { ...B, note: ev.note, diff: ev.diff } });
      if (ev.diff || ev.kind === 'rollback') autoOpen(T, sp, ev);
      for (const id of Object.values(T.tests)) { const t = T.spans[id]; if (t && t.runKey === r.key && t.status === 'run' && ev.kind === 'heal') t.status = 'ok'; }
      if (ev.kind === 'heal' && r.lane === 'HEAL') setStatus(r, `복구 완료 → ${ev.to_version}`, 'done');
      break;
    }
    case 'registry': {
      if (ev.event === 'baseline' && ev.backlog) break;
      const r = (T.lastL3 && T.runs[T.lastL3]?.active) ? T.runs[T.lastL3] : sysRun(T);
      span(T, r, { kind: 'registry', actor: 'Registry', title: `${agentKo(ev.agent_id)} — ${ev.note || ev.event} (${STATUS_KO[ev.status] || ev.status})`, vts: ev.vts, status: ev.event === 'retire' ? 'gone' : ev.event === 'deprecate' ? 'warn' : 'ok', data: B });
      break;
    }
    case 'candidate': {
      const r = run(T, ev.run_id, 'L3', runTitle(ev.run_id), '', T.replay && T.runs[T.replay]?.active ? 'replay' : null);
      T.lastL3 = r.key;
      const sp = span(T, r, { kind: 'candidate', actor: '평가 하네스', title: `${ev.cid} ${ev.title || ''} → ${ev.ok ? '채택' : '기각'}`, vts: ev.vts, status: ev.ok ? 'ok' : 'bad', hasDetail: true, data: { ...B, ev } });
      autoOpen(T, sp, ev);
      break;
    }
    case 'redirect': {
      const r = (T.lastL1 && T.runs[T.lastL1]?.active) ? T.runs[T.lastL1] : sysRun(T);
      span(T, r, { kind: 'redirect', actor: 'Runtime', title: `${short(ev.agent_id)} (deprecated) → ${short(ev.to)} 리다이렉트 ${ev.ok ? '성공' : `실패 → 원 Agent Fallback${ev.fallback ? ' 성공' : ''}`}${ev.error ? ` (${ev.error})` : ''}`, vts: ev.vts, status: ev.ok ? 'ok' : 'warn', data: B });
      break;
    }
    case 'shadow': {
      if (!ev.mismatch) break;
      const r = (T.lastL1 && T.runs[T.lastL1]?.active) ? T.runs[T.lastL1] : sysRun(T);
      span(T, r, { kind: 'shadow', actor: 'Runtime', title: `Shadow 불일치: ${short(ev.agent_id)} ${ev.primary} vs ${ev.shadow} (${ev.group}) — ${ev.detail}`, vts: ev.vts, status: 'bad', data: B });
      break;
    }
    case 'ops_batch': {
      if (ev.phase === 'start') {
        const r = run(T, `ops:${ev.seq}`, 'OPS', `배경 운영 — 가상 엔지니어 AutoQual 요청 ${ev.n}건 자율 처리 (${ev.label || ''})`, `${String(ev.start).slice(5, 16)} → ${String(ev.end).slice(5, 16)}`);
        r.open = false; r.vts = ev.vts;
        T.ops = r.key;
        setStatus(r, `0/${ev.n}`, 'run');
      } else if (ev.phase === 'progress' && T.ops && T.runs[T.ops]) setStatus(T.runs[T.ops], `${ev.done}/${ev.n} 처리`, 'run');
      else if (ev.phase === 'end' && T.ops && T.runs[T.ops]) { setStatus(T.runs[T.ops], `${ev.n}건 완료 · Up 승인 교대 리더`, 'done'); T.runs[T.ops].active = false; }
      break;
    }
    case 'ops_case': {
      const r = (T.ops && T.runs[T.ops]) || run(T, `ops:${ev.seq}`, 'OPS', '배경 운영 — 가상 엔지니어 요청 자율 처리', '');
      const ok = ev.result === 'PASS';
      span(T, r, { kind: 'ops', actor: ev.engineer || '엔지니어', title: ev.text, vts: ev.vts, status: ok ? 'ok' : ev.result ? 'warn' : 'ok', hasDetail: true, data: { ...B, ev } });
      break;
    }
    case 'replay_progress': {
      const r = replayRun(T);
      if (ev.phase === 'start') { setStatus(r, `0 / ${Number(ev.total).toLocaleString()}`, 'run'); r.active = true; r.meta = `진화 구간 ${ev.evolve}분기 · Held-out ${ev.heldout}`; }
      if (ev.phase === 'quarter_start') span(T, r, { kind: 'quarter', actor: '', title: `${ev.quarter} 재생 시작 — ${ev.n}건 (${ev.split === 'heldout' ? 'Held-out: 진화 없이 평가만' : '진화 구간: 분기 말 L3 Evolve'})`, vts: ev.vts, data: B });
      if (ev.phase === 'case') setStatus(r, `${Number(ev.done).toLocaleString()} / ${Number(ev.total).toLocaleString()} · ${String(ev.replay_clock || '').slice(0, 10)} · Guard 차단 ${ev.guard ?? 0}`, 'run');
      if (ev.phase === 'end') { setStatus(r, '완료', 'done'); r.active = false; }
      break;
    }
    case 'replay_case': {
      const r = replayRun(T);
      const sp = span(T, r, { kind: 'rcase', actor: '리플레이', title: `${ev.chamber_id} ${PM_KO[ev.pm_type] || ev.pm_type} — QH ${ev.qh_seq} 재생 (replay_clock ${String(ev.replay_clock || '').slice(0, 16)})`, vts: ev.vts, status: 'run', data: { ...B, qh: ev.qh_seq } });
      T.tests[`rc:${ev.qh_seq}`] = sp.id;
      break;
    }
    case 'replay_case_done': {
      const id = T.tests[`rc:${ev.qh_seq}`];
      const sp = id != null ? T.spans[id] : undefined;
      if (!sp) break;
      const c = ev.compare || {}, rec = ev.recommendation || {}, act = ev.actual || {};
      update(sp, { status: c.pred_ok && c.judge_ok ? 'ok' : 'warn', title: `${sp.title.replace(' 재생', '')} → 추천 ${rec.count ?? '-'}매 vs 당시 ${act.n1}매 ${act.q1 === 'P' ? 'PASS' : 'FAIL'} · 예측 ${c.pred_ok ? '일치' : '불일치'} · 판정 ${c.judge_ok ? '일치' : '불일치'}`, hasDetail: true, data: { done: ev } });
      autoOpen(T, sp, ev);
      break;
    }
    case 'replay_quarter': {
      const r = replayRun(T);
      const sp = span(T, r, { kind: 'qres', actor: 'Evolver', title: `${ev.quarter} 결과 — 판정 일치율 ${ev.accuracy}% · 추천 오차 ±${ev.rec_error}매 · 교훈 +${ev.new_lessons || 0}/만료 ${ev.expired_lessons || 0}`, vts: ev.vts, status: 'ver', hasDetail: true, data: { ...B, ev } });
      autoOpen(T, sp, ev);
      break;
    }
    default: break;
  }
}
