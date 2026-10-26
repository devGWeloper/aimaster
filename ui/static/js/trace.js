// 실행 트레이스 — Agent가 한 모든 일을 런(요청·Heal·Grow·진화·배경 운영·리플레이) 단위로 묶어 영속적으로 남긴다.
//   각 행(span)은 누가(actor) · 무엇을(title) · 결과(status)이고, 펼치면 실제 코드(CodeAct)·Jev 확률·가져온 값·도구 호출·판정 표·diff·테스트가 나온다.
//   트레이스는 SSE 백로그로 재구성되므로 새로고침해도 남는다 (LangSmith/Langfuse식 span 트리를 이 과제 용어로 재해석).
import { $, h, api, vdate, AGENT_KO, ACTOR_KO, HEAD_KO, NODE_KO, STATUS_KO, short, diffLines, highlight, fmtVal, fmtSpec, unitKo, ITEM_KO, RTYPE_KO, PM_KO } from './util.js';
import { laneOf, BAD, VKIND } from './stage.js';

let A = null;
const spd = () => (A && A.state ? Number(A.state.speed) : 1);
const ms = (base) => { const v = spd(); return v ? base / Math.max(0.5, v) : 0; };
const t = (vts) => vdate(vts).t;

const LANE_C = { L1: 'l1', HEAL: 'l2', GROW: 'l2', L3: 'l3', OPS: 'ops', REPLAY: 'l3', SYS: 'sys' };
const LANE_KO = { L1: 'L1 TASK', HEAL: 'L2 HEAL', GROW: 'L2 GROW', L3: 'L3 EVOLVE', OPS: '배경 운영', REPLAY: '리플레이', SYS: 'SYSTEM' };
const BADGE = { code: 'CODEACT', jev: 'JEV', agent: 'AGENT', sandbox: 'SANDBOX', judge: 'DETERMINISTIC', approval: 'HUMAN', tests: 'TEST', version: 'VERSION',
  candidate: 'HARNESS', response: 'ANSWER', fab: 'FAB', memory: 'MEMORY', thought: 'THINK', report: 'REPORT', route: 'ROUTE', parse: 'PARSE',
  state: 'FAB', wait: 'WAIT', observe: 'VERIFY', heal: 'HEAL', spec: 'SPEC', ops: 'AUTO', rcase: 'REPLAY', qres: 'EVOLVE', quarter: 'REPLAY',
  registry: 'REGISTRY', redirect: 'ROUTE', shadow: 'SHADOW', note: 'NOTE', node: '' };
const CODE_NODES = new Set(['plan_codeact', 'rework_plan', 'diagnose_codeact', 'write_patch', 'explore_schema', 'generate_code_and_tests']);
const HIDE_NODES = new Set(['synthesize', 'respond', 'deterministic_judge', 'approval_gate', 'jev_route', 'jev_classify_error', 'jev_need_evolve',
  'jev_need_grow', 'jev_need_retire', 'jev_need_merge']);
const AUTO_OPEN = new Set(['code', 'jev', 'agent', 'response', 'judge', 'approval', 'version', 'candidate', 'tests', 'parse', 'route', 'spec', 'rcase', 'qres', 'report']);
const PIPE = {
  plan: ['LLM 코드 작성', 'AST 정적 검사', 'import 화이트리스트', '샌드박스 실행', '사후 검증'],
  diag: ['진단 코드 작성', 'AST 정적 검사', '로그 슬라이싱 실행', '원인 도출'],
  patch: ['패치 작성', 'AST·블랙리스트', '회귀 테스트', '버전 반영'],
  explore: ['탐색 코드 작성', 'AST 정적 검사', '읽기 전용 실행', '스키마 파악'],
  gen: ['Agent 코드 생성', 'AST 정적 검사', '자가·하네스 테스트', 'probation 등록'],
  evolve: ['변이 생성', '하네스 평가', '선택·승인', 'Registry 반영'],
};
const RUN_KIND = { 'E-': '판단 진화 (운영 결과 학습)', 'V-': '구조 진화 (중복·성능)', 'O-': '편성 전략 진화', 'R-': 'Agent 폐기 검토', 'RB-': '승격 후 Shadow 점검',
  'Q-': '분기 진화 (리플레이 Walk-forward)' };

const actorOf = (id) => ACTOR_KO[id] || AGENT_KO[id] || short(id || '');
// 런 키 — Heal·Grow·진화는 자기 id로 묶고(요청 id는 부모 연결용), 그 외는 요청 id
const laneRun = (ev) => (ev.heal_id ? ['HEAL', ev.heal_id] : ev.grow_id ? ['GROW', ev.grow_id] : ev.run_id ? ['L3', ev.run_id] : ev.request_id ? ['L1', ev.request_id] : [null, null]);
const keyOf = (ev) => ev.heal_id || ev.grow_id || ev.run_id || ev.request_id || null;

