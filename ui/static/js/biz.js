// AutoQual 업무 흐름 — "이 Agent가 하는 일"이 10초 안에 읽히도록 비즈니스 흐름을 그린다.
//   PM Down → Qual 절차 → Seasoning 추천 → Seasoning·측정 → Spec 판정 → 사람 승인 → UP  (현재 건 스테퍼)
//   + Fab 90챔버 미니맵 + Agent가 처리한 Qual 이력(목업 운영 기간 전체) + 직접 요청 입력
import { $, h, api, vdate, fmtVal, fmtSpec, unitKo, ITEM_KO, PM_KO, RTYPE_KO, AGENT_KO, short } from './util.js';
import { renderJudge } from './trace.js';

let A = null;
const t = (vts) => vdate(vts).t;
const STEPS = [['pm', 'PM 완료'], ['proc', 'Qual 절차'], ['reco', '매수 추천'], ['meas', 'Seasoning·측정'], ['judge', 'Spec 판정'], ['apr', '사람 승인'], ['up', 'UP']];
const STEPS_OTHER = [['parse', '요청 해석'], ['exec', 'Agent 편성·실행'], ['ans', '응답']];
const STATE_KO = { RUN: '생산', DOWN: 'Down', QUAL: 'Qual 진행', APPROVAL: 'Up 승인 대기' };
const PRESETS = [
  'ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘',
  'CVD-05 A챔버 Showerhead 교체 PM 끝났어. AutoQual 진행해줘',
  'PVD-02 C챔버 Target 교체 끝났어. AutoQual 해줘',
  'Particle 15ea, ER 187.2 nm/min, Unif 2.4%',
  '지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘',
  'CVD-05 A챔버 PM 사이클 간 drift 추이 보여줘',
  'ETCH-07 B챔버 Wet Clean 최근 이력 보여줘',
];

