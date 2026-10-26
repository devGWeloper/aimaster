// 라이브 슬라이스 — "지금 Agent가 무엇을 하는지" (자막·포커스 카드·루프 트랙 위치·발자취·Agentic 지표)
import type { AnyEv, Lane, Tone } from '@/lib/types';
import { AGENT_KO, BAD, SAY, VKIND, agentKo, short } from '@/lib/ko';

export type FocusKind = 'request' | 'parse' | 'route' | 'jev' | 'code' | 'agent' | 'judge' | 'approval' | 'response' | 'version' | 'candidate' | 'tests'
  | 'fault' | 'thought' | 'replay_case' | 'replay_quarter' | 'report' | 'registry' | 'node' | 'spec' | 'memory' | 'ops' | 'policy';
export interface Focus { id: number; kind: FocusKind; lane: Lane | ''; title: string; ev: AnyEv; at: number; vts?: string; key?: string }
export interface LaneState { run: string | null; cur: string | null; visited: string[]; status: string; stopped: boolean; wait: string | null; backHot: boolean; bubble: string; bad: boolean; at: number }
export interface Trail { lane: Lane; label: string; bad: boolean; n: number }
export interface LiveState {
  chapter: { id: string; title: string; date: string; desc: string } | null;
  story: string;
  question: { who: string; text: string; tag: string } | null;
  now: { lane: Lane | ''; say: string; detail: string; tone: Tone; at: number };
  trail: Trail[];
  lanes: Record<Lane, LaneState>;
  counters: { code: number; calls: number; jev: number; heal: number; grow: number; evolve: number; human: number };
  focus: Focus | null;
  acts: Focus[];
  replayClock: string | null;
  replayProg: AnyEv | null;
  opsProg: AnyEv | null;
  budgets: Record<string, AnyEv>;
  tests: Record<string, { agent_id: string; version: string; cases: { ok: boolean | null; label: string; why?: string }[]; n: number; fails: number; lane: Lane }>;
  faults: AnyEv[];
  nextId: number;
}