export const Trace = {
  runs: [], byKey: new Map(), spans: new Map(), apr: new Map(), tests: new Map(), el: {}, follow: true, lastL1: null, lastL3: null, ops: null, replay: null,
  autoOpened: null, counts: { code: 0, calls: 0, jev: 0, heal: 0, grow: 0, evolve: 0, human: 0, unapproved: 0 }, backlogTimer: null, nspan: 0,
  onCount: null, filter: 'all',

  init(app, host) {
    A = app;
    const e = this.el;
    e.list = h('div', { class: 'tr-list' });
    e.latest = h('button', { class: 'tr-latest', hidden: true, onclick: () => { this.follow = true; this.scroll(true); } }, '▼ 최신으로');
    e.cnt = h('span', { class: 'fp-r' }, '');
    const filters = h('div', { class: 'tr-filters' }, ...[['all', '전체'], ['L1', 'L1'], ['L2', 'L2 Heal·Grow'], ['L3', 'L3'], ['OPS', '배경']]
      .map(([k, label]) => h('button', { class: k === 'all' ? 'on' : '', onclick: (ev) => { this.filter = k; filters.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); this.applyFilter(); } }, label)));
    host.append(
      h('header', { class: 'fp-h' }, h('b', { class: 'kw l1' }, '실행 트레이스'),
        h('span', { class: 'fp-d' }, '누가 · 무엇을 · 어떤 값으로 — 펼치면 코드·확률·값·diff'), e.cnt),
      filters, h('div', { class: 'tr-wrap' }, e.list, e.latest));
    e.list.addEventListener('scroll', () => {
      const atEnd = e.list.scrollTop + e.list.clientHeight >= e.list.scrollHeight - 60;
      if (!atEnd && this.follow) { this.follow = false; e.latest.hidden = false; }
      if (atEnd && !this.follow) { this.follow = true; e.latest.hidden = true; }
    });
  },

  // ── 런 ───────────────────────────────────────────────────
  run(key, lane, title, sub, parentKey) {
    let r = this.byKey.get(key);
    if (r) return r;
    const parent = parentKey ? this.byKey.get(parentKey) : null;
    r = { key, lane, title, sub, status: '진행 중', spans: [], parent, children: [], open: true, active: true, t0: null, meta: '' };
    const e = {};
    e.title = h('span', { class: 'rn-title' }, title);
    e.sub = h('span', { class: 'rn-sub' }, sub || '');
    e.status = h('span', { class: 'rn-status' }, r.status);
    e.meta = h('span', { class: 'rn-meta' }, '');
    e.body = h('div', { class: 'rn-body' });
    e.head = h('div', { class: 'rn-head', onclick: () => { r.open = !r.open; e.sec.classList.toggle('closed', !r.open); } },
      h('span', { class: `rn-lane ${LANE_C[lane]}` }, LANE_KO[lane] || lane), h('span', { class: 'rn-key' }, key.startsWith('ops:') || key === 'replay' || key === 'registry' ? '' : key),
      e.title, e.sub, e.meta, e.status);
    e.sec = h('section', { class: `tr-run ${LANE_C[lane]} ${parent ? 'nested' : ''}`, 'data-lane': lane }, e.head, e.body);
    r.el = e;
    this.byKey.set(key, r);
    this.runs.push(r);
    if (parent) { parent.children.push(r); parent.el.body.append(e.sec); } else this.el.list.append(e.sec);
    this.trim();
    this.applyFilterOne(e.sec, lane);
    return r;
  },
  setStatus(r, status, cls) {
    r.status = status;
    r.el.status.textContent = status;
    r.el.status.className = `rn-status ${cls || ''}`;
    if (cls && cls !== 'run') r.active = false;
  },
  setMeta(r, text) { r.el.meta.textContent = text || ''; },
  trim() {
    while (this.runs.length > 90) {
      const old = this.runs.shift();
      if (old.parent) continue;
      old.el.sec.remove();
      this.byKey.delete(old.key);
      for (const sp of old.spans) this.spans.delete(sp.id);
    }
  },

  // ── 스팬 ────────────────────────────────────────────────
  span(r, { kind = 'node', actor = '', title = '', status = 'ok', vts = null, detail = null, depth = 0, parent = null, bad = false, data = null, lane = null }) {
    this.nspan += 1;
    const sp = { id: this.nspan, run: r, kind, actor, title, status: bad ? 'bad' : status, vts, detail, depth, parent, data: data || {}, open: false, pinned: false, lane: lane || r.lane };
    const e = {};
    e.badge = h('span', { class: `sp-badge b-${kind}` }, BADGE[kind] ?? '');
    e.actor = h('span', { class: 'sp-actor' }, actor);
    e.title = h('span', { class: 'sp-title' }, title);
    e.meta = h('span', { class: 'sp-meta' }, vts ? t(vts) : '');
    e.tog = h('span', { class: 'sp-tog' }, '');
    e.det = h('div', { class: 'sp-det', hidden: true });
    e.row = h('div', { class: 'sp-row', onclick: () => this.toggle(sp, true) }, h('i', { class: 'sp-dot' }), e.badge, e.actor, e.title, e.meta, e.tog);
    e.root = h('div', { class: `sp k-${kind} st-${sp.status} d${Math.min(depth, 4)} ${detail ? 'has' : ''}` }, e.row, e.det);
    sp.el = e;
    if (!actor) e.actor.hidden = true;
    if (!BADGE[kind]) e.badge.hidden = true;
    if (detail) e.tog.textContent = '▸';
    const host = parent ? parent.el.kids || (parent.el.kids = h('div', { class: 'sp-kids' })) : r.el.body;
    if (parent && !parent.el.kids.parentNode) parent.el.root.append(parent.el.kids);
    host.append(e.root);
    r.spans.push(sp);
    this.spans.set(sp.id, sp);
    return sp;
  },
  update(sp, { title, status, detail, actor, meta, data }) {
    if (title != null) { sp.title = title; sp.el.title.textContent = title; }
    if (actor != null) { sp.actor = actor; sp.el.actor.textContent = actor; sp.el.actor.hidden = !actor; }
    if (status) { sp.el.root.classList.remove(`st-${sp.status}`); sp.status = status; sp.el.root.classList.add(`st-${status}`); }
    if (meta != null) sp.el.meta.textContent = meta;
    if (data) Object.assign(sp.data, data);
    if (detail) { sp.detail = detail; sp.el.root.classList.add('has'); sp.el.tog.textContent = sp.open ? '▾' : '▸'; if (sp.open) this.renderDetail(sp, true); }
  },
  toggle(sp, byUser) {
    if (!sp.detail) return;
    sp.open = !sp.open;
    if (byUser) sp.pinned = sp.open;
    sp.el.tog.textContent = sp.open ? '▾' : '▸';
    sp.el.det.hidden = !sp.open;
    sp.el.root.classList.toggle('open', sp.open);
    if (sp.open) this.renderDetail(sp, byUser);
  },
  autoOpen(sp, ev) {
    if (!sp.detail || ev.backlog) return;
    if (this.autoOpened && this.autoOpened !== sp && !this.autoOpened.pinned && this.autoOpened.open) this.toggle(this.autoOpened, false);
    if (!sp.open) this.toggle(sp, false);
    this.autoOpened = sp;
  },
  renderDetail(sp, instant) {
    const d = sp.el.det;
    d.innerHTML = '';
    try { sp.detail(d, instant || !!sp.data.backlog); } catch (e) { console.error('detail', sp.kind, e); d.append(h('div', { class: 'muted' }, String(e))); }
  },
  scroll(force) {
    if (!this.follow && !force) return;
    const L = this.el.list;
    L.scrollTop = L.scrollHeight;
  },
  applyFilter() { for (const r of this.runs) if (!r.parent) this.applyFilterOne(r.el.sec, r.lane); for (const m of this.el.list.querySelectorAll('.tr-mark')) m.style.display = this.filter === 'all' || this.filter === 'L1' ? '' : 'none'; },
  applyFilterOne(sec, lane) {
    const f = this.filter;
    const ok = f === 'all' || (f === 'L1' && lane === 'L1') || (f === 'L2' && (lane === 'HEAL' || lane === 'GROW')) || (f === 'L3' && (lane === 'L3' || lane === 'REPLAY')) || (f === 'OPS' && lane === 'OPS');
    sec.style.display = ok || sec.classList.contains('nested') ? '' : 'none';
    if (f === 'L2' && lane === 'L1' && sec.querySelector('.tr-run.nested')) sec.style.display = '';
  },
  mark(cls, text, ev) {
    const m = h('div', { class: `tr-mark ${cls}` }, h('span', { class: 'tm-t' }, t(ev.vts)), h('span', {}, text));
    this.el.list.append(m);
    return m;
  },
  bump(k, n = 1) { this.counts[k] += n; if (this.onCount) this.onCount(this.counts); },
  after(ev) {
    this.el.cnt.textContent = `런 ${this.runs.length} · 단계 ${this.nspan.toLocaleString('ko-KR')}`;
    if (ev.backlog) {
      clearTimeout(this.backlogTimer);
      this.backlogTimer = setTimeout(() => { this.scroll(true); const last = [...this.spans.values()].reverse().find((x) => x.detail && AUTO_OPEN.has(x.kind)); if (last && !last.open) { this.toggle(last, false); this.autoOpened = last; } this.scroll(true); }, 350);
    } else this.scroll();
  },

  // ── 이벤트 ──────────────────────────────────────────────
  event(ev) {
    try { this.handle(ev); } catch (e) { console.error('trace', ev.type, e); }
    this.after(ev);
  },
  handle(ev) {
    const B = { backlog: ev.backlog };
    switch (ev.type) {
      case 'chapter': {
        if (ev.phase !== 'start') break;
        this.mark('chapter', `${ev.title} · ${ev.date}`, ev);
        if (this.replay) { this.replay.active = false; }
        this.lastL3 = null;
        break;
      }
      case 'story': {
        const cls = { done: 'done', warn: 'warn', error: 'bad', approval: 'gate', ops: 'ops' }[ev.level] || '';
        if (this.ops && this.ops.active && ev.level === 'ops') break;
        this.mark(`story ${cls}`, ev.text, ev);
        break;
      }
      case 'fault': this.mark('fault', ev.text, ev); break;
      case 'policy': this.mark('gate', `평가 기준 변경(사람만 가능): ${ev.section}.${ev.key} = ${ev.value} — ${ev.approver}: ${ev.reason}`, ev); break;
      case 'request': {
        const r = this.run(ev.request_id, 'L1', ev.text, `${ev.user || '엔지니어'} · ${t(ev.vts)}`);
        r.t0 = ev.vts;
        this.lastL1 = r;
        this.span(r, { kind: 'q', actor: ev.user || '엔지니어', title: ev.text, vts: ev.vts, data: B });
        break;
      }
      case 'node': this.onNode(ev); break;
      case 'code': this.onCode(ev); break;
      case 'jev': this.onJev(ev); break;
      case 'agent_start': this.onAgentStart(ev); break;
      case 'agent_end': this.onAgentEnd(ev); break;
      case 'thought': {
        const r = this.getRun(ev);
        if (!r) break;
        const sp = this.span(r, { kind: 'thought', actor: actorOf(ev.agent), title: ev.text, vts: ev.vts, bad: ev.kind === 'warn', status: ev.kind === 'ask' ? 'wait' : 'ok',
          detail: (d) => d.append(h('div', { class: 'tr-text' }, ev.text)), data: B });
        if (ev.text.length < 120) { sp.detail = null; sp.el.root.classList.remove('has'); sp.el.tog.textContent = ''; }
        break;
      }
      case 'response': {
        const r = this.getRun(ev);
        if (!r) break;
        const rt = RTYPE_KO[ev.rtype] || ev.rtype || '';
        const warn = (ev.blocks || []).some((b) => b.warn);
        const sp = this.span(r, { kind: 'response', actor: 'Super Agent', title: `응답 — ${rt}${ev.latency_ms ? ` · 가상 응답 ${(ev.latency_ms / 1000).toFixed(1)}s` : ''}`, vts: ev.vts,
          status: warn ? 'warn' : 'ok', detail: (d) => d.append(...(ev.blocks || []).map(renderBlock)), data: B });
        if (ev.rtype !== 'rework') this.autoOpen(sp, ev);
        if (ev.rtype === 'state' || ev.rtype === 'escalate' || (ev.rtype === 'judge' && false)) { /* 상태 반영은 node apply_state_change 에서 */ }
        break;
      }
      case 'fab_progress': {
        const r = this.getRun(ev);
        if (!r) break;
        this.span(r, { kind: 'fab', actor: 'Mock Fab', title: ev.text, vts: ev.vts, status: ev.override ? 'warn' : 'ok',
          detail: (d) => d.append(h('div', { class: 'tr-text' }, `${ev.chamber_id} · ${ev.attempt}회차 · Seasoning ${ev.count}매 · 소요 약 ${Math.floor(ev.minutes / 60)}시간 ${ev.minutes % 60}분 (가상 시각 진행)`),
            ev.override ? h('div', { class: 'tr-text warn' }, `엔지니어 Override: ${ev.override.count}매 — 사유 "${ev.override.reason}" (경험 메모리에 기록 → L3 학습 재료)`) : null), data: B });
        break;
      }
      case 'judge': {
        const r = this.getRun(ev);
        if (!r) break;
        const j = ev.judgement || {};
        const sp = this.span(r, { kind: 'judge', actor: 'judge_qual', title: `Spec 판정 → ${j.result}${j.fail_items?.length ? ` (${j.fail_items.join(', ')})` : ''} — 결정적 코드, LLM 미개입`, vts: ev.vts,
          status: j.result === 'PASS' ? 'ok' : j.result === 'FAIL' ? 'bad' : 'warn', detail: (d) => d.append(renderJudge(j, ev.count)), data: B });
        this.autoOpen(sp, ev);
        break;
      }
      case 'approval': this.onApproval(ev); break;
      case 'budget': {
        const r = this.byKey.get(ev.heal_id || ev.grow_id);
        if (r) this.setMeta(r, `예산 ${ev.attempts}/${ev.max_attempts}회 · ${ev.minutes}/${ev.max_minutes}분`);
        break;
      }
      case 'tests': this.onTests(ev); break;
      case 'heal': {
        const r = this.byKey.get(ev.heal_id) || this.lastL1;
        if (r) this.span(r, { kind: 'note', actor: 'Healer', title: ev.text, vts: ev.vts, data: B });
        break;
      }
      case 'report': {
        const r = this.byKey.get(ev.report_id);
        const sp = this.span(r || this.sysRun(), { kind: 'report', actor: '', title: ev.title, vts: ev.vts,
          detail: (d) => d.append(h('button', { class: 'btn small', onclick: () => window.Views?.openReport?.(ev.report_id) }, '리포트 열기'), reportSummary(ev)), data: B });
        if (r) { r.active = false; if (r.status === '진행 중') this.setStatus(r, '완료', 'done'); }
        void sp;
        break;
      }
      case 'version': this.onVersion(ev); break;
      case 'registry': {
        if (ev.event === 'baseline' && ev.backlog) break;
        const r = (this.lastL3 && this.lastL3.active) ? this.lastL3 : this.sysRun();
        this.span(r, { kind: 'registry', actor: 'Registry', title: `${AGENT_KO[ev.agent_id] || ev.agent_id} — ${ev.note || ev.event} (${STATUS_KO[ev.status] || ev.status})`, vts: ev.vts,
          status: ev.event === 'retire' ? 'gone' : ev.event === 'deprecate' ? 'warn' : 'ok', data: B });
        break;
      }
      case 'candidate': {
        const r = this.run(ev.run_id, 'L3', runTitle(ev.run_id), '', this.replay && this.replay.active ? 'replay' : null);
        this.lastL3 = r;
        const sp = this.span(r, { kind: 'candidate', actor: '평가 하네스', title: `${ev.cid} ${ev.title || ''} → ${ev.ok ? '채택' : '기각'}`, vts: ev.vts, status: ev.ok ? 'ok' : 'bad',
          detail: (d) => d.append(h('div', { class: 'tr-kv' },
            h('span', {}, '계층'), h('b', {}, ev.layer || '-'), h('span', {}, 'Evolve셋'), h('b', {}, `${ev.dE > 0 ? '+' : ''}${ev.dE ?? '-'}%p${ev.accE != null ? ` (${ev.accE}%)` : ''}`),
            h('span', {}, '검증셋(Held-out)'), h('b', {}, `${ev.dV > 0 ? '+' : ''}${ev.dV ?? '-'}%p${ev.accV != null ? ` (${ev.accV}%)` : ''}`)),
          h('div', { class: 'tr-text' }, ev.reason || '')), data: B });
        this.autoOpen(sp, ev);
        break;
      }
      case 'redirect': {
        const r = (this.lastL1 && this.lastL1.active) ? this.lastL1 : this.sysRun();
        this.span(r, { kind: 'redirect', actor: 'Runtime', title: `${short(ev.agent_id)} (deprecated) → ${short(ev.to)} 리다이렉트 ${ev.ok ? '성공' : `실패 → 원 Agent Fallback${ev.fallback ? ' 성공' : ''}`}${ev.error ? ` (${ev.error})` : ''}`, vts: ev.vts, status: ev.ok ? 'ok' : 'warn', data: B });
        break;
      }
      case 'shadow': {
        if (!ev.mismatch) break;
        const r = (this.lastL1 && this.lastL1.active) ? this.lastL1 : this.sysRun();
        this.span(r, { kind: 'shadow', actor: 'Runtime', title: `Shadow 불일치: ${short(ev.agent_id)} ${ev.primary} vs ${ev.shadow} (${ev.group}) — ${ev.detail}`, vts: ev.vts, status: 'bad', data: B });
        break;
      }
      case 'ops_batch': this.onOps(ev); break;
      case 'ops_case': {
        const r = this.ops || this.run(`ops:${ev.seq}`, 'OPS', '배경 운영 — 가상 엔지니어 요청 자율 처리', '');
        const ok = ev.result === 'PASS';
        this.span(r, { kind: 'ops', actor: ev.engineer || '엔지니어', title: ev.text, vts: ev.vts, status: ok ? 'ok' : ev.result ? 'warn' : 'ok',
          detail: (d) => d.append(h('div', { class: 'tr-text' }, `${ev.chamber_id} · ${PM_KO[ev.pm_type] || ev.pm_type} · 추천 ${ev.count}매 · 1차 ${ev.result || '-'} · 시도 ${ev.attempts}회 · 요청 ${ev.request_id}`),
            ev.override ? h('div', { class: 'tr-text warn' }, `Override ${ev.override.count}매 — ${ev.override.reason}`) : null), data: B });
        break;
      }
      case 'replay_progress': this.onReplay(ev); break;
      case 'replay_case': {
        const r = this.replayRun(ev);
        const sp = this.span(r, { kind: 'rcase', actor: '리플레이', title: `${ev.chamber_id} ${PM_KO[ev.pm_type] || ev.pm_type} — QH ${ev.qh_seq} 재생 (replay_clock ${String(ev.replay_clock || '').slice(0, 16)})`, vts: ev.vts, status: 'run', data: { ...B, qh: ev.qh_seq } });
        this.rcase = sp;
        this.byKey.set(`rc:${ev.qh_seq}`, sp);
        break;
      }
      case 'replay_case_done': {
        const sp = this.byKey.get(`rc:${ev.qh_seq}`);
        if (!sp) break;
        const c = ev.compare || {}, rec = ev.recommendation || {}, act = ev.actual || {};
        this.update(sp, { status: c.pred_ok && c.judge_ok ? 'ok' : 'warn', title: `${sp.title.replace(' 재생', '')} → 추천 ${rec.count ?? '-'}매 vs 당시 ${act.n1}매 ${act.q1 === 'P' ? 'PASS' : 'FAIL'} · 예측 ${c.pred_ok ? '일치' : '불일치'} · 판정 ${c.judge_ok ? '일치' : '불일치'}`,
          detail: (d) => d.append(h('div', { class: 'tr-text' }, `필요 추정 ${rec.required_est ?? '-'}매 · 당시 실제 ${act.n1}매 → 1차 ${act.q1 === 'P' ? 'PASS' : 'FAIL'} · Time-Travel Guard: replay_clock 이후 데이터 차단`),
            ...(rec.corrections || []).map((x) => h('div', { class: 'tr-text lesson' }, `${x.lesson_id} ${x.amount > 0 ? '+' : ''}${x.amount}매 — ${x.reason}`))) });
        this.autoOpen(sp, ev);
        break;
      }
      case 'replay_quarter': {
        const r = this.replayRun(ev);
        const sp = this.span(r, { kind: 'qres', actor: 'Evolver', title: `${ev.quarter} 결과 — 판정 일치율 ${ev.accuracy}% · 추천 오차 ±${ev.rec_error}매 · 교훈 +${ev.new_lessons || 0}/만료 ${ev.expired_lessons || 0}`, vts: ev.vts, status: 'ver',
          detail: (d) => d.append(...((ev.events || []).length ? ev.events.map((x) => h('div', { class: 'tr-text' }, x)) : [h('div', { class: 'muted' }, ev.split === 'heldout' ? 'Held-out — 진화 없이 평가만' : '진화 사건 없음')])), data: B });
        this.autoOpen(sp, ev);
        break;
      }
      default: break;
    }
  },

  getRun(ev) {
    const [lane, key] = laneRun(ev);
    if (!key) return null;
    let r = this.byKey.get(key);
    if (!r) {
      if (lane === 'L1') {
        // 요청 이벤트 없이 시작된 런 = 배경(가상 엔지니어) 요청의 복구 후 재응답 등 → 배경 운영 런 아래에 접어 둔다
        const bg = this.ops && this.ops.active ? this.ops.key : null;
        r = this.run(key, key.startsWith('RP') ? 'REPLAY' : 'L1', bg ? `배경 요청 ${key} — 복구 후 재분석·추가 응답` : `요청 ${key}`, '', this.replay && this.replay.active ? 'replay' : bg);
        if (!bg) this.lastL1 = r;
      }
      else if (lane === 'L3') { r = this.run(key, 'L3', runTitle(key), '', this.replay && this.replay.active ? 'replay' : null); this.lastL3 = r; }
      else r = this.run(key, lane, `${key}`, '', ev.request_id);
    }
    return r;
  },
  sysRun() {
    let r = this.byKey.get('registry');
    if (!r || this.runs.indexOf(r) < this.runs.length - 12) { if (r) this.byKey.delete('registry'); r = this.run('registry', 'SYS', 'Registry · 버전 반영', ''); }
    return r;
  },
  replayRun(ev) {
    let r = this.byKey.get('replay');
    if (!r) r = this.run('replay', 'REPLAY', '이력 리플레이 — 과거 Qual 이력 시간순 재생 (Walk-forward 진화 · Time-Travel Guard)', '');
    this.replay = r;
    void ev;
    return r;
  },

  onNode(ev) {
    const lane = laneOf(ev);
    const key = keyOf(ev);
    if (!lane || !key) return;
    let r = this.byKey.get(key);
    const B = { backlog: ev.backlog };
    if (!r) {
      if (lane === 'HEAL') r = this.run(key, 'HEAL', `${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.version || ''} 자가 복구 (Self-Healing)`, '', ev.request_id);
      else if (lane === 'GROW') r = this.run(key, 'GROW', `새 Agent 생성 (Agent Factory)${ev.agent_id ? ` — ${AGENT_KO[ev.agent_id] || ev.agent_id}` : ''}`, '', ev.request_id);
      else if (lane === 'L3') { r = this.run(key, 'L3', runTitle(key), '', this.replay && this.replay.active ? 'replay' : null); }
      else r = this.run(key, key.startsWith('RP') ? 'REPLAY' : 'L1', `요청 ${key}`, '', this.replay && this.replay.active ? 'replay' : null);
    }
    if (lane === 'L1') this.lastL1 = r;
    if (lane === 'L3') { this.lastL3 = r; r.active = true; }
    if (lane === 'GROW' && ev.agent_id && !r.title.includes(ev.agent_id) && !r.title.includes(AGENT_KO[ev.agent_id] || '∅')) { r.title += ` — ${AGENT_KO[ev.agent_id] || ev.agent_id}`; r.el.title.textContent = r.title; }
    const bad = !!BAD[ev.node]?.test(ev.detail || '');
    const n = ev.node;
    const actor = lane === 'HEAL' ? 'Healer' : lane === 'GROW' ? 'Agent Factory' : lane === 'L3' ? 'Evolver' : 'Super Agent';
    if (HIDE_NODES.has(n) && !(n === 'jev_classify_error' && /에스컬레이션/.test(ev.detail || ''))) {
      if (n === 'jev_route' && ev.route) {
        const sp = this.span(r, { kind: 'route', actor: 'Super Agent', title: `Agent 편성 → ${(ev.route.selected || []).map((x) => AGENT_KO[x] || short(x)).join(' + ') || '-'}`, vts: ev.vts,
          detail: (d) => renderRoute(d, ev.route), data: B });
        this.autoOpen(sp, ev);
      }
      return;
    }
    // CodeAct 노드: 바로 앞/뒤의 code 이벤트와 한 행으로 합친다
    if (CODE_NODES.has(n)) {
      const pend = r.pendingCode;
      if (pend && !pend.data.node) {
        this.update(pend, { title: `${pend.title} — ${ev.detail}`, data: { node: n } });
        r.pendingCode = null;
        return;
      }
      const sp = this.span(r, { kind: 'node', actor, title: ev.detail, vts: ev.vts, bad, data: { ...B, node: n, awaitCode: true } });
      r.pendingNode = sp;
      return;
    }
    if (n === 'execute_sandbox') {
      const box = r.sandbox && !r.sandbox.data.closed ? r.sandbox : this.sandboxBox(r, ev);
      const runs = ev.runs || [];
      const fails = runs.filter((x) => !x.ok).length;
      this.update(box, { title: `${ev.detail}${fails ? ` · 실패 ${fails}건` : ''}`, status: fails ? 'warn' : 'ok', data: { closed: true } });
      r.sandbox = null;
      for (const sp of r.spans) if (sp.kind === 'code' && sp.data.pipe) markPipe(sp, fails ? 'bad' : 'ok');
      return;
    }
    const KIND = { parse_request: 'parse', retrieve_memory: 'memory', log_experience: 'memory', observe: 'observe', mark_unavailable: 'heal', await_qual_result: 'wait',
      apply_state_change: 'state', write_spec: 'spec', start: 'node', escalate_operator: 'node', abort_with_reason: 'node' }[n] || 'node';
    let title = ev.detail || NODE_KO[n] || n;
    let detail = null;
    if (n === 'parse_request') {
      const en = ev.entities || {};
      title = `요청 해석 → ${RTYPE_KO[ev.rtype] || ev.rtype || ''} · ${en.chamber_id || en.eqp_id || en.eqp_prefix || ''}${en.pm_type ? ` · ${PM_KO[en.pm_type] || en.pm_type}` : ''}`;
      detail = (d) => renderEntities(d, en, ev.rtype, ev.detail);
    } else if (n === 'retrieve_memory' && ev.memory) {
      detail = (d) => d.append(h('div', { class: 'tr-text' }, `장비 모델·PM 종류 정확 일치 조건으로 조회 (RAG 미사용, 리플레이 중에는 replay_clock 이전 기록만)`),
        ev.memory.lesson_ids?.length ? h('div', { class: 'tr-chips' }, ...ev.memory.lesson_ids.map((x) => h('span', { class: 'chip-l' }, x))) : h('div', { class: 'muted' }, '적용 교훈 없음'));
    } else if (n === 'write_spec' && ev.spec) {
      detail = (d) => d.append(h('div', { class: 'tr-kv' }, ...Object.entries(ev.spec).flatMap(([k, v]) => [h('span', {}, k), h('b', {}, Array.isArray(v) ? v.join(', ') : String(v))])));
    } else if (n === 'start') {
      title = ev.detail;
    } else if (ev.detail && ev.detail.length > 110) {
      detail = (d) => d.append(h('div', { class: 'tr-text' }, ev.detail));
    }
    if (n === 'start' && lane === 'HEAL') this.setStatus(r, '복구 중', 'run');
    if (n === 'start' && lane === 'GROW') this.setStatus(r, '생성 중', 'run');
    const sp = this.span(r, { kind: KIND, actor: n === 'start' ? actor : actor, title, vts: ev.vts, bad, status: n === 'await_qual_result' || n === 'mark_unavailable' ? 'wait' : bad ? 'bad' : 'ok', detail, data: { ...B, node: n } });
    if (n === 'mark_unavailable') { sp.el.root.classList.add('st-warn'); }
    if (['parse_request', 'write_spec'].includes(n)) this.autoOpen(sp, ev);
    // 런 상태
    if (n === 'register_version') this.setStatus(r, `복구 완료 → ${ev.detail.match(/→ ([\d.]+)/)?.[1] || ''}`, 'done');
    if (n === 'escalate_operator') this.setStatus(r, '중단 → 운영자', 'bad');
    if (n === 'register_probation') this.setStatus(r, 'probation 등록', 'done');
    if (n === 'abort_with_reason') this.setStatus(r, '생성 중단', 'bad');
    if (n === 'log_experience') { this.setStatus(r, '완료', 'done'); r.active = false; }
    if (n === 'compare_actual') { this.setStatus(r, '채점 완료', 'done'); r.active = false; }
    if (n === 'apply_state_change') { this.update(sp, { status: /반려/.test(ev.detail) ? 'bad' : 'ok' }); }
    if (lane === 'L3' && ['promote', 'archive', 'auto_rollback'].includes(n)) this.setStatus(r, n === 'auto_rollback' ? '자동 롤백' : '완료', n === 'auto_rollback' ? 'bad' : 'done');
  },
  sandboxBox(r, ev) {
    const box = this.span(r, { kind: 'sandbox', actor: 'Sandbox', title: '샌드박스 실행 — 계획 코드가 하위 Agent를 호출합니다 (허용 import·권한 프록시·감사 로그)', vts: ev.vts, status: 'run', data: { backlog: ev.backlog } });
    r.sandbox = box;
    return box;
  },
  onCode(ev) {
    this.bump('code');
    const r = this.getRun(ev);
    if (!r) return;
    const kind = ev.agent === 'super_agent' ? 'plan' : ev.agent === 'healer' ? (ev.diff ? 'patch' : 'diag') : ev.agent === 'factory' ? (/스키마/.test(ev.purpose || '') ? 'explore' : 'gen') : 'plan';
    const actor = actorOf(ev.agent);
    const model = ev.model ? `${ev.model}${ev.source && ev.source !== 'online' ? ' · 오프라인 Playbook' : ''}` : (ev.template_id ? `편성 템플릿 ${ev.template_id} (LLM 생략)` : '');
    const title = `${ev.purpose || 'CodeAct'}${model ? ` · ${model}` : ''}`;
    const lines = String(ev.code || '').split('\n').length;
    const detail = (d, instant) => renderCode(d, { code: ev.code, diff: !!ev.diff, kind, output: ev.output, instant, sp });
    const pend = r.pendingNode;
    let sp;
    if (pend && pend.data.awaitCode && !pend.data.code) {
      sp = pend;
      pend.el.root.classList.remove('k-node'); pend.el.root.classList.add('k-code');
      pend.kind = 'code'; pend.el.badge.textContent = BADGE.code; pend.el.badge.hidden = false; pend.el.badge.className = 'sp-badge b-code';
      this.update(sp, { title: `${pend.title} — ${title}`, actor, data: { code: ev.code, pipe: kind, node: pend.data.node, awaitCode: false }, detail });
      r.pendingNode = null;
    } else {
      sp = this.span(r, { kind: 'code', actor, title: `${title} · ${lines} lines`, vts: ev.vts, detail, data: { backlog: ev.backlog, code: ev.code, pipe: kind } });
      r.pendingCode = sp;
    }
    sp.el.meta.textContent = `${t(ev.vts)} · ${lines}줄`;
    this.autoOpen(sp, ev);
  },
  onJev(ev) {
    this.bump('jev');
    const r = this.getRun(ev) || this.lastL3 || this.sysRun();
    const sel = Array.isArray(ev.answer) ? ev.answer : [ev.answer];
    const ans = sel.map((x) => AGENT_KO[x] || x).join(', ');
    const top = Math.max(...Object.values(ev.probs || { a: 0 }));
    const sp = this.span(r, { kind: 'jev', actor: 'Jev', title: `${HEAD_KO[ev.head] || ev.question || ev.head} → ${ans || '-'} (p=${top.toFixed(2)}${ev.threshold ? `, 자율 ≥${ev.threshold}` : ''})`, vts: ev.vts,
      detail: (d, instant) => renderJev(d, ev, instant), data: { backlog: ev.backlog } });
    this.autoOpen(sp, ev);
  },
  onAgentStart(ev) {
    const r = this.getRun(ev) || this.lastL1;
    if (!r) return;
    const key = `${ev.agent_id}:${ev.action}:${ev.indirect ? ev.caller : ''}`;
    let parent = null;
    if (ev.indirect && ev.caller && r.agentOpen?.[ev.caller]) parent = r.agentOpen[ev.caller];
    else { if (!r.sandbox || r.sandbox.data.closed) this.sandboxBox(r, ev); parent = r.sandbox; }
    const inputs = ev.inputs || {};
    const where = inputs.chamber_id || inputs.eqp_id || inputs.eqp_prefix || inputs.lot || '';
    const sp = this.span(r, { kind: 'agent', actor: `${AGENT_KO[ev.agent_id] || short(ev.agent_id)} ${ev.version}`, title: `${ev.action}(${where}) 실행 중…`, vts: ev.vts, status: 'run', parent,
      depth: (parent?.depth || 0) + 1, data: { backlog: ev.backlog, agent_id: ev.agent_id, inputs, tools_allowed: ev.tools_allowed, start: ev } });
    r.agentOpen = r.agentOpen || {};
    r.agentOpen[ev.agent_id] = sp;
    r.agentByKey = r.agentByKey || {};
    r.agentByKey[key] = sp;
  },
  onAgentEnd(ev) {
    this.bump('calls');
    const r = this.getRun(ev) || this.lastL1;
    if (!r) return;
    const key = `${ev.agent_id}:${ev.action}:${ev.indirect ? ev.caller : ''}`;
    let sp = r.agentByKey?.[key];
    if (!sp) {
      const parent = (!r.sandbox || r.sandbox.data.closed) ? this.sandboxBox(r, ev) : r.sandbox;
      sp = this.span(r, { kind: 'agent', actor: `${AGENT_KO[ev.agent_id] || short(ev.agent_id)} ${ev.version}`, title: '', vts: ev.vts, parent, depth: 1, data: { backlog: ev.backlog, agent_id: ev.agent_id, inputs: ev.inputs } });
    }
    if (r.agentByKey) delete r.agentByKey[key];
    if (r.agentOpen && r.agentOpen[ev.agent_id] === sp) delete r.agentOpen[ev.agent_id];
    const sum = ev.summary || [];
    const head = ev.ok ? (sum[0] || `status=${ev.status || 'ok'}`) : `✗ ${ev.error_type || '오류'}: ${String(ev.error || '').slice(0, 90)}`;
    const nTools = (ev.tools || []).reduce((a, x) => a + (x.n || 0), 0);
    this.update(sp, { title: `${ev.action} → ${head}`, status: ev.ok ? 'ok' : 'bad', meta: `${t(ev.vts)} · 도구 ${nTools}회 · ${Math.round(ev.io_ms || 0)}ms`,
      data: { end: ev, summary: sum, tools: ev.tools, error: ev.error, error_type: ev.error_type, violations: ev.violations, audit_id: ev.audit_id, status: ev.status },
      detail: (d) => renderAgent(d, sp.data) });
    if (!ev.ok || sum.length) this.autoOpen(sp, ev);
  },
  onApproval(ev) {
    if (ev.action === 'requested') {
      const p = ev.payload || {};
      let r = null;
      if (ev.kind === 'state_change' && p.request_id) r = this.byKey.get(p.request_id);
      if (!r && this.lastL3 && this.lastL3.active && ev.kind !== 'state_change') r = this.lastL3;
      if (!r) r = this.run(ev.request_id, ev.kind === 'state_change' ? 'L1' : 'L3', ev.title, `승인 요청 ${ev.request_id}`);
      const sp = this.span(r, { kind: 'approval', actor: '사람(운영자)', title: `승인 요청 — ${ev.title} · 대기 중`, vts: ev.vts, status: 'wait',
        detail: (d) => renderApproval(d, sp), data: { backlog: ev.backlog, apr: ev, pending: true } });
      this.apr.set(ev.request_id, sp);
      this.setStatus(r, '사람 승인 대기', 'wait');
      this.autoOpen(sp, ev);
    } else {
      const sp = this.apr.get(ev.request_id);
      const approver = ev.approver || '';
      if (!String(approver).includes('교대')) this.bump('human');
      if (!sp) return;
      this.update(sp, { title: `${ev.approved ? '승인' : '반려'} — ${ev.title} · ${approver}${ev.reason ? ` (${ev.reason})` : ''}`, status: ev.approved ? 'ok' : 'bad', data: { pending: false, decided: ev } });
      if (sp.run.status === '사람 승인 대기') this.setStatus(sp.run, ev.approved ? '승인됨 · 진행' : '반려됨', ev.approved ? 'run' : 'bad');
      if (!ev.approved) this.autoOpen(sp, ev);
    }
  },
  onTests(ev) {
    const r = this.byKey.get(ev.heal_id || ev.grow_id);
    if (!r) return;
    const key = `${r.key}:${ev.version}`;
    let sp = this.tests.get(key);
    if (!sp) {
      sp = this.span(r, { kind: 'tests', actor: '평가 하네스', title: `테스트 — ${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.version}`, vts: ev.vts, status: 'run',
        detail: (d) => renderTests(d, sp.data), data: { backlog: ev.backlog, cases: [], n: 0, fails: 0 } });
      this.tests.set(key, sp);
    }
    const D = sp.data;
    if (ev.n != null) D.n = Math.max(D.n, ev.n);
    D.cases.push({ ok: ev.ok, label: ev.label || ev.case, why: ev.why });
    if (ev.ok === false) D.fails += 1;
    const total = ev.heal_id ? `회귀 ${D.n}건 진행` : `${D.cases.length}건`;
    this.update(sp, { title: `테스트 — ${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.version} · ${total}${D.fails ? ` · 실패 ${D.fails}` : ''}`, status: D.fails ? 'bad' : 'run' });
    if (sp.open) this.renderDetail(sp, true);
    if (ev.ok === false) this.autoOpen(sp, ev);
  },
  onVersion(ev) {
    if (ev.kind === 'baseline' && ev.backlog) return;
    if (ev.kind === 'heal') this.bump('heal');
    if (ev.kind === 'grow') this.bump('grow');
    if (['evolve', 'compose', 'promote', 'restore'].includes(ev.kind)) this.bump('evolve');
    const r = this.byKey.get(ev.ref) || ((this.lastL3 && this.lastL3.active) ? this.lastL3 : this.sysRun());
    const sp = this.span(r, { kind: 'version', actor: 'Registry', title: `${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.from_version || '—'} → ${ev.to_version} · ${VKIND[ev.kind] || ev.kind}${ev.diff_add || ev.diff_del ? ` (+${ev.diff_add}/−${ev.diff_del})` : ''}`,
      vts: ev.vts, status: ev.kind === 'rollback' ? 'bad' : 'ver',
      detail: (d) => { d.append(h('div', { class: 'tr-text' }, ev.note || '')); if (ev.diff) d.append(h('div', { class: 'tr-code diff' }, ...diffLines(ev.diff))); }, data: { backlog: ev.backlog } });
    if (ev.diff || ev.kind === 'rollback') this.autoOpen(sp, ev);
    const tests = [...this.tests.values()].find((x) => x.run === r && x.status === 'run');
    if (tests && ev.kind === 'heal') this.update(tests, { status: 'ok' });
    if (ev.kind === 'heal' && r.lane === 'HEAL') this.setStatus(r, `복구 완료 → ${ev.to_version}`, 'done');
  },
  onOps(ev) {
    if (ev.phase === 'start') {
      const r = this.run(`ops:${ev.seq}`, 'OPS', `배경 운영 — 가상 엔지니어 AutoQual 요청 ${ev.n}건 자율 처리 (${ev.label || ''})`, `${ev.start.slice(5, 16)} → ${ev.end.slice(5, 16)}`);
      r.open = false; r.el.sec.classList.add('closed');
      this.ops = r;
      this.setStatus(r, `0/${ev.n}`, 'run');
    } else if (ev.phase === 'progress' && this.ops) this.setStatus(this.ops, `${ev.done}/${ev.n} 처리`, 'run');
    else if (ev.phase === 'end' && this.ops) { this.setStatus(this.ops, `${ev.n}건 완료 · Up 승인 교대 리더`, 'done'); this.ops.active = false; }
  },
  onReplay(ev) {
    const r = this.replayRun(ev);
    if (ev.phase === 'start') { this.setStatus(r, `0 / ${ev.total.toLocaleString()}`, 'run'); r.active = true; this.setMeta(r, `진화 구간 ${ev.evolve}분기 · Held-out ${ev.heldout}`); }
    if (ev.phase === 'quarter_start') this.span(r, { kind: 'quarter', actor: '', title: `${ev.quarter} 재생 시작 — ${ev.n}건 (${ev.split === 'heldout' ? 'Held-out: 진화 없이 평가만' : '진화 구간: 분기 말 L3 Evolve'})`, vts: ev.vts, status: 'ok', data: { backlog: ev.backlog } });
    if (ev.phase === 'case') this.setStatus(r, `${ev.done.toLocaleString()} / ${ev.total.toLocaleString()} · ${String(ev.replay_clock || '').slice(0, 10)} · Guard 차단 ${ev.guard ?? 0}`, 'run');
    if (ev.phase === 'end') { this.setStatus(r, '완료', 'done'); r.active = false; }
  },
};

