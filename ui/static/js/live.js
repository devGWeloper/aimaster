// 관제 화면 — 대화, Agent 편성 웨이퍼 맵, CodeAct, 사고 흐름
import { $, $$, h, s, api, vdate, esc, AGENT_KO, STATUS_KO, NODE_KO, HEAD_KO, short, diffLines, highlight } from './util.js';

let A = null;

/* ══════════════════════════════════════════════════════════
   대화
   ══════════════════════════════════════════════════════════ */
const Chat = {
  groups: new Map(),
  log: null,
  init() {
    this.log = $('#chat-log');
    const chips = [
      'ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘',
      'Particle 15ea, ER 187.2 nm/min, Unif 2.4%',
      '지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘',
      '7호기 B챔버 Wet Clean 끝났어',
      'ETCH-07 B챔버 Wet Clean 최근 이력 보여줘',
      'CVD-05 A챔버 PM 사이클 간 drift 추이 보여줘',
    ];
    const box = $('#chips');
    for (const c of chips) box.append(h('button', { type: 'button', title: c, onclick: () => { $('#chat-text').value = c; $('#chat-text').focus(); } }, c));
    $('#chat-form').onsubmit = async (e) => {
      e.preventDefault();
      const t = $('#chat-text').value.trim();
      if (!t) return;
      $('#chat-text').value = '';
      try { await api('/api/chat', { text: t }); } catch (err) { A.toast(err.message, 'error'); }
    };
    $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
    this.empty = h('div', { class: 'empty', style: { margin: '18px 4px' } },
      h('div', { style: { color: 'var(--ink)', fontWeight: 650, marginBottom: '6px' } }, '상단 Autopilot 버튼을 누르면 시나리오 타임라인이 자동으로 진행됩니다'),
      h('div', {}, '이력 리플레이(SC-006)부터 불필요 Agent 폐기(SC-009)까지 Agent가 스스로 판단·생성·복구·진화합니다. 아래 입력창으로 직접 요청을 보낼 수도 있습니다.'));
    this.log.append(this.empty);
  },
  group(rid) {
    let g = this.groups.get(rid);
    if (!g) {
      g = h('div', { class: 'msg-bot', 'data-rid': rid });
      this.groups.set(rid, g);
      this.log.append(g);
    }
    return g;
  },
  scroll() { this.log.scrollTop = this.log.scrollHeight; },
  request(ev) {
    this.empty?.remove();
    const u = h('div', { class: 'msg-user' }, h('div', { class: 'who' }, `${ev.user || '엔지니어'} · ${vdate(ev.vts).t}`), ev.text);
    this.log.append(u);
    const g = h('div', { class: 'msg-bot', 'data-rid': ev.request_id });
    this.groups.set(ev.request_id, g);
    this.log.append(g);
    this.trim();
    this.scroll();
  },
  response(ev) {
    const g = this.group(ev.request_id);
    if (!g.querySelector('.who')) g.append(h('div', { class: 'who' }, h('span', { class: 'tag' }, 'Super Agent'), `${ev.request_id} · ${vdate(ev.vts).t}` + (ev.latency_ms ? ` · 가상 응답 ${(ev.latency_ms / 1000).toFixed(1)}s` : '')));
    for (const b of ev.blocks || []) g.append(block(b));
    this.trim();
    this.scroll();
  },
  fab(ev) {
    const g = this.group(ev.request_id);
    g.append(h('div', { class: 'fabline' }, `Mock Fab · ${ev.text}`));
    this.scroll();
  },
  replayCase(ev) {
    this.empty?.remove();
    const g = h('div', { class: 'msg-bot' });
    const c = ev.compare || {};
    const rec = ev.recommendation || {};
    g.append(h('div', { class: 'who' }, h('span', { class: 'tag', style: { color: 'var(--l3)' } }, '리플레이'), `${ev.quarter} · QH ${ev.qh_seq}`),
      h('div', { class: 'blk' }, h('h4', {}, `${ev.chamber_id || ''} ${ev.pm_type || ''} — 과거 건 재생 (replay_clock 기준 데이터만)`),
        h('ul', {}, h('li', {}, `추천 ${rec.count ?? '-'}매 (필요 추정 ${rec.required_est ?? '-'}) · 당시 실제 ${ev.actual?.n1}매 → 1차 ${ev.actual?.q1 === 'P' ? 'PASS' : 'FAIL'}`),
          h('li', {}, `1차 Pass 예측 ${c.pred_ok ? '일치' : '불일치'} · judge_qual 판정 ${c.judge_ok ? '일치' : '불일치'}`),
          ...(rec.corrections || []).map((x) => h('li', { class: 'lesson' }, `${x.lesson_id} ${x.amount > 0 ? '+' : ''}${x.amount}매 — ${x.reason}`)))));
    this.log.append(g);
    this.trim();
    this.scroll();
  },
  trim() { while (this.log.children.length > 180) this.log.firstChild.remove(); },
};