// 루프 트랙 슬롯 — 트랙 위 위치 (Loop 페이지 다이어그램과 Live 스테퍼가 공유)
export const LANE_SLOTS: Record<Lane, { key: string; label: string; kind?: 'ca' | 'jev' | 'det' | 'gate' | 'q' }[]> = {
  L1: [{ key: 'q', label: '요청', kind: 'q' }, { key: 'parse', label: '요청 해석' }, { key: 'mem', label: '경험 메모리' }, { key: 'route', label: 'Jev 편성', kind: 'jev' },
    { key: 'plan', label: 'CodeAct 계획', kind: 'ca' }, { key: 'exec', label: '샌드박스 실행', kind: 'ca' }, { key: 'obs', label: '관찰·검증' }, { key: 'resp', label: '종합·응답' },
    { key: 'judge', label: '결정적 판정', kind: 'det' }, { key: 'gate', label: '사람 승인', kind: 'gate' }],
  HEAL: [{ key: 'cls', label: '오류 분류', kind: 'jev' }, { key: 'diag', label: '원인 진단', kind: 'ca' }, { key: 'patch', label: '패치 작성', kind: 'ca' }, { key: 'test', label: '회귀 테스트', kind: 'det' }, { key: 'reg', label: '버전 반영' }],
  GROW: [{ key: 'search', label: '아카이브 검색' }, { key: 'schema', label: '스키마 탐색', kind: 'ca' }, { key: 'gen', label: '코드 생성', kind: 'ca' }, { key: 'test', label: '테스트', kind: 'det' }, { key: 'reg', label: 'probation 등록' }],
  L3: [{ key: 'metrics', label: '지표 수집' }, { key: 'jev', label: 'Jev 진화 판단', kind: 'jev' }, { key: 'mutate', label: '변이 후보', kind: 'ca' }, { key: 'eval', label: '하네스 평가', kind: 'det' },
    { key: 'select', label: '선택·승인', kind: 'gate' }, { key: 'archive', label: '아카이브 보관' }, { key: 'shadow', label: 'Shadow 검증' }, { key: 'promote', label: '승격 / 롤백' }],
};
export const NODE_SLOT: Record<Lane, Record<string, string>> = {
  L1: { parse_request: 'parse', retrieve_memory: 'mem', jev_route: 'route', grow_subgraph: 'route', plan_codeact: 'plan', rework_plan: 'plan',
    execute_sandbox: 'exec', observe: 'obs', mark_unavailable: 'obs', synthesize: 'resp', respond: 'resp', await_qual_result: 'resp',
    replay_measure: 'resp', deterministic_judge: 'judge', compare_actual: 'judge', approval_gate: 'gate', apply_state_change: 'gate', log_experience: '@back' },
  HEAL: { start: 'cls', jev_classify_error: 'cls', heal_history: 'cls', diagnose_codeact: 'diag', write_patch: 'patch', check_blacklist: 'patch',
    blacklist_patch: '@back', run_regression: 'test', register_version: 'reg', cascade: 'reg', reanswer_pending: 'reg', escalate_operator: '@stop' },
  GROW: { start: 'search', search_archive: 'search', restore_genome: 'gen', write_spec: 'schema', explore_schema: 'schema',
    generate_code_and_tests: 'gen', run_tests: 'test', register_probation: 'reg', abort_with_reason: '@stop' },
  L3: { collect_metrics: 'metrics', analyze_cause: 'metrics', cluster_recheck: 'metrics', classify_override: 'metrics',
    jev_need_evolve: 'jev', jev_need_grow: 'jev', jev_need_retire: 'jev', jev_need_merge: 'jev', mutate: 'mutate',
    evaluate_harness: 'eval', verify_replacement: 'eval', migrate_tests: 'eval', select: 'select', archive: 'archive',
    shadow_run: 'shadow', promote: 'promote', auto_rollback: 'promote' },
};
export const laneOf = (ev: AnyEv): Lane | null => (ev.loop === 'L1' ? 'L1' : ev.loop === 'L3' ? 'L3' : ev.loop === 'L2' ? (ev.sub === 'grow' || ev.grow_id ? 'GROW' : 'HEAL') : null);
export const runOf = (ev: AnyEv): string | null => ev.heal_id || ev.grow_id || ev.run_id || ev.request_id || null;
const slotLabel = (lane: Lane, key: string) => LANE_SLOTS[lane].find((s) => s.key === key)?.label || key;

const emptyLane = (): LaneState => ({ run: null, cur: null, visited: [], status: '대기', stopped: false, wait: null, backHot: false, bubble: '', bad: false, at: 0 });
export const initialLive = (): LiveState => ({
  chapter: null, story: '', question: null, now: { lane: '', say: '', detail: '', tone: '', at: 0 }, trail: [],
  lanes: { L1: emptyLane(), HEAL: emptyLane(), GROW: emptyLane(), L3: emptyLane() },
  counters: { code: 0, calls: 0, jev: 0, heal: 0, grow: 0, evolve: 0, human: 0 },
  focus: null, acts: [], replayClock: null, replayProg: null, opsProg: null, budgets: {}, tests: {}, faults: [], nextId: 1,
});

