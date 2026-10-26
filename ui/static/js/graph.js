// Agent 편성 그래프 — Super Agent가 어떤 Agent를 코드로 호출하는지, 각 Agent가 무슨 값을 가져왔는지, 누가 태어나고(Grow) 고쳐지고(Heal) 진화하고 폐기되는지를 실시간으로 그린다.
//   createGraph(app, host, opts) 로 여러 곳(무대·대화)에 독립 인스턴스를 만든다. opts.live = 대화용 동적 모드(단계 라벨·값 칩 유지·호출 순번)
import { h, s, AGENT_KO, STATUS_KO, short } from './util.js';

const VB = { w: 1000, h: 400 };
const SUPER = { x: 500, y: 62 };
const ROW_AGENT = 190, ROW_SKILL = 300;
const PORTS = {
  jev: { x: 92, y: 62, label: 'Jev 판단', c: 'var(--jev)', sub: '보정 확률' },
  memory: { x: 92, y: 118, label: '경험 메모리', c: 'var(--l1)', sub: '교훈·사례' },
  sandbox: { x: 908, y: 62, label: 'Sandbox', c: 'var(--l1)', sub: 'AST·프록시·감사' },
  harness: { x: 908, y: 118, label: '평가 하네스', c: 'var(--ok)', sub: '루프 밖 고정' },
  healer: { x: 92, y: 300, label: 'Healer', c: 'var(--l2)', sub: 'L2 Heal · 자기 코드 패치' },
  factory: { x: 500, y: 374, label: 'Agent Factory', c: 'var(--l2)', sub: 'L2 Grow · 새 Agent 생성' },
  evolver: { x: 908, y: 300, label: 'Evolver', c: 'var(--l3)', sub: 'L3 Evolve · 변이·평가·선택' },
};
const MAIN = ['spec_agent', 'log_agent', 'legacy_agent'];
const STEP_KO = { parse_request: '요청 해석', retrieve_memory: '경험 메모리 조회', jev_route: 'Jev 편성', grow_subgraph: 'Grow 대기', plan_codeact: 'CodeAct 계획 작성', execute_sandbox: '샌드박스 실행',
  observe: '사후 검증', mark_unavailable: '확인 불가 표시 → Heal', synthesize: '결과 종합', respond: '응답', await_qual_result: 'Qual 결과 대기', deterministic_judge: 'judge_qual 판정',
  rework_plan: '재작업 계획', approval_gate: '사람 승인 대기', apply_state_change: '상태 반영', log_experience: '경험 기록' };