/* ══════════════════════════════════════════════════════════
   상세 렌더러
   ══════════════════════════════════════════════════════════ */
function runTitle(id) {
  const k = Object.keys(RUN_KIND).find((p) => String(id).startsWith(p));
  return `L3 Evolve ${id}${k ? ` — ${RUN_KIND[k]}` : ''}`;
}

function renderEntities(d, en, rtype, detail) {
  const rows = [['요청 유형', RTYPE_KO[rtype] || rtype], ['장비', en.eqp_id || en.eqp_prefix || '-'], ['모델 / 군', `${en.eqp_model || '-'} / ${en.eqp_group || '-'}`],
    ['챔버', en.chamber_id || '-'], ['PM 종류', en.pm_type ? `${PM_KO[en.pm_type] || en.pm_type}` : '-'], ['PM 시각', en.pm_start ? `${en.pm_start} ~ ${en.pm_end}` : '-'],
    ['교체 부품', (en.parts || []).join(', ') || '-'], ['Lot', en.lot || '-']].filter((x) => x[1] !== '-' || ['장비', '챔버'].includes(x[0]));
  d.append(h('div', { class: 'tr-text muted' }, detail || ''), h('div', { class: 'tr-kv' }, ...rows.flatMap(([k, v]) => [h('span', {}, k), h('b', {}, v)])));
}