function now(L: LiveState, lane: Lane | '', say: string, detail: string, tone: Tone, ev: AnyEv) {
  L.now = { lane, say, detail: detail || '', tone, at: ev.wall };
}
function step(L: LiveState, lane: Lane, label: string, bad: boolean) {
  const last = L.trail[L.trail.length - 1];
  if (last && last.lane === lane && last.label === label) { last.n += 1; last.bad = last.bad || bad; } else L.trail.push({ lane, label, bad, n: 1 });
  if (L.trail.length > 60) L.trail.splice(0, L.trail.length - 60);
}
export function focus(L: LiveState, kind: FocusKind, lane: Lane | '', title: string, ev: AnyEv, key?: string) {
  // 같은 key(예: 테스트 묶음)는 교체, 아니면 새 카드
  if (key) {
    const i = L.acts.findIndex((a) => a.key === key);
    if (i >= 0) { const f = { ...L.acts[i], title, ev, at: ev.wall }; L.acts[i] = f; L.focus = f; return f; }
  }
  const f: Focus = { id: L.nextId++, kind, lane, title, ev, at: ev.wall, vts: ev.vts, key };
  L.acts.push(f);
  if (L.acts.length > 80) L.acts.splice(0, L.acts.length - 80);
  L.focus = f;
  return f;
}
function go(L: LiveState, lane: Lane, slot: string, ev: AnyEv, opts: { bad?: boolean; detail?: string | null; run?: string | null } = {}) {
  const S = L.lanes[lane];
  if (opts.run && opts.run !== S.run) { S.run = opts.run; S.visited = []; S.stopped = false; S.wait = null; }
  S.backHot = false;
  if (slot === '@back') { S.cur = null; S.backHot = true; }
  else if (slot === '@stop') { S.stopped = true; }
  else { S.cur = slot; if (!S.visited.includes(slot)) S.visited.push(slot); S.wait = null; }
  S.bad = !!opts.bad || slot === '@stop';
  S.bubble = String(opts.detail ?? ev.detail ?? '').replace(/\s+/g, ' ').trim();
  S.at = ev.wall;
}
function laneStatus(L: LiveState, lane: Lane, text: string) { L.lanes[lane].status = text; }

function onNode(L: LiveState, ev: AnyEv) {
  const lane = laneOf(ev);
  if (!lane) return;
  const slot = NODE_SLOT[lane][ev.node];
  if (!slot) return;
  const bad = !!BAD[ev.node]?.test(ev.detail || '');
  const run = runOf(ev);
  go(L, lane, slot, ev, { bad, run });
  if (ev.node === 'mark_unavailable' || (ev.node === 'observe' && bad)) L.lanes.L1.wait = 'obs';
  if (ev.node === 'grow_subgraph') L.lanes.L1.wait = 'route';
  if (lane !== 'L1' && run) laneStatus(L, lane, `${run}${ev.agent_id ? ` · ${short(ev.agent_id)}` : ''}${slot === '@stop' ? ' · 중단' : ''}`);
  if (lane === 'L1' && run) laneStatus(L, 'L1', `${run} 진행 중`);
  const key = ev.node === 'start' ? `${lane}:start` : ev.node;
  const label = slot === '@back' ? (lane === 'L1' ? '경험 기록' : '재시도') : slot === '@stop' ? '중단' : slotLabel(lane, slot);
  now(L, lane, SAY[key] || label, ev.detail, bad || slot === '@stop' ? 'bad' : '', ev);
  step(L, lane, label, bad || slot === '@stop');
  // 포커스 카드가 될 노드
  if (ev.node === 'parse_request') focus(L, 'parse', 'L1', '요청 해석', ev);
  else if (ev.node === 'retrieve_memory' && ev.memory) focus(L, 'memory', 'L1', '경험 메모리 조회', ev);
  else if (ev.node === 'write_spec' && ev.spec) focus(L, 'spec', 'GROW', '새 Agent 명세', ev);
  else if (ev.node === 'start' && lane !== 'L1') focus(L, 'node', lane, lane === 'HEAL' ? 'Self-Healing 시작' : 'Agent Factory 시작', ev);
  else if (['escalate_operator', 'abort_with_reason', 'cascade', 'blacklist_patch', 'register_probation', 'register_version', 'mark_unavailable', 'diagnose_codeact', 'explore_schema', 'analyze_cause', 'collect_metrics', 'select', 'shadow_run', 'promote', 'auto_rollback', 'verify_replacement', 'migrate_tests', 'archive', 'search_archive', 'restore_genome', 'classify_override', 'cluster_recheck'].includes(ev.node) && ev.detail)
    focus(L, 'node', lane, label, ev);
}