export function createGraph(app, host, opts = {}) {
  const A = app;
  const live = !!opts.live;
  const spd = () => (A && A.state ? Number(A.state.speed) : 1);
  const ms = (base) => { const v = spd(); return v ? base / Math.max(0.5, v) : 0; };
  const G = {
    svg: null, layers: {}, nodes: new Map(), pos: new Map(), ports: {}, booted: false, chips: new Map(), seq: 0, reqId: null,
    init() {
      const svg = s('svg', { viewBox: `0 0 ${VB.w} ${VB.h}`, class: 'ag-svg', role: 'img', 'aria-label': 'Agent 편성 그래프' });
      const uid = Math.random().toString(36).slice(2, 7);
      G.uid = uid;
      svg.append(s('defs', {},
        s('pattern', { id: `ag-hatch-${uid}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
          s('rect', { width: 6, height: 6, fill: '#2a2c26' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#4a4230', 'stroke-width': 2.4 })),
        s('marker', { id: `ag-arr-${uid}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' }, s('path', { d: 'M0 0L8 4L0 8z', fill: '#4a5a6a' }))));
      G.layers.links = s('g', { class: 'ag-links' });
      G.layers.fx = s('g', { class: 'ag-fx' });
      G.layers.nodes = s('g', { class: 'ag-nodes' });
      G.layers.chips = s('g', { class: 'ag-chips' });
      const pl = s('g', { class: 'ag-ports' });
      for (const [k, p] of Object.entries(PORTS)) {
        const w = 128;
        const g = s('g', { class: 'ag-port', transform: `translate(${p.x - w / 2},${p.y - 16})`, style: `--c:${p.c}` },
          s('rect', { width: w, height: 32, rx: 8 }), s('text', { class: 'pt', x: w / 2, y: 13, 'text-anchor': 'middle' }, p.label), s('text', { class: 'ps', x: w / 2, y: 26, 'text-anchor': 'middle' }, p.sub));
        G.ports[k] = g;
        pl.append(g);
      }
      // 대화 모드: Super Agent 아래 '지금 단계' 라벨
      G.stepLabel = s('g', { class: 'ag-step', transform: `translate(${SUPER.x},${SUPER.y + 44})` }, s('rect', { x: -120, y: -10, width: 240, height: 20, rx: 10 }), s('text', { y: 4, 'text-anchor': 'middle' }, ''));
      G.stepLabel.style.display = 'none';
      svg.append(G.layers.links, pl, G.layers.fx, G.layers.nodes, G.layers.chips, G.stepLabel);
      host.append(
        h('header', { class: 'fp-h' }, h('b', { class: 'kw l1' }, 'AGENT 편성'), h('span', { class: 'fp-d' }, live ? '요청이 처리되는 동안 Super Agent가 누구를 부르고 무엇을 받아오는지' : 'Super Agent가 코드로 호출하는 Agent · 가져온 값 · 생성/치유/진화/폐기'), G.right = h('span', { class: 'fp-r' }, '')),
        h('div', { class: 'ag-wrap' }, svg),
        h('div', { class: 'ag-leg' }, h('span', {}, h('i', { class: 'a' }), '운영(active)'), h('span', {}, h('i', { class: 'p' }), '시험 운영(probation)'), h('span', {}, h('i', { class: 'd' }), '폐기 유예'),
          h('span', {}, h('i', { class: 'r' }), '폐기(아카이브)'), h('span', {}, h('i', { class: 'k' }), '공용 스킬(점선 의존)'), h('span', {}, h('i', { class: 'v' }), '값 칩 = 이번 호출에서 가져온 값')));
      G.svg = svg;
      G.render(A.state?.registry);
      setTimeout(() => { G.booted = true; }, 1500);
      return G;
    },
    layout(agents) {
      const ag = agents.filter((a) => a.kind === 'agent' && a.agent_id !== 'super_agent');
      const order = [...MAIN.filter((x) => ag.some((a) => a.agent_id === x)), ...ag.filter((a) => !MAIN.includes(a.agent_id)).sort((a, b) => (a.created_ts > b.created_ts ? 1 : -1)).map((a) => a.agent_id)];
      const x0 = 190, x1 = 810;
      const stepA = order.length > 1 ? (x1 - x0) / (order.length - 1) : 0;
      G.pos.set('super_agent', [SUPER.x, SUPER.y]);
      order.forEach((id, i) => G.pos.set(id, [order.length > 1 ? x0 + i * stepA : 500, ROW_AGENT]));
      const sk = agents.filter((a) => a.kind === 'skill').map((a) => a.agent_id);
      const sx0 = 250, sx1 = 750;
      const stepS = sk.length > 1 ? (sx1 - sx0) / (sk.length - 1) : 0;
      sk.forEach((id, i) => G.pos.set(id, [sk.length > 1 ? sx0 + i * stepS : 500, ROW_SKILL]));
    },
    render(reg) {
      if (!reg) return;
      const agents = reg.agents.filter((a) => a.active_version || a.kind === 'skill');
      G.layout(agents);
      G.layers.links.innerHTML = '';
      for (const a of agents) {
        const p = G.pos.get(a.agent_id);
        if (!p) continue;
        if (a.kind === 'agent' && a.agent_id !== 'super_agent') G.layers.links.append(s('path', { class: `ag-link ${a.status}`, d: curve(G.pos.get('super_agent'), p), 'data-to': a.agent_id }));
        for (const skid of Object.keys(a.deps?.skills || {})) if (G.pos.has(skid)) G.layers.links.append(s('path', { class: 'ag-link skill', d: curve(p, G.pos.get(skid), 0.05) }));
        for (const dep of a.deps?.agents || []) if (G.pos.has(dep)) G.layers.links.append(s('path', { class: 'ag-link ind', d: curve(p, G.pos.get(dep), 0.25), 'marker-end': `url(#ag-arr-${G.uid})` }));
      }
      const seen = new Set();
      for (const a of agents) {
        const p = G.pos.get(a.agent_id);
        if (!p) continue;
        seen.add(a.agent_id);
        const isSuper = a.agent_id === 'super_agent', isSkill = a.kind === 'skill';
        const w = isSuper ? 190 : isSkill ? 110 : 128, hgt = isSuper ? 56 : isSkill ? 34 : 54;
        let g = G.nodes.get(a.agent_id);
        const cls = ['ag-node', isSuper ? 'super' : '', isSkill ? 'skill' : '', a.status, a.shadow_version ? 'shadow' : ''].join(' ');
        if (!g) {
          g = s('g', { class: cls, tabindex: 0, role: 'button', 'aria-label': a.agent_id, transform: `translate(${p[0] - w / 2},${p[1] - hgt / 2})` },
            s('rect', { class: 'body', width: w, height: hgt, rx: isSkill ? 6 : 9 }),
            s('text', { class: 'nm', x: w / 2, y: isSkill ? 15 : 19, 'text-anchor': 'middle' }, ''),
            s('text', { class: 'vr', x: w / 2, y: isSkill ? 28 : 34, 'text-anchor': 'middle' }, ''),
            isSkill ? null : s('text', { class: 'st', x: w / 2, y: hgt - 7, 'text-anchor': 'middle' }, ''),
            s('g', { class: 'badge-new' }, s('rect', { x: w - 34, y: -9, width: 38, height: 16, rx: 8 }), s('text', { x: w - 15, y: 3, 'text-anchor': 'middle' }, 'NEW')),
            s('g', { class: 'badge-seq' }, s('circle', { cx: 0, cy: 0, r: 9 }), s('text', { y: 3.5, 'text-anchor': 'middle' }, '')));
          g.addEventListener('click', () => { A.go('registry'); setTimeout(() => window.Views?.openAgent?.(a.agent_id), 50); });
          G.layers.nodes.append(g);
          G.nodes.set(a.agent_id, g);
          if (G.booted && !isSuper) G.birth(a.agent_id, p, w, hgt);
        } else {
          g.setAttribute('transform', `translate(${p[0] - w / 2},${p[1] - hgt / 2})`);
        }
        const keep = [...g.classList].filter((c) => ['calling', 'error', 'healing', 'evolving', 'flash', 'born', 'done', 'seq'].includes(c));
        g.setAttribute('class', [cls, ...keep].join(' '));
        if (a.status === 'deprecated') g.querySelector('rect.body').style.fill = `url(#ag-hatch-${G.uid})`;
        g.querySelector('text.nm').textContent = isSuper ? 'Super Agent' : AGENT_KO[a.agent_id] || short(a.agent_id);
        const vr = g.querySelector('text.vr');
        const prevV = vr.dataset.v;
        vr.textContent = `${short(a.agent_id)} ${a.active_version || ''}`;
        if (prevV && prevV !== a.active_version && G.booted) G.flash(a.agent_id, `${prevV} → ${a.active_version}`);
        vr.dataset.v = a.active_version || '';
        const st = g.querySelector('text.st');
        if (st) st.textContent = isSuper ? '요청 해석 · Jev 편성 · CodeAct 계획' : `${STATUS_KO[a.status] || a.status}${a.shadow_version ? ` · Shadow ${a.shadow_version}` : ''}${a.status === 'deprecated' && a.replacement ? ` → ${short(a.replacement)}` : ''}`;
        g.dataset.w = w; g.dataset.h = hgt;
      }
      for (const [id, g] of G.nodes) if (!seen.has(id)) { g.remove(); G.nodes.delete(id); }
    },
    birth(id, p, w, hgt) {
      const g = G.nodes.get(id);
      g.classList.add('born');
      const fx = s('g', { class: 'ag-birth' });
      for (let i = 0; i < 12; i += 1) {
        const r = s('rect', { x: p[0] - w / 2 + (i % 4) * (w / 4), y: p[1] - hgt / 2 + Math.floor(i / 4) * (hgt / 3), width: w / 4 - 1, height: hgt / 3 - 1, opacity: 0 });
        r.animate([{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }], { duration: ms(900) || 300, delay: i * (ms(70) || 20), fill: 'forwards' });
        fx.append(r);
      }
      G.layers.fx.append(fx);
      setTimeout(() => { fx.remove(); }, (ms(900) || 300) + 12 * (ms(70) || 20) + 200);
      setTimeout(() => g.classList.remove('born'), ms(30000) || 8000);
      G.chip(id, '새 Agent 생성 (probation)', 'l2', 9000);
    },
    mark(id, cls, dur) { const g = G.nodes.get(id); if (!g) return; g.classList.add(cls); if (dur) setTimeout(() => g.classList.remove(cls), dur); },
    unmark(id, cls) { G.nodes.get(id)?.classList.remove(cls); },
    flash(id, label) { G.mark(id, 'flash', 1400); if (label) G.chip(id, label, 'ver', 7000); },
    pulse(from, to, kind, label) {
      const a = G.pos.get(from) || G.pos.get('super_agent'), b = G.pos.get(to);
      if (!a || !b) return;
      const d = curve(a, b, from === 'super_agent' || !G.pos.get(from) ? 0.15 : 0.25);
      const p = s('path', { d, class: `ag-pulse ${kind || ''}` });
      const len = 500;
      p.style.strokeDasharray = `16 ${len}`;
      G.layers.fx.append(p);
      p.animate([{ strokeDashoffset: 16 }, { strokeDashoffset: -len }], { duration: ms(700) || 250, easing: 'ease-in' });
      setTimeout(() => p.remove(), (ms(700) || 250) + 50);
      if (label && live) {
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - 6;
        const lw = label.length * 7 + 14;
        const lg = s('g', { class: `ag-elabel ${kind || ''}`, transform: `translate(${mx - lw / 2},${my - 9})` }, s('rect', { width: lw, height: 18, rx: 9 }), s('text', { x: lw / 2, y: 12.5, 'text-anchor': 'middle' }, label));
        G.layers.fx.append(lg);
        setTimeout(() => lg.remove(), ms(2600) || 900);
      }
    },
    port(k, dur = 1600) { const g = G.ports[k]; if (!g) return; g.classList.add('hot'); clearTimeout(g._t); g._t = setTimeout(() => g.classList.remove('hot'), dur); },
    chip(id, text, cls, dur = 7000) {
      const g = G.nodes.get(id);
      const p = G.pos.get(id);
      if (!g || !p) return;
      const old = G.chips.get(id);
      if (old) { clearTimeout(old._t); old.remove(); }
      const hgt = Number(g.dataset.h || 54);
      const str = String(text).length > 34 ? `${String(text).slice(0, 33)}…` : String(text);
      const cw = Math.min(236, Math.max(70, str.length * 7.2 + 16));
      const x = Math.max(4, Math.min(VB.w - cw - 4, p[0] - cw / 2));
      const y = p[1] + hgt / 2 + 6;
      const c = s('g', { class: `ag-chip ${cls || ''}`, transform: `translate(${x},${y})` }, s('rect', { width: cw, height: 20, rx: 10 }), s('text', { x: cw / 2, y: 13.5, 'text-anchor': 'middle' }, str), s('title', {}, text));
      G.layers.chips.append(c);
      G.chips.set(id, c);
      const keep = live && cls === 'val' ? 0 : dur;      // 대화 모드: 가져온 값 칩은 다음 요청까지 유지
      if (keep) c._t = setTimeout(() => { c.remove(); if (G.chips.get(id) === c) G.chips.delete(id); }, keep);
    },
    clearChips() { for (const [, c] of G.chips) { clearTimeout(c._t); c.remove(); } G.chips.clear(); for (const g of G.nodes.values()) { g.classList.remove('done', 'seq'); const b = g.querySelector('.badge-seq text'); if (b) b.textContent = ''; } G.seq = 0; },
    seqBadge(id) {
      const g = G.nodes.get(id);
      if (!g) return;
      G.seq += 1;
      const b = g.querySelector('.badge-seq');
      b.querySelector('text').textContent = String(G.seq);
      g.classList.add('seq');
    },
    scan(id) {
      const g = G.nodes.get(id);
      if (!g) return;
      const w = Number(g.dataset.w || 128), hh = Number(g.dataset.h || 54);
      const bar = s('rect', { class: 'scan', x: 0, y: 0, width: 6, height: hh, rx: 2 });
      g.append(bar);
      bar.animate([{ transform: 'translateX(0px)' }, { transform: `translateX(${w - 6}px)` }], { duration: ms(900) || 300, iterations: 3, direction: 'alternate' });
      setTimeout(() => bar.remove(), (ms(900) || 300) * 3 + 100);
    },
    step(text, cls) {
      if (!live) return;
      G.stepLabel.style.display = text ? '' : 'none';
      G.stepLabel.querySelector('text').textContent = text || '';
      G.stepLabel.setAttribute('class', `ag-step ${cls || ''}`);
    },
    event(ev) {
      if (ev.backlog) {
        if (ev.type === '_state') G.render(ev.state.registry);
        if (live && ev.type === 'request' && ev.source !== 'sim') { G.reqId = ev.request_id; G.right.textContent = ev.request_id; G.step(`요청 접수 — ${ev.request_id}`, 'l1'); }
        if (live && ev.type === 'node' && ev.loop === 'L1' && STEP_KO[ev.node] && ev.request_id === G.reqId) G.step(STEP_KO[ev.node], 'l1');
        return;
      }
      switch (ev.type) {
        case 'request':
          if (live) { G.clearChips(); G.reqId = ev.request_id; G.step(`요청 접수 — ${ev.request_id}`, 'l1'); G.right.textContent = ev.request_id; G.mark('super_agent', 'calling', 1500); }
          break;
        case 'agent_start':
          G.mark(ev.agent_id, 'calling');
          G.pulse(ev.caller || 'super_agent', ev.agent_id, ev.indirect ? 'ind' : '', ev.action);
          G.port('sandbox', 900);
          G.mark('super_agent', 'calling', 1200);
          if (live) G.seqBadge(ev.agent_id);
          break;
        case 'agent_end': {
          G.unmark(ev.agent_id, 'calling');
          if (!ev.ok) { G.mark(ev.agent_id, 'error', 4000); G.chip(ev.agent_id, `✗ ${ev.error_type || '오류'} → 확인 불가 · Heal`, 'bad', 9000); }
          else { if ((ev.summary || []).length) G.chip(ev.agent_id, ev.summary[0], 'val', 8000); if (live) G.mark(ev.agent_id, 'done'); }
          G.pulse(ev.agent_id, ev.caller && G.pos.get(ev.caller) ? ev.caller : 'super_agent', 'back');
          break;
        }
        case 'code': if (ev.agent === 'super_agent') { G.mark('super_agent', 'calling', 1500); G.chip('super_agent', '실행 계획 코드 작성 (CodeAct)', 'l1', 4000); } G.port('sandbox'); break;
        case 'jev': G.port('jev'); if (ev.head === 'route') G.chip('super_agent', `Jev 편성 → ${(Array.isArray(ev.answer) ? ev.answer : [ev.answer]).map(short).join('+')}`, 'jev', 5000); break;
        case 'node': {
          if (ev.loop === 'L1' && live && STEP_KO[ev.node] && (!G.reqId || ev.request_id === G.reqId)) G.step(`${STEP_KO[ev.node]}${ev.node === 'execute_sandbox' ? '' : ''}`, ev.node === 'approval_gate' ? 'gate' : ev.node === 'mark_unavailable' ? 'bad' : 'l1');
          if (ev.node === 'retrieve_memory') G.port('memory');
          if (ev.loop === 'L2' && ev.sub !== 'grow' && ev.agent_id) {
            G.mark(ev.agent_id, 'healing', ms(5000) || 1500);
            G.port('healer', 2500);
            if (ev.node === 'write_patch' || ev.node === 'diagnose_codeact') G.scan(ev.agent_id);
            if (ev.node === 'write_patch') G.chip(ev.agent_id, 'Healer가 소스 코드 패치 중', 'l2', 5000);
            if (ev.node === 'run_regression') G.port('harness', 2000);
            if (live) G.step(`Self-Healing ${ev.heal_id} — ${ev.detail || ''}`.slice(0, 60), 'l2');
          }
          if (ev.loop === 'L2' && ev.sub === 'grow') { G.port('factory', 3000); if (ev.node === 'run_tests') G.port('harness', 2000); if (live) G.step(`Agent Factory ${ev.grow_id} — ${ev.detail || ''}`.slice(0, 60), 'l2'); }
          if (ev.loop === 'L3') { G.port('evolver', 3000); if (ev.node === 'evaluate_harness' || ev.node === 'verify_replacement') G.port('harness', 2000); }
          break;
        }
        case 'response': if (live && ev.rtype && !['rework', 'judge', 'state'].includes(ev.rtype)) G.step('응답 완료 — 대화 창 확인', 'ok'); break;
        case 'judge': if (live) G.step(`judge_qual → ${ev.judgement?.result} (결정적 코드)`, ev.judgement?.result === 'PASS' ? 'ok' : 'bad'); break;
        case 'approval': if (live && ev.kind === 'state_change') G.step(ev.action === 'requested' ? '사람 승인 대기 — 장비 UP' : `사람 ${ev.approved ? '승인' : '반려'} — ${ev.approver}`, ev.action === 'requested' ? 'gate' : ev.approved ? 'ok' : 'bad'); break;
        case 'tests': G.port('harness', 800); break;
        case 'candidate': G.port('harness', 1500); break;
        case 'version':
          if (ev.kind === 'baseline') break;
          G.flash(ev.agent_id, `${ev.from_version || '—'} → ${ev.to_version} (${({ heal: 'Heal', grow: 'Grow', evolve: 'Evolve', compose: '구성', rollback: '롤백', promote: '승격', restore: '복원' })[ev.kind] || ev.kind})`);
          if (ev.kind === 'rollback') G.mark(ev.agent_id, 'error', 3000);
          break;
        case 'registry':
          if (ev.event === 'retire') G.chip(ev.agent_id, '폐기 → 아카이브 보관', 'gone', 9000);
          if (ev.event === 'deprecate') G.chip(ev.agent_id, '폐기 유예 — 호출은 대체 Agent로', 'warn', 9000);
          break;
        case 'redirect': G.pulse(ev.agent_id, ev.to, 'ind', '리다이렉트'); break;
        case '_state': G.render(ev.state.registry); break;
        default: break;
      }
    },
  };
  return G.init();
}

function curve(a, b, bend = 0.15) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return `M ${a[0]} ${a[1]} Q ${mx - dy * bend} ${my + dx * bend} ${b[0]} ${b[1]}`;
}