function block(b) {
  const cls = { recommendation: 'rec', judgement: 'judge', grow: 'grow' }[b.kind] || '';
  const ul = h('ul', {});
  for (const ln of b.lines || []) {
    const li = h('li', {});
    const parts = String(ln).split(/(\[교훈 L-\d+[^\]]*\]|교훈 L-\d+)/);
    for (const p of parts) li.append(/교훈 L-\d+/.test(p) ? h('span', { class: 'lesson' }, p) : p);
    ul.append(li);
  }
  return h('div', { class: `blk ${cls} ${b.warn ? 'warn' : ''}` }, h('h4', {}, b.title), ul);
}

/* ══════════════════════════════════════════════════════════
   웨이퍼 맵
   ══════════════════════════════════════════════════════════ */
const CX = 320, CY = 300, R = 262;
const MAIN = { super_agent: [CX, CY], spec_agent: [CX - 150, CY - 112], log_agent: [CX + 150, CY - 112], legacy_agent: [CX, CY + 128] };
const SLOTS = [[CX + 168, CY + 58], [CX - 168, CY + 58], [CX + 104, CY + 196], [CX - 104, CY + 196], [CX + 200, CY - 20], [CX - 200, CY - 20]];
const SKILL_SLOTS = [[CX - 132, CY - 208], [CX - 44, CY - 222], [CX + 44, CY - 222], [CX + 132, CY - 208]];
const PORTS = {
  jev: { x: CX - 238, y: CY - 70, label: 'Jev 판단', c: 'var(--gate)' },
  sandbox: { x: CX + 238, y: CY - 70, label: 'Sandbox', c: 'var(--l1)' },
  healer: { x: CX - 222, y: CY + 128, label: 'Healer', c: 'var(--l2)' },
  factory: { x: CX + 222, y: CY + 128, label: 'Factory', c: 'var(--l2)' },
  evolver: { x: CX - 70, y: CY + 248, label: 'Evolver', c: 'var(--l3)' },
  harness: { x: CX + 70, y: CY + 248, label: 'Harness', c: 'var(--l3)' },
};