function renderRoute(d, route) {
  const sel = route.selected || [];
  d.append(h('div', { class: 'tr-text' }, `Jev 보정 확률로 편성 (처리 가능 p=${(route.can_handle ?? 0).toFixed(2)}) → ${sel.length}개 Agent ${sel.length > 1 ? '병렬' : ''} 호출`));
  const probs = route.probs || {};
  const box = h('div', { class: 'jv-bars' });
  for (const [k, p] of Object.entries(probs).sort((a, b) => b[1] - a[1])) {
    const c = sel.includes(k) ? 'sel' : (route.escalated || []).some((x) => x.agent_id === k) ? 'esc' : 'off';
    box.append(h('div', { class: `jv ${c}` }, h('span', { class: 'jv-k' }, AGENT_KO[k] || k), h('span', { class: 'jv-bar' }, h('i', { style: { width: `${Math.round(p * 100)}%` } })), h('span', { class: 'jv-v' }, p.toFixed(2))));
  }
  d.append(box);
  for (const e of route.escalated || []) d.append(h('div', { class: 'tr-text' }, `LLM 재검토: ${AGENT_KO[e.agent_id] || e.agent_id} p=${e.p.toFixed(2)} → ${e.keep ? '편입' : '제외'} (${e.why})`));
  for (const s of route.skipped || []) d.append(h('div', { class: 'tr-text' }, `편성 전략 생략: ${AGENT_KO[s.agent_id] || s.agent_id} — ${s.reason} [${s.rule}]`));
}