export function liveReduce(L: LiveState, ev: AnyEv) {
  switch (ev.type) {
    case 'chapter':
      if (ev.phase === 'start') {
        L.chapter = { id: ev.id, title: ev.title, date: ev.date, desc: ev.desc };
        if (!ev.backlog) for (const k of Object.keys(L.lanes) as Lane[]) L.lanes[k] = emptyLane();
      }
      break;
    case 'story': L.story = ev.text; break;
    case 'request':
      if (ev.source === 'sim') break;
      L.question = { who: ev.user || '엔지니어', text: ev.text, tag: ev.request_id };
      L.trail = [];
      go(L, 'L1', 'q', ev, { run: ev.request_id, detail: ev.text });
      laneStatus(L, 'L1', `${ev.request_id} 진행 중`);
      now(L, 'L1', '요청이 들어왔습니다. Super Agent가 처리를 시작합니다', ev.request_id, '', ev);
      step(L, 'L1', '요청', false);
      focus(L, 'request', 'L1', '요청 접수', ev);
      break;
    case 'replay_case':
      L.question = { who: '리플레이', text: ev.text, tag: `${ev.quarter} · replay_clock ${String(ev.replay_clock || '').slice(0, 10)}` };
      go(L, 'L1', 'q', ev, { run: `RP-${ev.qh_seq}`, detail: `과거 이력 재생 — ${ev.chamber_id} ${ev.pm_type}` });
      laneStatus(L, 'L1', `리플레이 QH ${ev.qh_seq} · ${ev.quarter}`);
      step(L, 'L1', '요청(과거)', false);
      break;
    case 'replay_case_done': focus(L, 'replay_case', 'L1', `리플레이 QH ${ev.qh_seq}`, ev); break;
    case 'node': onNode(L, ev); break;
    case 'thought': if (ev.kind === 'warn' || ev.kind === 'ask') focus(L, 'thought', 'L1', ev.kind === 'ask' ? 'Super Agent 확인 질문' : 'Super Agent 경고', ev); break;
    case 'code': {
      L.counters.code += 1;
      const lane: Lane = ev.agent === 'healer' ? 'HEAL' : ev.agent === 'factory' ? 'GROW' : ev.agent === 'evolver' ? 'L3' : 'L1';
      focus(L, 'code', lane, ev.purpose || 'CodeAct', ev);
      break;
    }
    case 'jev': {
      L.counters.jev += 1;
      const lane: Lane = ev.heal_id ? 'HEAL' : ev.grow_id ? 'GROW' : ev.run_id ? 'L3' : 'L1';
      focus(L, 'jev', lane, 'Jev 판단', ev);
      break;
    }
    case 'agent_end': {
      L.counters.calls += 1;
      focus(L, 'agent', 'L1', `${agentKo(ev.agent_id)} ${ev.action}`, ev);
      break;
    }
    case 'response': if (ev.request_id) { laneStatus(L, 'L1', `${ev.request_id} 응답`); focus(L, 'response', 'L1', '응답', ev); } break;
    case 'judge': focus(L, 'judge', 'L1', `judge_qual → ${ev.judgement?.result}`, ev); break;
    case 'budget': {
      const lane: Lane = ev.heal_id ? 'HEAL' : 'GROW';
      L.budgets[ev.heal_id || ev.grow_id] = ev;
      laneStatus(L, lane, `${ev.heal_id || ev.grow_id} · 시도 ${ev.attempts}/${ev.max_attempts} · ${ev.minutes}/${ev.max_minutes}분`);
      break;
    }
    case 'tests': {
      const key = `${ev.heal_id || ev.grow_id}:${ev.version}`;
      const T = L.tests[key] || (L.tests[key] = { agent_id: ev.agent_id, version: ev.version, cases: [], n: 0, fails: 0, lane: ev.heal_id ? 'HEAL' : 'GROW' });
      if (ev.n != null) T.n = Math.max(T.n, ev.n);
      T.cases.push({ ok: ev.ok, label: ev.label || ev.case, why: ev.why });
      if (ev.ok === false) T.fails += 1;
      focus(L, 'tests', T.lane, `테스트 — ${agentKo(ev.agent_id)} ${ev.version}`, ev, key);
      break;
    }
    case 'version': {
      if (ev.kind === 'baseline') break;
      if (ev.kind === 'heal') L.counters.heal += 1;
      if (ev.kind === 'grow') L.counters.grow += 1;
      if (['evolve', 'compose', 'promote', 'restore'].includes(ev.kind)) L.counters.evolve += 1;
      const det = `${ev.agent_id} ${ev.from_version || '—'} → ${ev.to_version} · ${VKIND[ev.kind] || ev.kind}${ev.ref ? ` ${ev.ref}` : ''} · +${ev.diff_add || 0}/−${ev.diff_del || 0}`;
      if (['evolve', 'compose', 'rollback', 'promote', 'restore'].includes(ev.kind)) {
        go(L, 'L3', 'promote', ev, { bad: ev.kind === 'rollback', detail: `${short(ev.agent_id)} ${ev.from_version || '—'} → ${ev.to_version} (${VKIND[ev.kind]})` });
        now(L, 'L3', ev.kind === 'rollback' ? `자동 롤백. ${AGENT_KO[ev.agent_id] || ev.agent_id}를 이전 버전으로 되돌립니다`
          : `${AGENT_KO[ev.agent_id] || ev.agent_id}가 새 버전으로 진화했습니다. 다음 요청부터 이 코드로 동작합니다`, det, ev.kind === 'rollback' ? 'bad' : 'ver', ev);
        step(L, 'L3', ev.kind === 'rollback' ? '롤백' : `${short(ev.agent_id)} ${ev.to_version}`, ev.kind === 'rollback');
      } else {
        now(L, ev.kind === 'grow' ? 'GROW' : 'HEAL', ev.kind === 'grow' ? `새 Agent ${AGENT_KO[ev.agent_id] || ev.agent_id}가 태어났습니다` : `${AGENT_KO[ev.agent_id] || ev.agent_id}가 스스로 고친 코드로 교체되었습니다`, det, 'ver', ev);
      }
      focus(L, 'version', ev.kind === 'grow' ? 'GROW' : ev.kind === 'heal' ? 'HEAL' : 'L3', `${agentKo(ev.agent_id)} ${ev.from_version || '—'} → ${ev.to_version}`, ev);
      break;
    }
    case 'registry':
      if (ev.event === 'shadow') go(L, 'L3', 'shadow', ev, { detail: `${short(ev.agent_id)} ${ev.note || ''}` });
      if (ev.event === 'deprecate') go(L, 'L3', 'select', ev, { detail: `${short(ev.agent_id)} 폐기 유예 — ${ev.note || ''}` });
      if (ev.event === 'retire') { go(L, 'L3', 'archive', ev, { detail: `${short(ev.agent_id)} 폐기 → 아카이브 보관` }); now(L, 'L3', `${AGENT_KO[ev.agent_id] || ev.agent_id}를 폐기하고 아카이브에 보관합니다`, ev.note, 'ver', ev); }
      if (ev.event !== 'baseline') focus(L, 'registry', 'L3', `${agentKo(ev.agent_id)} ${VKIND[ev.event] || ev.event}`, ev);
      break;
    case 'candidate':
      go(L, 'L3', 'eval', ev, { run: ev.run_id, bad: ev.ok === false, detail: `${ev.cid} ${ev.title || ''} — ${ev.reason || ''}` });
      step(L, 'L3', `후보 ${ev.cid}`, ev.ok === false);
      now(L, 'L3', `평가 하네스가 후보 ${ev.cid}를 채점했습니다 → ${ev.ok ? '채택' : '기각'}`, `${ev.title || ''} · ${ev.reason || ''}`, ev.ok ? 'ok' : 'bad', ev);
      focus(L, 'candidate', 'L3', `후보 ${ev.cid} → ${ev.ok ? '채택' : '기각'}`, ev);
      break;
    case 'approval': {
      const L1k = ev.kind === 'state_change';
      const lane: Lane = L1k ? 'L1' : 'L3';
      if (ev.action === 'requested') {
        go(L, lane, L1k ? 'gate' : 'select', ev, { detail: `승인 대기 — ${ev.title}` });
        L.lanes[lane].wait = L1k ? 'gate' : 'select';
        now(L, lane, '사람 승인을 기다립니다. 무승인 변경은 0건', ev.title, 'gate', ev);
        focus(L, 'approval', lane, `승인 요청 — ${ev.title}`, ev, `apr:${ev.request_id}`);
      } else if (!String(ev.approver || '').includes('교대')) {
        L.counters.human += 1;
        go(L, lane, L1k ? 'gate' : 'select', ev, { bad: !ev.approved, detail: `${ev.approved ? '승인' : '반려'} — ${ev.approver}` });
        now(L, lane, `사람이 ${ev.approved ? '승인했습니다' : '반려했습니다'}`, `${ev.title} — ${ev.approver}${ev.reason ? ` (${ev.reason})` : ''}`, ev.approved ? 'ok' : 'bad', ev);
        focus(L, 'approval', lane, `${ev.approved ? '승인' : '반려'} — ${ev.title}`, ev, `apr:${ev.request_id}`);
      }
      break;
    }
    case 'fault':
      L.faults.push(ev);
      if (L.faults.length > 20) L.faults.shift();
      if (ev.type_ === 'clear' || /해제/.test(ev.text || '')) { now(L, 'L1', '장애가 해제되었습니다', ev.text, 'ok', ev); focus(L, 'fault', '', '장애 해제', ev); break; }
      now(L, 'L1', '장애 주입. 현실의 변화(로그 포맷·DB 이관 등)가 일어났습니다', ev.text, 'bad', ev);
      focus(L, 'fault', '', '장애 주입', ev);
      break;
    case 'policy': focus(L, 'policy', 'L3', '평가 기준 변경 (사람)', ev); break;
    case 'ops_batch':
      L.opsProg = ev;
      if (ev.phase === 'start') { laneStatus(L, 'L1', `배경 운영 0/${ev.n} 자율 처리`); now(L, 'L1', '배경 운영. 가상 엔지니어들의 AutoQual 요청을 Agent가 자율 처리합니다', `${String(ev.start).slice(5, 16)} → ${String(ev.end).slice(5, 16)} · PM ${ev.n}건`, '', ev); focus(L, 'ops', 'L1', '배경 운영', ev, `ops:${ev.start}`); }
      if (ev.phase === 'progress') { laneStatus(L, 'L1', `배경 운영 ${ev.done}/${ev.n} 자율 처리`); }
      if (ev.phase === 'end') { laneStatus(L, 'L1', `배경 운영 ${ev.n}건 완료`); }
      break;
    case 'replay_progress':
      L.replayProg = ev;
      if (ev.replay_clock) L.replayClock = ev.replay_clock;
      if (ev.phase === 'start') laneStatus(L, 'L3', `리플레이 0/${Number(ev.total).toLocaleString()} · Time-Travel Guard ON`);
      if (ev.phase === 'quarter_start') { laneStatus(L, 'L3', `리플레이 ${ev.quarter} · ${ev.split === 'heldout' ? 'Held-out (진화 없이 평가만)' : '진화 구간'}`); L.story = `이력 리플레이 — ${ev.quarter} 재생 중 (${ev.n}건). 미래 데이터는 Time-Travel Guard가 차단합니다.`; }
      if (ev.phase === 'case') laneStatus(L, 'L3', `리플레이 ${Number(ev.done).toLocaleString()}/${Number(ev.total).toLocaleString()} · ${String(ev.replay_clock || '').slice(0, 10)} · Guard 차단 ${ev.guard ?? 0}`);
      if (ev.phase === 'end') laneStatus(L, 'L3', '리플레이 완료');
      break;
    case 'replay_quarter':
      now(L, 'L3', `${ev.quarter} 진화 결과. 판정 일치율 ${ev.accuracy}% · 추천 오차 ±${ev.rec_error}매`, (ev.events || []).slice(0, 2).join(' · '), 'ver', ev);
      focus(L, 'replay_quarter', 'L3', `${ev.quarter} 분기 진화 결과`, ev);
      break;
    case 'report': focus(L, 'report', ev.kind === 'heal' ? 'HEAL' : ev.kind === 'grow' ? 'GROW' : 'L3', ev.title, ev); break;
    default: break;
  }
}