const Wafer = {
  svg: null, dies: new Map(), pos: new Map(), links: null, dieLayer: null, fxLayer: null, ports: {},
  init() {
    const svg = $('#wafer');
    this.svg = svg;
    const defs = s('defs', {},
      s('clipPath', { id: 'wclip' }, s('circle', { cx: CX, cy: CY, r: R - 1 })),
      s('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        s('rect', { width: 6, height: 6, fill: '#2a2c26' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#4a4230', 'stroke-width': 2.4 })),
      s('radialGradient', { id: 'wsheen', cx: '38%', cy: '30%', r: '75%' },
        s('stop', { offset: '0%', 'stop-color': '#2b3a48' }), s('stop', { offset: '55%', 'stop-color': '#1c2630' }), s('stop', { offset: '100%', 'stop-color': '#18212a' })));
    svg.append(defs);
    svg.append(s('circle', { cx: CX, cy: CY, r: R, fill: 'url(#wsheen)', class: 'w-edge' }));
    const grid = s('g', { 'clip-path': 'url(#wclip)', class: 'w-grid' });
    const P = 24;
    for (let x = CX - R; x <= CX + R; x += P) grid.append(s('line', { x1: x, y1: CY - R, x2: x, y2: CY + R }));
    for (let y = CY - R; y <= CY + R; y += P) grid.append(s('line', { x1: CX - R, y1: y, x2: CX + R, y2: y }));
    svg.append(grid);
    svg.append(s('path', { d: `M ${CX - 14} ${CY + R + 2} A 14 14 0 0 1 ${CX + 14} ${CY + R + 2}`, fill: 'var(--bg)', stroke: '#3b4a58', 'stroke-width': 1.5 }));
    this.links = s('g', {});
    svg.append(this.links);
    const pl = s('g', {});
    for (const [k, p] of Object.entries(PORTS)) {
      const w = 74;
      const g = s('g', { class: 'w-port', transform: `translate(${p.x - w / 2},${p.y - 12})`, style: `--c:${p.c}` },
        s('rect', { width: w, height: 24, rx: 12 }), s('text', { x: w / 2, y: 16, 'text-anchor': 'middle' }, p.label));
      this.ports[k] = g;
      pl.append(g);
    }
    svg.append(pl);
    this.dieLayer = s('g', {});
    this.fxLayer = s('g', {});
    svg.append(this.dieLayer, this.fxLayer);
    $('#wafer-legend').append(
      h('span', {}, h('i', {}), '운영(active)'), h('span', {}, h('i', { class: 'p' }), '시험 운영(probation)'),
      h('span', {}, h('i', { class: 'd' }), '폐기 유예(deprecated)'), h('span', {}, h('i', { class: 'r' }), '폐기(retired, 아카이브)'),
      h('span', {}, '점선 = 공용 스킬 의존'));
  },
  layout(agents) {
    const used = new Set();
    let si = 0;
    const order = agents.filter((a) => a.kind === 'agent' && !MAIN[a.agent_id]).sort((a, b) => (a.created_ts > b.created_ts ? 1 : -1));
    for (const a of agents) if (MAIN[a.agent_id]) this.pos.set(a.agent_id, MAIN[a.agent_id]);
    for (const a of order) { if (!this.pos.has(a.agent_id)) { this.pos.set(a.agent_id, SLOTS[si % SLOTS.length]); } si += 1; }
    let k = 0;
    for (const a of agents.filter((x) => x.kind === 'skill')) { if (!this.pos.has(a.agent_id)) this.pos.set(a.agent_id, SKILL_SLOTS[Math.min(k, SKILL_SLOTS.length - 1)]); k += 1; }
    void used;
  },
  render(reg) {
    if (!reg) return;
    const agents = reg.agents.filter((a) => a.active_version || a.kind === 'skill');
    this.layout(agents);
    // 링크
    this.links.innerHTML = '';
    for (const a of agents) {
      if (a.kind === 'agent') this.links.append(s('path', { class: 'link', d: curve(MAIN.super_agent, this.pos.get(a.agent_id)) }));
      for (const sk of Object.keys(a.deps?.skills || {})) if (this.pos.has(sk)) this.links.append(s('path', { class: 'link skill', d: curve(this.pos.get(a.agent_id), this.pos.get(sk), 0.08) }));
      for (const ag of a.deps?.agents || []) if (this.pos.has(ag)) this.links.append(s('path', { class: 'link', d: curve(this.pos.get(a.agent_id), this.pos.get(ag), 0.2), 'stroke-dasharray': '6 3' }));
    }
    for (const a of agents) {
      const [x, y] = this.pos.get(a.agent_id);
      const isSuper = a.agent_id === 'super_agent';
      const isSkill = a.kind === 'skill';
      const w = isSuper ? 136 : isSkill ? 84 : 112, hgt = isSuper ? 66 : isSkill ? 34 : 54;
      let g = this.dies.get(a.agent_id);
      const cls = ['die', isSuper ? 'super' : '', isSkill ? 'skill' : '', a.status].join(' ');
      if (!g) {
        g = s('g', { class: cls, transform: `translate(${x - w / 2},${y - hgt / 2})`, tabindex: 0, role: 'button', 'aria-label': a.agent_id });
        g.append(s('rect', { class: 'body', width: w, height: hgt, rx: isSkill ? 5 : 8 }));
        g.append(s('text', { class: 'nm', x: w / 2, y: isSkill ? 21 : 22, 'text-anchor': 'middle' }, AGENT_KO[a.agent_id] || short(a.agent_id)));
        if (!isSkill) {
          g.append(s('text', { class: 'vr', x: w / 2, y: 38, 'text-anchor': 'middle' }, ''));
          g.append(s('text', { class: 'st', x: w / 2, y: hgt - 5, 'text-anchor': 'middle' }, ''));
        }
        g.addEventListener('click', () => { A.go('registry'); setTimeout(() => window.Views?.openAgent?.(a.agent_id), 50); });
        this.dieLayer.append(g);
        this.dies.set(a.agent_id, g);
        if (!A.booting && !isSuper) this.patterning(x, y, w, hgt);
      }
      const keep = [...g.classList].filter((c) => ['calling', 'error', 'healing', 'evolving', 'flash'].includes(c));
      g.setAttribute('class', [cls, ...keep].join(' '));
      const vr = g.querySelector('text.vr');
      if (vr) vr.textContent = `${short(a.agent_id).replace('super', 'super')} ${a.active_version}`;
      const st = g.querySelector('text.st');
      if (st) st.textContent = isSuper ? `편성 ${a.direct_calls ? '' : ''}CodeAct 계획` : `${STATUS_KO[a.status] || a.status}${a.shadow_version ? ` · Shadow ${a.shadow_version}` : ''}`;
      if (isSkill) g.querySelector('text.nm').textContent = `${AGENT_KO[a.agent_id] || a.agent_id} ${a.active_version}`;
    }
  },
  patterning(x, y, w, hgt) {
    const g = s('g', { class: 'pattern' });
    const n = 12;
    for (let i = 0; i < n; i += 1) {
      const r = s('rect', { x: x - w / 2 + (i % 4) * (w / 4), y: y - hgt / 2 + Math.floor(i / 4) * (hgt / 3), width: w / 4 - 1, height: hgt / 3 - 1, opacity: 0 });
      r.animate([{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }], { duration: 900, delay: i * 70, fill: 'forwards' });
      g.append(r);
    }
    this.fxLayer.append(g);
    setTimeout(() => g.remove(), 2200);
  },
  mark(agent, cls, ms) {
    const g = this.dies.get(agent);
    if (!g) return;
    g.classList.add(cls);
    if (ms) setTimeout(() => g.classList.remove(cls), ms);
  },
  unmark(agent, cls) { this.dies.get(agent)?.classList.remove(cls); },
  pulse(from, to, ind) {
    const a = this.pos.get(from) || MAIN.super_agent, b = this.pos.get(to);
    if (!b) return;
    const p = s('path', { d: curve(a, b), fill: 'none', stroke: ind ? 'var(--l3)' : 'var(--l1)', 'stroke-width': 2, opacity: 0.9 });
    const len = 400;
    p.style.strokeDasharray = `14 ${len}`;
    this.fxLayer.append(p);
    p.animate([{ strokeDashoffset: 14 }, { strokeDashoffset: -len }], { duration: 650, easing: 'ease-in' });
    setTimeout(() => p.remove(), 700);
  },
  port(k, ms = 1400) {
    const g = this.ports[k];
    if (!g) return;
    g.classList.add('hot');
    clearTimeout(g._t);
    g._t = setTimeout(() => g.classList.remove('hot'), ms);
  },
  scan(agent) {
    const g = this.dies.get(agent);
    if (!g) return;
    const r = g.querySelector('rect.body');
    const w = Number(r.getAttribute('width')), hh = Number(r.getAttribute('height'));
    const bar = s('rect', { class: 'scan', x: 0, y: 0, width: 6, height: hh, rx: 2 });
    g.append(bar);
    bar.animate([{ transform: 'translateX(0px)' }, { transform: `translateX(${w - 6}px)` }], { duration: 900, iterations: 3, direction: 'alternate' });
    setTimeout(() => bar.remove(), 2800);
  },
};

function curve(a, b, bend = 0.15) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return `M ${a[0]} ${a[1]} Q ${mx - dy * bend} ${my + dx * bend} ${b[0]} ${b[1]}`;
}