function renderJev(d, ev, instant) {
  const sel = Array.isArray(ev.answer) ? ev.answer : [ev.answer];
  const esc = (ev.escalated || []).map((x) => x.agent_id);
  d.append(h('div', { class: 'tr-text' }, `${ev.question || HEAD_KO[ev.head] || ev.head} — 보정 확률 (${ev.model || 'jev-local-calibrated'})${ev.threshold ? ` · 자율 ≥${ev.threshold}, 재검토 ≥0.60` : ''}`));
  const box = h('div', { class: 'jv-bars' });
  for (const [k, p] of Object.entries(ev.probs || {}).sort((a, b) => b[1] - a[1]).slice(0, 7)) {
    const c = sel.includes(k) ? 'sel' : esc.includes(k) ? 'esc' : 'off';
    const bar = h('i', { style: { width: instant ? `${Math.round(p * 100)}%` : '0%' } });
    box.append(h('div', { class: `jv ${c}` }, h('span', { class: 'jv-k' }, AGENT_KO[k] || k), h('span', { class: 'jv-bar' }, bar), h('span', { class: 'jv-v' }, p.toFixed(2))));
    if (!instant) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${Math.round(p * 100)}%`; }));
  }
  d.append(box);
  const f = ev.features || {};
  if (f.missing?.length) d.append(h('div', { class: 'tr-text warn' }, `부족한 능력: ${f.missing.join(', ')} → Grow`));
}

let typer = null;
function renderCode(d, { code, diff, kind, output, instant, sp }) {
  const pipe = h('div', { class: 'ca2-pipe' });
  const stages = (PIPE[kind] || PIPE.plan).map((txt, i) => { if (i) pipe.append(h('span', { class: 'pp-ar' }, '→')); const st = h('span', { class: `pp ${instant || i === 0 ? 'ok' : ''}` }, h('i', {}, String(i + 1)), txt); pipe.append(st); return st; });
  sp.el.pipe = stages;
  if (instant || sp.data.done) stages.forEach((st) => st.classList.add('ok'));
  const pre = h('pre', { class: `tr-code ${diff ? 'diff' : ''}` });
  d.append(pipe, pre);
  if (diff) pre.append(...diffLines(code));
  else if (instant || !spd()) { pre.innerHTML = highlight(code || ''); }
  else {
    clearInterval(typer);
    let i = 0;
    const src = code || '';
    const stepN = Math.max(6, Math.ceil(src.length / 70));
    typer = setInterval(() => {
      i = Math.min(src.length, i + stepN);
      pre.innerHTML = highlight(src.slice(0, i)) + (i < src.length ? '<span class="caret"></span>' : '');
      pre.scrollTop = pre.scrollHeight;
      if (i >= src.length) { clearInterval(typer); stages[1]?.classList.add('ok'); stages[2]?.classList.add('ok'); }
    }, Math.max(10, 22 / Math.max(0.5, spd())));
  }
  if (output) d.append(h('div', { class: 'tr-out' }, h('b', {}, '실행 결과 '), String(output)));
}
function markPipe(sp, state) {
  sp.data.done = true;
  if (sp.el.pipe) sp.el.pipe.forEach((st, i, arr) => { st.classList.remove('run'); st.classList.add(i === arr.length - 1 && state === 'bad' ? 'bad' : 'ok'); });
}

function renderAgent(d, D) {
  const st = D.start || {};
  const inputs = D.inputs || {};
  const ik = Object.entries(inputs).filter(([k]) => !['eqp_model', 'eqp_group'].includes(k));
  if (ik.length) d.append(h('div', { class: 'tr-chips' }, h('span', { class: 'chip-k' }, '입력'), ...ik.map(([k, v]) => h('span', { class: 'chip-i' }, `${k}=${v}`))));
  if (D.summary?.length) d.append(h('div', { class: 'tr-sub' }, '가져온 값 · 산출'), h('ul', { class: 'tr-vals' }, ...D.summary.map((x) => h('li', {}, x))));
  if (D.error) d.append(h('div', { class: 'tr-text bad' }, `${D.error_type || '오류'}: ${D.error}`), h('div', { class: 'tr-text muted' }, '→ 사후 검증 실패는 "확인 불가"로 표시되고 L2 Heal이 기동됩니다 (추측 답변 없음)'));
  else if (D.violations?.length) d.append(h('div', { class: 'tr-text bad' }, `사후 검증 위반: ${D.violations.join('; ')}`));
  const tools = D.tools || [];
  if (tools.length || st.tools_allowed) {
    const tb = h('table', { class: 'tr-tools' }, h('thead', {}, h('tr', {}, h('th', {}, '도구 (권한 프록시)'), h('th', { class: 'num' }, '호출'), h('th', { class: 'num' }, 'ms'))));
    const body = h('tbody');
    for (const x of tools) body.append(h('tr', { class: x.denied ? 'bad' : '' }, h('td', {}, x.tool, x.denied ? ' — 권한 없음(차단)' : ''), h('td', { class: 'num' }, x.n), h('td', { class: 'num' }, x.ms)));
    tb.append(body);
    d.append(h('div', { class: 'tr-sub' }, `도구 호출 ${tools.reduce((a, x) => a + (x.n || 0), 0)}회 · 허용 도구 ${(st.tools_allowed || []).length}개 (Genome에 선언된 것만)`), tb);
  }
  d.append(h('div', { class: 'tr-text muted' }, `감사 ${D.audit_id || '-'} · status=${D.status || '-'}${D.end?.replay ? ' · 리플레이(Time-Travel Guard)' : ''}${D.end?.guard ? ` · Guard 차단 ${D.end.guard}` : ''}`));
}

function renderBlock(b) {
  const cls = { recommendation: 'rec', judgement: 'judge', grow: 'grow', ask: 'warn', rework: 'warn', escalate: 'warn' }[b.kind] || '';
  const ul = h('ul', {});
  for (const ln of b.lines || []) {
    const li = h('li', {});
    const parts = String(ln).split(/(\[교훈 L-\d+[^\]]*\]|교훈 L-\d+|L-\d{4})/);
    for (const p of parts) li.append(/L-\d{4}/.test(p) ? h('span', { class: 'lesson' }, p) : p);
    ul.append(li);
  }
  return h('div', { class: `blk ${cls} ${b.warn ? 'warn' : ''}` }, h('h4', {}, b.title), ul);
}

export function renderJudge(j, count) {
  const box = h('div', { class: 'tr-judge' });
  const tb = h('table', { class: 'tr-tools' }, h('thead', {}, h('tr', {}, h('th', {}, '항목'), h('th', { class: 'num' }, '측정'), h('th', {}, 'Spec'), h('th', {}, '판정'))));
  const body = h('tbody');
  for (const x of j.details || []) {
    const conv = x.input_unit && x.input_unit !== x.unit ? ` (입력 ${fmtVal(x.input_value)} ${unitKo(x.input_unit)} → 환산)` : '';
    body.append(h('tr', { class: x.pass ? '' : 'bad' }, h('td', {}, ITEM_KO[x.item] || x.item), h('td', { class: 'num' }, `${fmtVal(x.value)} ${unitKo(x.unit)}${conv}`),
      h('td', {}, `${fmtSpec(x.spec)} ${unitKo(x.unit)}`), h('td', {}, x.pass ? (x.boundary ? '✓ 경계값 PASS' : '✓ PASS') : '✗ FAIL')));
  }
  for (const m of j.missing || []) body.append(h('tr', { class: 'warn' }, h('td', {}, ITEM_KO[m] || m), h('td', { class: 'num' }, '미측정'), h('td', {}, ''), h('td', {}, 'PASS 금지')));
  for (const hd of j.hold || []) body.append(h('tr', { class: 'warn' }, h('td', {}, ITEM_KO[hd.item] || hd.item), h('td', { class: 'num' }, fmtVal(hd.value)), h('td', {}, ''), h('td', {}, `보류 — ${hd.reason}`)));
  tb.append(body);
  box.append(tb, h('div', { class: `tr-verdict ${j.result === 'PASS' ? 'ok' : j.result === 'FAIL' ? 'bad' : 'warn'}` }, `Qual ${j.result}`,
    count ? h('span', { class: 'muted' }, ` · Seasoning ${count}매`) : null,
    j.rework ? h('span', { class: 'muted' }, ` · 재작업: ${{ reseason: '재Seasoning', bp_wait: 'BP 안정화 대기 후 재측정', purge: 'Purge 후 재측정' }[j.rework_type] || j.rework_type}`) : null));
  return box;
}

function renderApproval(d, sp) {
  const a = sp.data.apr;
  const p = a.payload || {};
  const lines = [];
  if (a.kind === 'state_change') {
    const ev = p.evidence || {}, j = ev.judgement || {};
    lines.push(`근거: judge_qual ${j.result} (${(j.details || []).map((x) => `${ITEM_KO[x.item] || x.item} ${fmtVal(x.value)}`).join(', ')})`);
    lines.push(`절차 ${ev.procedure} · Seasoning ${ev.count}매 · 시도 ${ev.attempts}회 · ${p.chamber_id} ${p.from_state} → ${p.to_state}`);
    lines.push('장비 상태 변경은 Jev 확신도와 무관하게 사람 승인 필수 (임계값 하한 0.95는 루프 밖 고정)');
  } else if (a.kind === 'evolution') (p.lines || []).forEach((x) => lines.push(x));
  else if (a.kind === 'promotion') { lines.push(`${p.agent_id} ${p.version}: ${p.why}`); lines.push(`테스트 ${p.tests} · 누적 호출 ${p.calls}건`); }
  else if (a.kind === 'retire') { lines.push(p.note || ''); lines.push(`유예 종료 ${String(p.grace_until || '').slice(0, 10)} · 대체 ${p.replacement || '-'}`); }
  d.append(...lines.map((x) => h('div', { class: 'tr-text' }, x)));
  if (sp.data.pending) {
    d.append(h('div', { class: 'tr-act' },
      h('button', { class: 'btn approve small', onclick: async () => { try { await api(`/api/approval/${a.request_id}`, { approved: true, approver: '운영자', reason: '' }); } catch (e) { A.toast(e.message, 'error'); } } }, '승인'),
      h('button', { class: 'btn danger small', onclick: async () => { try { await api(`/api/approval/${a.request_id}`, { approved: false, approver: '운영자', reason: '운영자 반려' }); } catch (e) { A.toast(e.message, 'error'); } } }, '반려')));
  } else if (sp.data.decided) {
    const x = sp.data.decided;
    d.append(h('div', { class: `tr-verdict ${x.approved ? 'ok' : 'bad'}` }, `${x.approved ? '승인' : '반려'} — ${x.approver}${x.reason ? ` (${x.reason})` : ''}`));
  }
}

function renderTests(d, D) {
  const list = h('div', { class: 'tr-tests' });
  for (const c of D.cases.slice(-40)) list.append(h('div', { class: `tt ${c.ok === false ? 'bad' : 'ok'}` }, h('i', {}), c.label || '', c.why && c.ok === false ? h('em', {}, ` — ${c.why}`) : null));
  d.append(h('div', { class: 'tr-text' }, '테스트 실행·채점은 루프 밖에 고정된 평가 하네스가 수행 (Agent가 수정 불가)'), list);
}

function reportSummary(ev) {
  const c = ev.content || {};
  const lines = [];
  if (ev.kind === 'heal') lines.push(`${c.agent_id} ${c.from_version} → ${c.to_version || '(미반영)'} · 유형 ${c.classification?.type} · ${c.status} · MTTR ${c.mttr}`, `원인: ${c.cause || '-'}`);
  if (ev.kind === 'grow') lines.push(...(c.lines || []).slice(0, 4));
  if (ev.kind === 'evolve' || ev.kind === 'rollback' || ev.kind === 'retire') lines.push(...(c.detect || []).slice(0, 3));
  return h('div', {}, ...lines.map((x) => h('div', { class: 'tr-text' }, x)));
}