export const Biz = {
  el: {}, quals: new Map(), focus: null, cases: [], fab: new Map(), caseIds: new Set(),
  init(app, host) {
    A = app;
    const e = this.el;
    e.cur = h('div', { class: 'bz-cur' });
    e.others = h('div', { class: 'bz-others' });
    e.fab = h('div', { class: 'bz-fab' });
    e.fabSum = h('span', { class: 'fp-r' }, '');
    e.hist = h('div', { class: 'bz-hist' });
    e.histStat = h('div', { class: 'bz-stat' });
    e.histSum = h('span', { class: 'fp-r' }, '');
    host.append(
      h('header', { class: 'fp-h bz-head' }, h('b', { class: 'kw gate' }, 'AUTOQUAL 업무 흐름'), h('span', { class: 'fp-d' }, 'PM으로 Down된 챔버를 Qual 거쳐 UP시키는 일')),
      h('div', { class: 'bz-def' },
        h('b', {}, 'AutoQual'), ' = 반도체 장비가 PM·부품 교체로 ', h('i', { class: 'dn' }, 'Down'), '된 뒤, Qual 절차를 정하고 Seasoning 웨이퍼를 몇 매 흘릴지 추천하고, 측정값을 Spec으로 판정해 사람 승인 후 ',
        h('i', { class: 'up' }, 'UP'), '시키는 업무. 아래 Agent가 이 판단·준비를 엔지니어 대신 수행합니다.'),
      h('section', { class: 'bz-sec bz-csec' }, h('div', { class: 'bz-sh' }, h('b', {}, '현재 진행 중인 AutoQual'), e.others), e.cur),
      h('section', { class: 'bz-sec bz-fsec' }, h('div', { class: 'bz-sh' }, h('b', {}, 'Fab 현황 — 장비 30대 · 챔버 90개'), e.fabSum), e.fab),
      h('section', { class: 'bz-sec bz-hsec' }, h('div', { class: 'bz-sh' }, h('b', {}, 'Agent가 처리한 Qual 이력'), e.histSum), e.histStat, e.hist),
      askForm());
    this.renderCur();
    this.renderFab();
    this.loadCases();
    A.on('*', (ev) => this.event(ev));
  },
  async loadCases() {
    try { this.cases = await api('/api/autoqual/cases?limit=150'); } catch (err) { this.cases = []; }
    for (const c of this.cases) this.caseIds.add(c.request_id || c.id);
    this.renderHist();
  },

  // ── 현재 건 ─────────────────────────────────────────────
  qual(id, create) {
    let q = this.quals.get(id);
    if (!q && create) {
      q = { id, text: '', user: '', ts: null, rtype: null, en: {}, steps: {}, lines: {}, attempts: [], alerts: [], done: false, judge: null, apr: null, rec: null, meas: null };
      this.quals.set(id, q);
    }
    return q;
  },
  setStep(q, key, status, lines) {
    q.steps[key] = status;
    if (lines) q.lines[key] = lines;
  },
  stepKeys(q) { return (q.rtype === 'autoqual' ? STEPS : STEPS_OTHER).map((x) => x[0]); },
  renderCur() {
    const e = this.el;
    e.cur.innerHTML = '';
    const q = this.focus ? this.quals.get(this.focus) : null;
    const act = [...this.quals.values()].filter((x) => !x.done && x !== q).slice(-4);
    e.others.innerHTML = '';
    for (const x of act) e.others.append(h('button', { class: 'bz-chip', onclick: () => { this.focus = x.id; this.renderCur(); } }, x.en.chamber_id || x.id));
    if (!q) {
      e.cur.append(h('div', { class: 'bz-empty' }, h('div', {}, '아직 진행 중인 AutoQual 건이 없습니다.'),
        h('div', { class: 'muted' }, 'Autopilot을 시작하거나 아래 입력창에 "ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘"처럼 요청하면 여기에 업무 흐름이 단계별로 채워집니다.')));
      return;
    }
    const en = q.en || {};
    const auto = q.rtype === 'autoqual';
    const steps = auto ? STEPS : STEPS_OTHER;
    if (q.collapsed == null && q.done) q.collapsed = true;      // 완료된 건은 스테퍼만 남기고 접는다 (이력 공간 확보)
    const tog = h('button', { class: 'bz-tog', onclick: () => { q.collapsed = !q.collapsed; this.renderCur(); } }, q.collapsed ? '▸ 단계 상세' : '▾ 접기');
    const head = h('div', { class: 'bz-qh' },
      h('div', { class: 'bz-qt' }, h('b', {}, en.chamber_id || en.eqp_id || en.eqp_prefix || q.id), en.eqp_model ? h('span', { class: 'muted' }, ` ${en.eqp_model}`) : null,
        h('span', { class: `bz-rt ${auto ? '' : 'o'}` }, RTYPE_KO[q.rtype] || (q.rtype ? q.rtype : '해석 중')), q.done ? h('span', { class: 'bz-done' }, '완료') : null, tog),
      h('div', { class: 'bz-qs' }, `${q.user || '엔지니어'} · ${t(q.ts)} · ${q.id}`, en.pm_type ? ` · ${PM_KO[en.pm_type] || en.pm_type}` : ''),
      h('div', { class: 'bz-qq' }, `“${q.text}”`));
    const stepper = h('div', { class: 'bz-steps' });
    steps.forEach(([k, label], i) => {
      const st = q.steps[k] || 'todo';
      stepper.append(h('div', { class: `bz-step ${st}` }, h('i', {}, st === 'done' ? '✓' : st === 'bad' ? '✗' : String(i + 1)), h('span', {}, label)));
    });
    const body = h('div', { class: 'bz-body' });
    if (q.collapsed) body.hidden = true;
    for (const [k, label] of steps) {
      const st = q.steps[k];
      if (!st) continue;
      const lines = q.lines[k] || [];
      const box = h('div', { class: `bz-sb ${st}` }, h('div', { class: 'bz-sl' }, label, st === 'active' ? h('em', {}, '진행 중') : st === 'wait' ? h('em', {}, '대기') : null));
      if (k === 'reco' && q.rec) box.append(h('div', { class: 'bz-big' }, h('b', {}, `${q.rec.count}매`), h('span', {}, 'Seasoning 웨이퍼 추천')));
      if (k === 'judge' && q.judge) box.append(renderJudge(q.judge, q.judgeCount));
      if (k === 'meas' && q.meas) box.append(h('div', { class: 'bz-meter' }, h('i', { style: { width: q.steps.meas === 'done' || q.judge ? '100%' : '0%' }, class: q.meas.live ? 'live' : '' }), h('span', {}, q.meas.text)));
      for (const ln of lines) box.append(h('div', { class: `bz-ln ${ln.cls || ''}` }, ln.text ?? ln));
      body.append(box);
    }
    for (const al of q.alerts.slice(-3)) body.append(h('div', { class: `bz-alert ${al.cls || ''}` }, al.text));
    e.cur.append(head, stepper, body);
    if (q.meas?.live) requestAnimationFrame(() => requestAnimationFrame(() => { const i = e.cur.querySelector('.bz-meter i'); if (i) i.style.width = '100%'; }));
  },

  // ── Fab ─────────────────────────────────────────────────
  renderFab() {
    const e = this.el;
    e.fab.innerHTML = '';
    const rows = A.state?.fab || [];
    for (const c of rows) if (!this.fab.has(c.chamber_id)) this.fab.set(c.chamber_id, c);
    const by = new Map();
    for (const c of this.fab.values()) { const eqp = c.chamber_id.slice(0, c.chamber_id.lastIndexOf('-')); if (!by.has(eqp)) by.set(eqp, []); by.get(eqp).push(c); }
    const cnt = { RUN: 0, DOWN: 0, QUAL: 0, APPROVAL: 0 };
    for (const c of this.fab.values()) cnt[c.state] = (cnt[c.state] || 0) + 1;
    e.fabSum.textContent = `생산 ${cnt.RUN} · Down ${cnt.DOWN} · Qual ${cnt.QUAL} · 승인 대기 ${cnt.APPROVAL}`;
    const focus = this.focus ? this.quals.get(this.focus)?.en?.chamber_id : null;
    const grid = h('div', { class: 'bz-fgrid' });
    for (const [eqp, chs] of [...by.entries()].sort()) {
      grid.append(h('div', { class: 'bz-eqp', title: eqp }, h('span', {}, eqp.replace('ETCH-', 'E').replace('CVD-', 'C').replace('PVD-', 'P')),
        h('div', { class: 'bz-chs' }, ...chs.sort((a, b) => (a.chamber_id > b.chamber_id ? 1 : -1)).map((c) => h('i', { class: `${c.state} ${c.chamber_id === focus ? 'focus' : ''}`, title: `${c.chamber_id} ${STATE_KO[c.state] || c.state}\n${c.note || ''}\n${c.since || ''}`, onclick: () => A.go('fab') })))));
    }
    e.fab.append(grid, h('div', { class: 'bz-fleg' }, ...[['RUN', '생산'], ['DOWN', 'Down(PM)'], ['QUAL', 'Qual 진행'], ['APPROVAL', 'Up 승인 대기']].map(([k, v]) => h('span', {}, h('i', { class: k }), v))));
  },

  // ── 이력 ────────────────────────────────────────────────
  renderHist() {
    const e = this.el;
    const rows = this.cases;
    e.hist.innerHTML = '';
    e.histStat.innerHTML = '';
    const n = rows.length;
    const p1 = rows.filter((x) => x.pass1 === true).length, ov = rows.filter((x) => x.override).length, rw = rows.reduce((a, x) => a + Math.max(0, (x.attempts || 1) - 1), 0);
    const corr = rows.filter((x) => (x.corrections || []).length).length;
    e.histSum.textContent = `${n}건`;
    e.histStat.append(...[[n, '처리 건수'], [n ? `${Math.round((p1 / n) * 100)}%` : '-', '1차 Pass'], [n ? `${Math.round((ov / n) * 100)}%` : '-', 'Override'], [n ? `${Math.round((corr / n) * 100)}%` : '-', '교훈 보정 적용'], [rw, '재작업']]
      .map(([v, k]) => h('div', { class: 'bz-st' }, h('b', {}, String(v)), h('span', {}, k))));
    if (!n) { e.hist.append(h('div', { class: 'bz-empty' }, 'Autopilot이 운영 기간을 진행하면 Agent가 자율 처리한 AutoQual 건이 여기 쌓입니다 (가상 엔지니어 요청 포함).')); return; }
    for (const c of rows.slice(0, 120)) {
      const res = c.pass1 === true ? 'PASS' : c.pass1 === false ? 'FAIL' : '-';
      e.hist.append(h('div', { class: `bz-row ${c.pass1 === false ? 'bad' : ''} ${c.escalated ? 'esc' : ''}`, title: `${c.request_id || ''} · Agent 버전 ${Object.entries(c.versions || {}).map(([k, v]) => `${short(k)} ${v}`).join(', ')}` },
        h('span', { class: 'bz-rt1' }, String(c.pm_end || c.ts || '').slice(5, 16)),
        h('span', { class: 'bz-rc' }, c.chamber_id), h('span', { class: 'bz-rp' }, PM_KO[c.pm_type] || c.pm_type),
        h('span', { class: 'bz-rn' }, `${c.count ?? '-'}매`, (c.corrections || []).length ? h('em', { title: `교훈 ${c.corrections.join(', ')} 적용` }, ` L`) : null, c.override ? h('em', { class: 'ov', title: `Override ${c.override.count}매 — ${c.override.reason}` }, ` →${c.override.count}`) : null),
        h('span', { class: `bz-rr ${res}` }, res, c.fail_items ? h('small', {}, ` ${c.fail_items}`) : null, (c.attempts || 1) > 1 ? h('small', {}, ` ×${c.attempts}`) : null),
        h('span', { class: 'bz-ra' }, c.escalated ? '에스컬레이션' : c.approved === false ? '반려' : `UP · ${(c.approver || '').replace('(교대 리더)', '')}`)));
    }
  },
  addCase(c) {
    const key = c.request_id || c.id;
    if (this.caseIds.has(key)) return;
    this.caseIds.add(key);
    this.cases.unshift(c);
    if (this.cases.length > 400) this.cases.pop();
    this.renderHist();
  },

  // ── 이벤트 ──────────────────────────────────────────────
  event(ev) {
    try { this.handle(ev); } catch (err) { console.error('biz', ev.type, err); }
  },
  handle(ev) {
    const rid = ev.request_id;
    switch (ev.type) {
      case '_state': this.renderFab(); break;
      case 'fab': { const c = this.fab.get(ev.chamber_id) || { chamber_id: ev.chamber_id }; Object.assign(c, { state: ev.state, note: ev.note, since: ev.vts }); this.fab.set(ev.chamber_id, c); this.renderFab(); break; }
      case 'request': {
        if (ev.source === 'sim') break;
        const q = this.qual(rid, true);
        Object.assign(q, { text: ev.text, user: ev.user, ts: ev.vts, collapsed: false });
        this.focus = rid;
        this.renderCur();
        break;
      }
      case 'node': this.onNode(ev); break;
      case 'response': this.onResponse(ev); break;
      case 'fab_progress': {
        const q = this.qual(rid);
        if (!q) break;
        q.meas = { text: ev.text, live: !ev.backlog };
        this.setStep(q, 'meas', 'active', [{ text: `${ev.attempt}회차 · 가상 시각 ${t(ev.vts)} 시작`, cls: 'muted' }, ev.override ? { text: `엔지니어 Override: ${ev.override.count}매 (${ev.override.reason})`, cls: 'warn' } : null].filter(Boolean));
        if (q.steps.judge) q.steps.judge = 'todo';
        this.renderCur();
        break;
      }
      case 'judge': {
        const q = this.qual(rid);
        if (!q) break;
        const j = ev.judgement || {};
        q.judge = j; q.judgeCount = ev.count;
        q.attempts.push({ count: ev.count, result: j.result, fail: j.fail_items });
        this.setStep(q, 'meas', 'done');
        this.setStep(q, 'judge', j.result === 'PASS' ? 'done' : j.result === 'FAIL' ? 'bad' : 'wait', []);
        if (j.result === 'PASS') this.setStep(q, 'apr', 'wait', [{ text: '사람(운영자) 승인 대기 — 무승인 장비 상태 변경 0건', cls: 'gate' }]);
        this.renderCur();
        break;
      }
      case 'approval': {
        if (ev.kind !== 'state_change') break;
        const key = ev.action === 'requested' ? (ev.payload || {}).request_id : this.aprMap?.[ev.request_id];
        const q = key ? this.qual(key) : null;
        if (!q) break;
        if (ev.action === 'requested') { this.aprMap = this.aprMap || {}; this.aprMap[ev.request_id] = key; this.setStep(q, 'apr', 'wait', [{ text: `승인 요청 ${ev.request_id}: ${ev.title}`, cls: 'gate' }]); }
        else {
          this.setStep(q, 'apr', ev.approved ? 'done' : 'bad', [{ text: `${ev.approved ? '승인' : '반려'} — ${ev.approver}${ev.reason ? ` (${ev.reason})` : ''} · ${t(ev.vts)}`, cls: ev.approved ? 'ok' : 'bad' }]);
          if (!ev.approved) this.setStep(q, 'up', 'bad', ['상태 DOWN 유지 — 반려 사유 경험 메모리 기록']);
        }
        this.renderCur();
        break;
      }
      case 'thought': {
        const q = this.qual(rid);
        if (q && ev.kind !== 'think') { q.alerts.push({ text: ev.text, cls: ev.kind === 'warn' ? 'warn' : 'ask' }); this.renderCur(); }
        break;
      }
      case 'ops_case': {
        const r = ev;
        this.addCase({ id: `ops:${ev.seq}`, request_id: ev.request_id, ts: ev.vts, pm_end: ev.vts, chamber_id: ev.chamber_id, pm_type: ev.pm_type, count: ev.count,
          pass1: r.result === 'PASS' ? true : r.result === 'FAIL' ? false : null, attempts: ev.attempts, override: ev.override, engineer: ev.engineer, approver: '교대 리더', approved: true });
        break;
      }
      case 'ops_batch': if (ev.phase === 'end' && !ev.backlog) this.loadCases(); break;
      case 'chapter': if (ev.phase === 'done' && !ev.backlog) this.loadCases(); break;
      default: break;
    }
  },
  onNode(ev) {
    if (ev.loop !== 'L1') {
      if (ev.loop === 'L2' && ev.request_id) {
        const q = this.qual(ev.request_id);
        if (!q) return;
        if (ev.node === 'start') q.alerts.push({ text: `${ev.sub === 'grow' ? 'Agent Factory' : 'Self-Healing'} 기동 — ${ev.detail}`, cls: 'l2' });
        if (ev.node === 'register_version' || ev.node === 'register_probation') q.alerts.push({ text: ev.detail, cls: 'ok' });
        if (['start', 'register_version', 'register_probation'].includes(ev.node)) this.renderCur();
      }
      return;
    }
    const q = this.qual(ev.request_id);
    if (!q) return;
    const n = ev.node;
    if (n === 'parse_request') {
      q.rtype = ev.rtype;
      q.en = ev.entities || {};
      const en = q.en;
      if (q.rtype === 'autoqual') {
        this.setStep(q, 'pm', 'done', [`${PM_KO[en.pm_type] || en.pm_type || 'PM'} ${en.pm_start ? `${String(en.pm_start).slice(5, 16)} ~ ${String(en.pm_end).slice(5, 16)}` : ''}`,
          (en.parts || []).length ? `교체 부품: ${en.parts.join(', ')}` : null, `장비 ${en.eqp_id} (${en.eqp_model} · ${en.eqp_group}) → 챔버 ${en.chamber_id} Down 상태`].filter(Boolean));
        this.setStep(q, 'proc', 'active', []);
      } else {
        this.setStep(q, 'parse', 'done', [`${RTYPE_KO[q.rtype] || q.rtype} — ${[en.eqp_id || en.eqp_prefix, en.chamber_id, en.pm_type ? PM_KO[en.pm_type] : null, en.lot].filter(Boolean).join(' · ')}`]);
        this.setStep(q, 'exec', 'active', []);
      }
      this.renderCur();
      this.renderFab();
    } else if (n === 'jev_route' && ev.route) {
      const key = q.rtype === 'autoqual' ? 'proc' : 'exec';
      const sel = (ev.route.selected || []).map((x) => AGENT_KO[x] || short(x)).join(' + ');
      q.lines[key] = [...(q.lines[key] || []), { text: `Agent 편성: ${sel}`, cls: 'muted' }];
      this.renderCur();
    } else if (n === 'mark_unavailable') {
      q.alerts.push({ text: `사후 검증 실패 항목 "확인 불가" 표시 → ${ev.detail}`, cls: 'warn' });
      this.renderCur();
    } else if (n === 'rework_plan') {
      q.lines.judge = [...(q.lines.judge || []), { text: `재작업 계획: ${ev.detail}`, cls: 'warn' }];
      this.setStep(q, 'meas', 'active');
      this.renderCur();
    } else if (n === 'apply_state_change') {
      const ok = !/반려/.test(ev.detail);
      this.setStep(q, 'up', ok ? 'done' : 'bad', [{ text: ev.detail, cls: ok ? 'ok' : 'bad' }]);
      this.renderCur();
    } else if (n === 'log_experience') {
      q.done = true;
      if (q.rtype === 'autoqual' && q.attempts.length) {
        const first = q.attempts[0];
        this.addCase({ id: q.id, request_id: q.id, ts: ev.vts, pm_end: q.en.pm_end, chamber_id: q.en.chamber_id, pm_type: q.en.pm_type, count: q.rec?.count,
          corrections: q.rec?.corrections || [], pass1: first.result === 'PASS', fail_items: (first.fail || []).join(','), attempts: q.attempts.length,
          approver: (q.lines.apr?.[0]?.text || '').match(/— ([^(·]+)/)?.[1]?.trim() || '운영자', approved: q.steps.up === 'done', escalated: q.steps.up !== 'done' && q.attempts.length >= 3 });
      }
      this.renderCur();
    }
  },
  onResponse(ev) {
    const q = this.qual(ev.request_id);
    if (!q) return;
    const auto = q.rtype === 'autoqual';
    for (const b of ev.blocks || []) {
      const k = b.kind;
      if (k === 'procedure' && auto) this.setStep(q, 'proc', 'done', [...(q.lines.proc || []).filter((x) => x.cls === 'muted'), ...b.lines.map((x) => ({ text: x, cls: b.warn ? 'warn' : '' }))]);
      if ((k === 'chamber' || k === 'history' || k === 'trend' || k === 'part') && auto) q.lines.reco = [...(q.lines.reco || []), { text: `${b.title.split(' · ')[0]}: ${b.lines[0] || ''}`, cls: b.warn ? 'warn' : 'muted' }];
      if (k === 'recommendation' && auto) {
        const m = /Seasoning (\d+)매/.exec(b.lines.join(' '));
        q.rec = { count: b.count ?? (m ? Number(m[1]) : null), corrections: (b.lines.join(' ').match(/L-\d{4}/g) || []) };
        this.setStep(q, 'reco', b.warn ? 'bad' : 'done', [...(q.lines.reco || []), ...b.lines.map((x) => ({ text: x, cls: b.warn ? 'warn' : '' }))]);
        if (!b.warn) this.setStep(q, 'meas', 'wait', [{ text: 'Mock Fab이 Seasoning·측정을 수행하면 측정값이 들어옵니다 (채팅으로 직접 입력도 가능)', cls: 'muted' }]);
      }
      if (k === 'ask') { q.alerts.push({ text: b.lines[0], cls: 'ask' }); q.done = true; }
      if (k === 'grow') q.alerts.push({ text: `${b.title}: ${b.lines[0] || ''}`, cls: b.warn ? 'bad' : 'l2' });
      if (k === 'rework') q.lines.judge = [...(q.lines.judge || []), ...b.lines.map((x) => ({ text: x, cls: 'warn' }))];
      if (k === 'escalate') { this.setStep(q, 'up', 'bad', b.lines.map((x) => ({ text: x, cls: 'bad' }))); q.done = true; }
      if (!auto && ['analysis', 'trend', 'history', 'procedure', 'judgement', 'chamber'].includes(k)) {
        this.setStep(q, 'exec', 'done');
        this.setStep(q, 'ans', b.warn ? 'bad' : 'done', [...(q.lines.ans || []), ...b.lines.slice(0, 5).map((x) => ({ text: x, cls: b.warn ? 'warn' : '' }))]);
        if (k === 'judgement') q.done = true;
      }
      if (k === 'routing' && !auto) q.lines.exec = [...(q.lines.exec || []), ...b.lines.slice(0, 1).map((x) => ({ text: x, cls: 'muted' }))];
    }
    if (!auto && ev.rtype && ev.rtype !== 'autoqual' && !['rework', 'state', 'judge'].includes(ev.rtype)) q.done = true;
    this.renderCur();
  },
};

function askForm() {
  const inp = h('input', { class: 'fl-in', list: 'bz-presets', placeholder: '엔지니어처럼 직접 요청해 보세요 (예시 ▾)', 'aria-label': '요청 입력' });
  const f = h('form', { class: 'bz-ask' }, inp, h('datalist', { id: 'bz-presets' }, ...PRESETS.map((p) => h('option', { value: p }))), h('button', { class: 'btn primary small', type: 'submit' }, '요청'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    try { await api('/api/chat', { text }); } catch (err) { A.toast(err.message, 'error'); }
  };
  return f;
}