/* ══════════════════════════════════════════════════════════
   CodeAct
   ══════════════════════════════════════════════════════════ */
const Code = {
  timer: null,
  show(ev) {
    const pre = $('#ca-code');
    const who = AGENT_KO[ev.agent] || ev.agent;
    $('#ca-meta').innerHTML = `<b>${esc(who)}</b> ${esc(ev.purpose || '')}${ev.model ? ` · ${esc(ev.model)}${ev.source && ev.source !== 'online' ? ' (오프라인 Playbook)' : ''}` : ''}`;
    clearInterval(this.timer);
    pre.innerHTML = '';
    if (ev.diff) {
      pre.append(...diffLines(ev.code));
      pre.scrollTop = 0;
    } else if (ev.backlog || !A.state?.speed) {
      pre.innerHTML = highlight(ev.code || '');
    } else {
      const code = ev.code || '';
      let i = 0;
      const step = Math.max(6, Math.ceil(code.length / 60));
      this.timer = setInterval(() => {
        i = Math.min(code.length, i + step);
        pre.innerHTML = highlight(code.slice(0, i)) + (i < code.length ? '<span class="caret"></span>' : '');
        pre.scrollTop = pre.scrollHeight;
        if (i >= code.length) clearInterval(this.timer);
      }, 22);
    }
    const foot = $('#ca-foot');
    foot.innerHTML = '';
    foot.append(h('span', { class: 'pill ok' }, 'AST 정적 검사 통과'), h('span', { class: 'pill ok' }, '허용 import 화이트리스트'), h('span', { class: 'pill' }, '읽기 전용 권한 프록시'));
    if (ev.output) foot.append(h('span', { class: 'pill', title: ev.output }, `실행 결과: ${String(ev.output).slice(0, 70)}`));
  },
  exec(ev) {
    const foot = $('#ca-foot');
    foot.querySelectorAll('.pill.run').forEach((p) => p.remove());
    for (const r of ev.runs || []) foot.append(h('span', { class: `pill run ${r.ok ? 'ok' : 'bad'}` }, `${short(r.agent_id)} ${r.version} ${r.ok ? '완료' : '실패'}`));
  },
  tests(ev) {
    const foot = $('#ca-foot');
    let p = foot.querySelector('.pill.tst');
    if (!p) { p = h('span', { class: 'pill tst l2' }); foot.append(p); }
    p.textContent = `회귀 테스트 ${ev.version || ''} — ${ev.n || ''}건 진행${ev.ok === false ? ` · 실패: ${ev.label || ev.case}` : ''}`;
    p.classList.toggle('bad', ev.ok === false);
  },
};

/* ══════════════════════════════════════════════════════════
   사고 흐름
   ══════════════════════════════════════════════════════════ */
const Stream = {
  log: null, filter: 'all', heals: {}, progressRow: null,
  init() {
    this.log = $('#stream-log');
    $$('#stream-filters button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; $$('#stream-filters button').forEach((x) => x.classList.toggle('on', x === b)); this.apply(); }; });
  },
  apply() { $$('.ev', this.log).forEach((r) => { r.style.display = this.filter === 'all' || r.dataset.cat === this.filter ? '' : 'none'; }); },
  add(cat, cls, kind, body, ev) {
    const row = h('div', { class: `ev ${cls}`, 'data-cat': cat }, h('div', { class: 't' }, vdate(ev.vts).t), h('div', { class: 'b' }, kind ? h('span', { class: 'k' }, kind) : null, body));
    if (this.filter !== 'all' && this.filter !== cat) row.style.display = 'none';
    this.log.append(row);
    while (this.log.children.length > 320) this.log.firstChild.remove();
    if (!ev.backlog) this.log.scrollTop = this.log.scrollHeight;
    return row;
  },
  text(t) { return h('span', { class: 'x' }, t); },
  jev(ev) {
    const wrap = h('div', { class: 'probs' });
    const entries = Object.entries(ev.probs || {}).sort((a, b) => b[1] - a[1]).slice(0, 7);
    const sel = Array.isArray(ev.answer) ? ev.answer : [ev.answer];
    const esc_ = (ev.escalated || []).map((x) => x.agent_id);
    for (const [k, p] of entries) {
      const c = sel.includes(k) ? 'sel' : esc_.includes(k) ? 'esc' : 'off';
      wrap.append(h('div', { class: `prob ${c}` }, h('span', {}, AGENT_KO[k] ? `${AGENT_KO[k]}` : k), h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round(p * 100)}%` } })), h('span', { class: 'v' }, p.toFixed(2))));
    }
    const label = HEAD_KO[ev.head] || ev.question;
    const ans = Array.isArray(ev.answer) ? ev.answer.map((x) => AGENT_KO[x] || x).join(', ') : ev.answer;
    const cat = ['classify_error', 'unrecoverable', 'need_grow'].includes(ev.head) ? 'L2' : (['need_evolve', 'need_merge', 'need_retire'].includes(ev.head) ? 'L3' : 'L1');
    this.add(cat, cat, 'Jev', h('span', {}, h('span', { class: 'x' }, `${label} → ${ans}`), ev.head === 'route' && ev.threshold ? h('span', { class: 'muted' }, ` (자율 ≥${ev.threshold}, 재검토 ≥0.60)`) : null, wrap), ev);
  },
};

function onEvent(ev) {
  const W = Wafer;
  switch (ev.type) {
    case 'request': Chat.request(ev); break;
    case 'response': Chat.response(ev); break;
    case 'fab_progress': Chat.fab(ev); break;
    case 'replay_case_done': Chat.replayCase(ev); break;
    case 'code': Code.show(ev); if (!ev.backlog) W.port('sandbox'); break;
    case 'agent_start':
      if (!ev.backlog) { W.mark(ev.agent_id, 'calling'); W.pulse(ev.caller || 'super_agent', ev.agent_id, ev.indirect); W.port('sandbox', 900); }
      break;
    case 'agent_end':
      if (!ev.backlog) {
        W.unmark(ev.agent_id, 'calling');
        if (!ev.ok) W.mark(ev.agent_id, 'error', 2600);
      }
      if (!ev.ok && !ev.backlog) Stream.add('L1', 'bad', short(ev.agent_id), Stream.text(`${ev.version} 실행 실패 — ${String(ev.error || '').slice(0, 120)}`), ev);
      break;
    case 'jev': Stream.jev(ev); if (!ev.backlog) W.port('jev'); break;
    case 'node': {
      const loop = ev.loop;
      Loops.set(loop, ev);
      const kind = `${loop} ${NODE_KO[ev.node] || ev.node}`;
      if (loop === 'L1' && ['parse_request', 'retrieve_memory', 'jev_route', 'plan_codeact', 'observe', 'mark_unavailable', 'deterministic_judge', 'approval_gate', 'apply_state_change', 'rework_plan'].includes(ev.node)) {
        Stream.add('L1', ev.node === 'approval_gate' ? 'gate' : 'L1', kind, Stream.text(ev.detail || ''), ev);
      } else if (loop !== 'L1') {
        Stream.add(loop === 'L2' ? 'L2' : 'L3', loop, kind, Stream.text(ev.detail || ''), ev);
      }
      if (ev.node === 'execute_sandbox') Code.exec(ev);
      if (!ev.backlog) {
        if (loop === 'L2' && ev.agent_id) { W.mark(ev.agent_id, 'healing', 3500); W.port(ev.sub === 'grow' ? 'factory' : 'healer'); if (ev.node === 'write_patch' || ev.node === 'diagnose_codeact') W.scan(ev.agent_id); }
        if (loop === 'L2' && ev.sub === 'grow') W.port('factory');
        if (loop === 'L3') { W.port('evolver'); if (ev.node === 'evaluate_harness') W.port('harness'); }
      }
      break;
    }
    case 'tests': Code.tests(ev); if (!ev.backlog) W.port('harness', 800); break;
    case 'version':
      if (ev.kind === 'baseline' && ev.backlog) break;
      Stream.add(ev.kind === 'rollback' ? 'L3' : (ev.kind === 'heal' || ev.kind === 'grow' ? 'L2' : 'L3'), ev.kind === 'rollback' ? 'bad' : 'ver', '버전',
        Stream.text(`${AGENT_KO[ev.agent_id] || ev.agent_id}  ${ev.from_version || '—'} → ${ev.to_version}  (${({ heal: 'Heal 패치', evolve: 'Evolve 채택', compose: '구성 변경', rollback: '자동 롤백', promote: '정식 승격', grow: 'Grow 생성', baseline: '초기 구축', restore: '복원' })[ev.kind] || ev.kind}${ev.ref ? ' ' + ev.ref : ''})` + (ev.diff_add || ev.diff_del ? `  +${ev.diff_add}/−${ev.diff_del}` : '')), ev);
      if (!ev.backlog) W.mark(ev.agent_id, 'flash', 1300);
      break;
    case 'approval':
      if (String(ev.approver || '').includes('교대')) break;
      if (ev.action === 'requested') Stream.add('L1', 'gate', '승인 요청', Stream.text(ev.title), ev);
      else Stream.add('L1', 'gate', ev.approved ? '승인' : '반려', Stream.text(`${ev.title} — ${ev.approver}${ev.reason ? ` (${ev.reason})` : ''}`), ev);
      break;
    case 'story': Stream.add('all', 'story', null, Stream.text(ev.text), ev); break;
    case 'fault': Stream.add('L2', 'bad', '장애 주입', Stream.text(ev.text), ev); break;
    case 'candidate': Stream.add('L3', ev.ok ? 'L3' : 'L3', '후보', Stream.text(`${ev.cid} ${ev.reason}`), ev); if (!ev.backlog) W.port('harness'); break;
    case 'redirect': Stream.add('L3', 'gate', '리다이렉트', Stream.text(`${short(ev.agent_id)} → ${short(ev.to)} ${ev.ok ? '성공' : `실패 → 원 Agent Fallback${ev.fallback ? ' 성공' : ''}`}${ev.error ? ` (${ev.error})` : ''}`), ev);
      if (!ev.backlog) W.pulse(ev.agent_id, ev.to, true);
      break;
    case 'shadow': if (ev.mismatch) Stream.add('L3', 'bad', 'Shadow 불일치', Stream.text(`${short(ev.agent_id)} ${ev.primary} vs ${ev.shadow} (${ev.group}) — ${ev.detail}`), ev); break;
    case 'ops_case': Stream.add('ops', 'ops', '배경', Stream.text(ev.text), ev); break;
    case 'ops_batch':
      if (ev.phase === 'start') Stream.add('ops', 'ops', '배경 운영', Stream.text(`${ev.start.slice(5, 16)} → ${ev.end.slice(5, 16)} · PM ${ev.n}건 (${ev.label})`), ev);
      break;
    case 'replay_progress':
      if (ev.phase === 'start') Stream.add('L3', 'story', '리플레이', Stream.text(`과거 Qual 이력 ${ev.total.toLocaleString()}건 시간순 재생 시작 (진화 ${ev.evolve} · Held-out ${ev.heldout})`), ev);
      if (ev.phase === 'quarter_start') Stream.add('L3', 'L3', '리플레이', Stream.text(`${ev.quarter} 재생 — ${ev.n}건 (${ev.split === 'heldout' ? 'Held-out: 진화 없이 평가만' : '진화 구간'})`), ev);
      Loops.replay(ev);
      break;
    case 'replay_quarter':
      Stream.add('L3', 'ver', ev.quarter, Stream.text(`판정 일치율 ${ev.accuracy}% · 추천 오차 ±${ev.rec_error}매 · 교훈 +${ev.new_lessons}/만료 ${ev.expired_lessons}` + (ev.events?.length ? ` · ${ev.events.length}개 사건` : '')), ev);
      break;
    case 'report': if (!ev.backlog) Stream.add(ev.kind === 'heal' || ev.kind === 'grow' ? 'L2' : 'L3', ev.kind === 'heal' || ev.kind === 'grow' ? 'L2' : 'L3', '리포트', h('a', { href: '#reports', class: 'x', onclick: () => setTimeout(() => window.Views?.openReport?.(ev.report_id), 60) }, ev.title), ev); break;
    case 'policy': Stream.add('L3', 'gate', '평가 기준', Stream.text(`${ev.section}.${ev.key} = ${ev.value} (${ev.approver}: ${ev.reason})`), ev); break;
    case 'registry': if (!ev.backlog && ev.event !== 'baseline') Stream.add('L3', 'L3', 'Registry', Stream.text(`${AGENT_KO[ev.agent_id] || ev.agent_id} — ${ev.note || ev.event}`), ev); break;
    case 'heal': Stream.add('L2', 'L2', 'Heal', Stream.text(ev.text), ev); break;
    case 'thought': if (ev.kind === 'warn' || ev.kind === 'ask') Stream.add('L1', ev.kind === 'warn' ? 'bad' : 'L1', '판단', Stream.text(ev.text), ev); break;
    case '_state': Wafer.render(ev.state.registry); break;
    default: break;
  }
}

const Loops = {
  el: {},
  init() {
    const box = $('#loops');
    for (const [k, t] of [['L1', 'L1 Task'], ['L2', 'L2 Heal·Grow'], ['L3', 'L3 Evolve']]) {
      const e = h('div', { class: `lp ${k}` }, h('i', { class: 'lamp' }), h('b', {}, t), h('span', { class: 'lp-node' }, '대기'));
      this.el[k] = e;
      box.append(e);
    }
  },
  set(loop, ev) {
    const e = this.el[loop];
    if (!e) return;
    e.querySelector('.lp-node').textContent = NODE_KO[ev.node] || ev.node;
    e.title = ev.detail || '';
    if (ev.backlog) return;
    e.classList.add('on');
    clearTimeout(e._t);
    e._t = setTimeout(() => e.classList.remove('on'), 4500 / Math.max(0.5, A.state?.speed || 1));
  },
  replay(ev) {
    const e = this.el.L3;
    if (ev.phase === 'case') e.querySelector('.lp-node').textContent = `리플레이 ${ev.done}/${ev.total} · ${String(ev.replay_clock || '').slice(0, 10)}`;
    if (!ev.backlog) { e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('on'), 3000); }
  },
};

export const Live = {
  init(app) {
    A = app;
    A.booting = true;
    Chat.init();
    Wafer.init();
    Stream.init();
    Loops.init();
    Wafer.render(A.state?.registry);
    A.on('*', onEvent);
    setTimeout(() => { A.booting = false; }, 2500);
  },
};
