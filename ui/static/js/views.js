// 상세 화면 — 루프 트레이스, 리플레이 진화, 리포트, Registry·Lineage, 아카이브, 승인, Fab, KPI
import { $, $$, h, s, api, esc, vdate, AGENT_KO, STATUS_KO, short, diffLines, highlight, fmtNum } from './util.js';

let A = null;
const tip = h('div', { class: 'tip', hidden: true });
document.body.append(tip);
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 380)}px`; tip.style.top = `${e.clientY + 12}px`; }
function hideTip() { tip.hidden = true; }

const KIND_KO = { heal: 'Self-Healing', grow: 'Agent Grow', evolve: '진화', rollback: '자동 롤백', retire: '폐기 검토', replay: '리플레이' };
const LV_KO = { baseline: '초기 구축', heal: 'Heal 패치', evolve: 'Evolve 채택', compose: '구성 변경(MAJOR)', rollback: '자동 롤백', promote: '정식 승격',
  grow: 'Grow 생성', restore: '아카이브 복원', deprecate: '폐기 유예', retire: '폐기 확정', grace_restart: '유예 재시작', shadow: 'Shadow', defect: '결함 판정' };
const LV_C = { baseline: 'var(--ink-3)', heal: 'var(--l2)', grow: 'var(--l2)', evolve: 'var(--l3)', compose: 'var(--l3)', rollback: 'var(--bad)', promote: 'var(--ok)',
  deprecate: 'var(--warn)', retire: '#7b8691', restore: 'var(--l1)', grace_restart: 'var(--warn)', defect: 'var(--bad)' };

function pageHead(title, desc, right) {
  return h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, title), desc ? h('p', {}, desc) : null), right ? h('div', { class: 'r' }, right) : null);
}

/* ══════════════════════════════════════════════════════════
   루프 트레이스
   ══════════════════════════════════════════════════════════ */
const LOOP_C = { L1: 'var(--l1)', 'L2-Heal': 'var(--l2)', 'L2-Grow': 'var(--l2)', L3: 'var(--l3)' };
const Trace = {
  graphs: null, runs: [], sel: null,
  async open() {
    const v = $('#view-trace');
    if (!this.graphs) this.graphs = await api('/api/graphs');
    this.collect();
    v.innerHTML = '';
    v.append(pageHead('루프 트레이스', 'L1 Task · L2 Heal/Grow · L3 Evolve — LangGraph 노드를 실제로 지나간 경로와 루프 예산'));
    const list = h('div', { class: 'list' });
    const detail = h('div', { class: 'detail' });
    for (const r of this.runs.slice(-60).reverse()) {
      list.append(h('button', { class: `li ${this.sel === r.key ? 'sel' : ''}`, onclick: () => { this.sel = r.key; this.open(); } },
        h('span', { class: 'li-t' }, `${r.loop} · ${r.title}`), h('span', { class: 'li-s' }, `${r.vts} · 노드 ${r.steps.length}개`)));
    }
    if (!this.runs.length) list.append(h('div', { class: 'empty' }, 'Autopilot을 시작하거나 요청을 보내면 루프 실행 경로가 기록됩니다.'));
    const run = this.runs.find((r) => r.key === this.sel) || this.runs[this.runs.length - 1];
    if (run) detail.append(this.renderRun(run));
    v.append(h('div', { class: 'split' }, list, detail));
  },
  collect() {
    const evs = A.trace;
    const runs = new Map();
    for (const e of evs) {
      const key = e.request_id ? `L1:${e.request_id}` : e.heal_id ? `L2:${e.heal_id}` : e.grow_id ? `G:${e.grow_id}` : e.run_id ? `L3:${e.run_id}` : null;
      if (!key) continue;
      let r = runs.get(key);
      if (!r) {
        const loop = key.startsWith('L1') ? 'L1' : key.startsWith('L2') ? 'L2-Heal' : key.startsWith('G') ? 'L2-Grow' : 'L3';
        r = { key, loop, title: e.request_id || e.heal_id || e.grow_id || e.run_id, vts: vdate(e.vts).d + ' ' + vdate(e.vts).t, steps: [], budget: null };
        runs.set(key, r);
      }
      if (e.type === 'node') r.steps.push({ node: e.node, detail: e.detail, vts: e.vts });
      if (e.type === 'budget') r.budget = e;
      if (e.agent_id && !r.agent) r.agent = e.agent_id;
    }
    this.runs = [...runs.values()].filter((r) => r.steps.length);
  },
  renderRun(run) {
    const g = this.graphs[run.loop] || this.graphs.L3;
    const visited = run.steps.map((x) => x.node);
    const c = LOOP_C[run.loop];
    const card = h('div', { class: 'card' }, h('h3', {}, `${run.loop} — ${run.title}${run.agent ? ` (${run.agent})` : ''}`), this.graph(g, visited, c));
    const steps = h('div', { class: 'steps' });
    for (const st of run.steps) steps.append(h('div', { class: 'step', style: { '--c': c } }, h('span', { class: 'sn' }, st.node), h('span', {}, st.detail || '')));
    const out = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } }, card);
    if (run.budget) {
      const b = run.budget;
      const gauge = (label, v, max, unit) => h('div', { class: 'gauge' }, h('span', {}, label), h('span', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, (v / max) * 100)}%` } })), h('span', { class: 'num' }, `${v}/${max}${unit}`));
      out.append(h('div', { class: 'card' }, h('h3', {}, '루프 예산 (루프 밖 고정 — eval/policy.json)'),
        gauge('시도', b.attempts, b.max_attempts, '회'), gauge('시간', b.minutes, b.max_minutes, '분'), gauge('토큰', b.tokens, b.max_tokens, '')));
    }
    out.append(h('div', { class: 'card' }, h('h3', {}, '실행 경로'), steps));
    return out;
  },
  graph(g, visited, c) {
    const nodes = g.nodes;
    const cols = Math.min(6, Math.ceil(Math.sqrt(nodes.length * 1.6)));
    const W = 150, H = 40, GX = 26, GY = 26;
    const pos = {};
    nodes.forEach((n, i) => { pos[n] = [(i % cols) * (W + GX) + 10, Math.floor(i / cols) * (H + GY) + 10]; });
    const rows = Math.ceil(nodes.length / cols);
    const svg = s('svg', { class: 'lg', viewBox: `0 0 ${cols * (W + GX) + 10} ${rows * (H + GY) + 10}`, style: `--c:${c}` },
      s('defs', {}, s('marker', { id: 'arr', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }, s('path', { d: 'M0 0L8 4L0 8z', fill: '#4a5a6a' }))));
    const vis = new Set(visited);
    const pairs = new Set(visited.slice(1).map((n, i) => `${visited[i]}>${n}`));
    for (const e of g.edges) {
      if (!pos[e.from] || !pos[e.to]) continue;
      const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to];
      svg.append(s('path', { class: `e ${e.cond ? 'cond' : ''} ${pairs.has(`${e.from}>${e.to}`) ? 'on' : ''}`, d: `M${x1 + W / 2} ${y1 + H / 2} L${x2 + W / 2} ${y2 + H / 2}` }));
    }
    const last = visited[visited.length - 1];
    for (const n of nodes) {
      const [x, y] = pos[n];
      svg.append(s('g', { class: `n ${vis.has(n) ? 'on' : ''} ${n === last ? 'cur' : ''}`, transform: `translate(${x},${y})` },
        s('rect', { width: W, height: H, rx: 6 }), s('text', { x: W / 2, y: H / 2 + 4, 'text-anchor': 'middle' }, n)));
    }
    return svg;
  },
};

/* ══════════════════════════════════════════════════════════
   리플레이 진화
   ══════════════════════════════════════════════════════════ */
const Replay = {
  async open() {
    const v = $('#view-replay');
    const st = A.state;
    const rows = st.replay_rows || [];
    let final = null;
    try { final = (await api('/api/report/REPLAY-01')).content.final; } catch (e) { /* 진행 중 */ }
    const lessons = await api('/api/memory?kind=lesson');
    const clusters = await api('/api/memory?kind=cluster');
    v.innerHTML = '';
    v.append(pageHead('이력 리플레이 진화', '3년치 Qual 이력을 시간순으로 재생하며 분기마다 L3 Evolve를 수행 (Walk-forward). 최근 6개월은 Held-out — 진화 없이 평가만.'));
    const prog = A.replayProg;
    if (st.replay?.state === 'running' && prog) {
      v.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'rp-progress' }, h('b', {}, `${prog.quarter} 재생 중`), h('span', { class: 'rp-bar' }, h('i', { style: { width: `${(prog.done / prog.total) * 100}%` } })),
          h('span', { class: 'num' }, `${prog.done.toLocaleString()} / ${prog.total.toLocaleString()}건`)),
        h('div', { class: 'sub' }, `replay_clock ${prog.replay_clock} — 이 시각 이후 데이터는 Time-Travel Guard가 차단 (누적 필터·차단 ${fmtNum(prog.guard, 0)}건)`)));
    }
    const top = h('div', { class: 'grid2', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', marginBottom: '16px' } });
    top.append(h('div', { class: 'card' }, h('h3', {}, '분기별 판정 일치율 · 추천 오차'), rows.length ? this.chart(rows) : h('div', { class: 'empty' }, '리플레이(SC-006)가 시작되면 분기별 진화 곡선이 그려집니다.')));
    const fin = h('div', { class: 'card' }, h('h3', {}, 'Held-out 최종 평가 (2026 상반기)'));
    if (final) {
      fin.append(h('div', { class: 'sub' }, `${final.n}건 — 진화 전(전 Agent 1.0.0) 대비 진화 후, 같은 건을 고정 하네스로 재채점`),
        h('div', { style: { margin: '10px 0 4px' } }, h('div', { class: 'muted' }, '판정 일치율'), h('div', { class: 'big2' }, h('span', { class: 'from' }, `${final.before.accuracy.toFixed(0)}%`), h('span', { class: 'arrow' }, '→'), h('span', { class: 'to' }, `${final.after.accuracy.toFixed(0)}%`))),
        h('dl', { class: 'kv' },
          h('dt', {}, '1차 Pass 예측'), h('dd', {}, `${final.before.pred_acc}% → ${final.after.pred_acc}%`),
          h('dt', {}, 'judge_qual 판정'), h('dd', {}, `${final.before.judge_acc}% → ${final.after.judge_acc}%`),
          h('dt', {}, '백테스트 1차 Pass율'), h('dd', {}, `${final.before.first_pass_rate}% → ${final.after.first_pass_rate}%`,
            st.after_sc007 ? h('span', { class: 'muted' }, ` → ${st.after_sc007.first_pass_rate}% (SC-007 판단 진화 후)`) : null),
          h('dt', {}, '추천 오차'), h('dd', {}, `±${final.before.rec_error} → ±${final.after.rec_error}매`),
          h('dt', {}, '미래 정보 누출'), h('dd', {}, h('b', { style: { color: 'var(--ok)' } }, `${final.leaks}건`), ` (Guard 필터·차단 ${fmtNum(final.guard_blocked, 0)}건)`),
          h('dt', {}, 'Held-out 열람'), h('dd', {}, `${final.heldout_views}회차`)));
    } else fin.append(h('div', { class: 'empty' }, '리플레이 종료 후 표시'));
    top.append(fin);
    v.append(top);
    const tbl = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['구간', '판정 일치율', '추천 오차', '신규 교훈', '만료', '주요 사건'].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    for (const r of rows) {
      tb.append(h('tr', {}, h('td', {}, r.quarter, r.split === 'heldout' ? h('span', { class: 'muted' }, ' Held-out') : null), h('td', { class: 'num' }, `${r.accuracy}%`),
        h('td', { class: 'num' }, `±${r.rec_error}매`), h('td', { class: 'num' }, r.new_lessons || '-'), h('td', { class: 'num' }, r.expired_lessons || '-'),
        h('td', {}, (r.events || []).length ? h('div', { class: 'list', style: { gap: '2px' } }, ...r.events.map((x) => h('div', {}, x))) : h('span', { class: 'muted' }, r.split === 'heldout' ? '평가만' : '-'))));
    }
    tbl.append(tb);
    v.append(h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h3', {}, '리플레이 진화 리포트'), tbl));
    const lt = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['ID', '상태', '교훈', '원천', '학습'].map((x) => h('th', {}, x)))));
    const lb = h('tbody');
    for (const L of lessons.slice().reverse()) lb.append(h('tr', {}, h('td', {}, L.id), h('td', {}, h('span', { class: `st ${L.status === 'active' ? 'active' : 'retired'}` }, L.status === 'active' ? '적용' : '만료')),
      h('td', { class: L.status === 'active' ? 'lesson-txt' : 'muted' }, L.content.text), h('td', { class: 'num' }, `${L.sources}건`), h('td', {}, L.content.learned_q || '')));
    lt.append(lb);
    const ct = h('div', { class: 'list' }, ...clusters.map((c) => h('div', { class: 'li' }, h('span', { class: 'li-t' }, `${c.id} ${c.status === 'resolved' ? '(해소)' : ''}`), h('span', {}, c.content.text),
      c.content.resolved_by ? h('span', { class: 'li-s' }, `${c.content.resolved_by}에서 원인 변수(Focus Ring 사용시간) 확인`) : h('span', { class: 'li-s' }, '억지 교훈을 만들지 않고 미해결로 보존'))));
    v.append(h('div', { class: 'grid2', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' } },
      h('div', { class: 'card' }, h('h3', {}, `학습된 교훈 (적용 ${lessons.filter((x) => x.status === 'active').length} / 전체 ${lessons.length})`), lt),
      h('div', { class: 'card' }, h('h3', {}, '미해결 오차 군집'), clusters.length ? ct : h('div', { class: 'empty' }, '없음'))));
  },
  chart(rows) {
    const W = 980, H = 330, L = 46, Rr = 60, T = 22, B = 40;
    const iw = W - L - Rr, ih = H - T - B;
    const xs = (i) => L + (rows.length === 1 ? iw / 2 : (i * iw) / (rows.length - 1));
    const accs = rows.map((r) => r.accuracy);
    const lo = Math.max(0, Math.floor((Math.min(...accs) - 8) / 10) * 10), hi = 100;
    const ya = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;
    const errs = rows.map((r) => r.rec_error || 0);
    const emax = Math.max(4, Math.ceil(Math.max(...errs)));
    const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '분기별 판정 일치율' });
    const hoStart = rows.findIndex((r) => r.split === 'heldout');
    if (hoStart >= 0) {
      const x0 = xs(hoStart) - (iw / Math.max(1, rows.length - 1)) / 2;
      svg.append(s('rect', { class: 'ho', x: x0, y: T, width: W - Rr - x0, height: ih }), s('text', { class: 'ho-l', x: x0 + 6, y: T + 13 }, 'Held-out (평가만)'));
    }
    for (let v = lo; v <= hi; v += 10) svg.append(s('line', { class: 'gl', x1: L, x2: W - Rr, y1: ya(v), y2: ya(v) }), s('text', { x: L - 8, y: ya(v) + 4, 'text-anchor': 'end' }, `${v}%`));
    svg.append(s('line', { class: 'ax', x1: L, x2: W - Rr, y1: T + ih, y2: T + ih }));
    rows.forEach((r, i) => svg.append(s('text', { x: xs(i), y: H - B + 18, 'text-anchor': 'middle' }, r.quarter.replace(' ', ''))));
    svg.append(s('path', { class: 'ln', d: rows.map((r, i) => `${i ? 'L' : 'M'}${xs(i)} ${ya(r.accuracy)}`).join(' ') }));
    rows.forEach((r, i) => {
      svg.append(s('circle', { class: 'dot', cx: xs(i), cy: ya(r.accuracy), r: 4.5 }));
      if ((r.events || []).length && r.split !== 'heldout') svg.append(s('rect', { class: 'ev-m', x: xs(i) - 3, y: T + ih + 4, width: 6, height: 6, rx: 1.5 }));
    });
    const last = rows[rows.length - 1];
    svg.append(s('text', { class: 'lbl', x: xs(rows.length - 1) + 8, y: ya(last.accuracy) - 8 }, `${last.accuracy}%`));
    const first = rows[0];
    svg.append(s('text', { class: 'lbl', x: xs(0) - 4, y: ya(first.accuracy) + 18 }, `${first.accuracy}%`));
    const xh = s('line', { class: 'xh', y1: T, y2: T + ih, x1: -10, x2: -10 });
    svg.append(xh);
    const hit = s('rect', { class: 'hit', x: L, y: T, width: iw, height: ih + 20 });
    hit.addEventListener('mousemove', (e) => {
      const b = svg.getBoundingClientRect();
      const x = ((e.clientX - b.left) / b.width) * W;
      let i = Math.round(((x - L) / iw) * (rows.length - 1));
      i = Math.max(0, Math.min(rows.length - 1, i));
      xh.setAttribute('x1', xs(i)); xh.setAttribute('x2', xs(i)); xh.classList.add('on');
      const r = rows[i];
      showTip(e, `<b>${r.quarter}</b> ${r.split === 'heldout' ? '(Held-out)' : ''}<br>판정 일치율 ${r.accuracy}% · 1차 Pass 예측 ${r.pred_acc}% · judge ${r.judge_acc}%<br>추천 오차 ±${r.rec_error}매 · 적용 교훈 ${r.lessons_active}건<br>${(r.events || []).map(esc).join('<br>')}`);
    });
    hit.addEventListener('mouseleave', () => { hideTip(); xh.classList.remove('on'); });
    svg.append(hit);
    void errs; void emax;
    return svg;
  },
};

/* ══════════════════════════════════════════════════════════
   리포트
   ══════════════════════════════════════════════════════════ */
const Reports = {
  kind: null, sel: null,
  async open(rid) {
    const v = $('#view-reports');
    if (rid) this.sel = rid;
    const list = await api(`/api/reports${this.kind ? `?kind=${this.kind}` : ''}`);
    v.innerHTML = '';
    const tabs = h('div', { class: 'tabs' }, ...[[null, '전체'], ['heal', 'Self-Healing'], ['grow', 'Grow'], ['evolve', '진화'], ['rollback', '롤백'], ['retire', '폐기'], ['replay', '리플레이']]
      .map(([k, t]) => h('button', { class: this.kind === k ? 'on' : '', onclick: () => { this.kind = k; this.open(); } }, t)));
    v.append(pageHead('Heal · Grow · 진화 리포트', '감지 → 원인 → 조치(diff) → 검증(테스트·Evolve셋·Held-out) → 반영 버전. 채택·기각 사유를 모두 남깁니다.'), tabs);
    const lst = h('div', { class: 'list' });
    for (const r of list) lst.append(h('button', { class: `li ${this.sel === r.report_id ? 'sel' : ''}`, onclick: () => { this.sel = r.report_id; this.open(); } },
      h('span', { class: 'li-t' }, r.title), h('span', { class: 'li-s' }, `${KIND_KO[r.kind] || r.kind} · ${String(r.ts).slice(0, 16)}`)));
    if (!list.length) lst.append(h('div', { class: 'empty' }, '아직 리포트가 없습니다.'));
    const det = h('div', { class: 'detail' });
    const id = this.sel || list[0]?.report_id;
    if (id) { const r = await api(`/api/report/${id}`); det.append(this.render(r)); }
    v.append(h('div', { class: 'split', style: { height: 'calc(100% - 96px)' } }, lst, det));
  },
  render(r) {
    const c = r.content;
    const out = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    out.append(h('div', { class: 'card' }, h('h3', {}, r.title), h('div', { class: 'sub' }, `${r.report_id} · ${r.ts}`)));
    if (r.kind === 'heal') {
      const cls = c.classification || {};
      const probs = Object.entries(cls.probs || {}).sort((a, b) => b[1] - a[1]);
      out.append(h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('h3', {}, '진단'), h('dl', { class: 'kv' },
          h('dt', {}, '대상'), h('dd', {}, `${c.agent_id} ${c.from_version} → ${c.to_version || '(미반영)'}`),
          h('dt', {}, '오류 시그니처'), h('dd', {}, c.signature),
          h('dt', {}, '오류 유형'), h('dd', {}, `${cls.type} (Jev ${cls.p})${cls.reclassified ? ' — 진단 후 재분류' : ''}`),
          c.slicing ? [h('dt', {}, '진단 (로그 슬라이싱)'), h('dd', {}, c.slicing)] : null,
          h('dt', {}, '원인'), h('dd', {}, c.cause || '-'),
          h('dt', {}, '시도/소요'), h('dd', {}, `${(c.attempts || []).length}회 / ${c.mttr}`),
          h('dt', {}, '상태'), h('dd', {}, h('span', { class: `st ${c.status}` }, { healed: '복구 완료', escalated: '운영자 에스컬레이션', external: '외부 장애' }[c.status] || c.status), c.escalate_reason ? ` — ${c.escalate_reason}` : ''))),
        h('div', { class: 'card' }, h('h3', {}, 'Jev 오류 유형 분류 확률'), h('div', { class: 'probs' }, ...probs.map(([k, p]) => h('div', { class: `prob ${k === cls.type ? 'sel' : 'off'}` }, h('span', {}, k), h('span', { class: 'bar' }, h('i', { style: { width: `${p * 100}%` } })), h('span', { class: 'v' }, p.toFixed(2))))))));
      const at = h('div', { class: 'steps' });
      for (const a of c.attempts || []) at.append(h('div', { class: 'step', style: { '--c': a.result === 'pass' ? 'var(--ok)' : 'var(--bad)' } }, h('span', { class: 'sn' }, `${a.n}회차 ${a.result === 'pass' ? '통과' : '기각'}`),
        h('span', {}, `${a.summary} (+${a.diff_add}/−${a.diff_del}, ${a.model}) · 회귀 ${a.tests?.passed ?? 0}/${a.tests?.total ?? 0}` + ((a.tests?.failures || []).length ? ` — ${a.tests.failures.map((f) => `${f.label || f.case}: ${f.error}`).join('; ').slice(0, 220)}` : '') + (a.result !== 'pass' ? ` · 블랙리스트 ${a.hash}` : ''))));
      out.append(h('div', { class: 'card' }, h('h3', {}, '패치 시도'), at));
      if ((c.cascade || []).length) out.append(h('div', { class: 'card' }, h('h3', {}, '연쇄 복구'), ...c.cascade.map((x) => h('div', {}, `${x.agent_id} ${x.from} → ${x.to || '실패'} · 회귀 ${x.tests} · ${x.why}`))));
      if (c.diff) out.append(h('div', { class: 'card' }, h('h3', {}, '패치 diff'), h('div', { class: 'code' }, ...diffLines(c.diff))));
    } else if (r.kind === 'grow') {
      out.append(h('div', { class: 'card' }, h('h3', {}, c.ok ? `${c.agent_id} ${c.version} 생성` : '생성 중단'), h('div', { class: 'list' }, ...(c.lines || []).map((x) => h('div', {}, x)))));
      if (c.spec) out.append(h('div', { class: 'card' }, h('h3', {}, 'Agent 명세 (LLM 작성)'), h('dl', { class: 'kv' }, ...Object.entries(c.spec).flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, Array.isArray(val) ? val.join(', ') : val)]))));
      for (const a of c.attempts || []) out.append(h('div', { class: 'card' }, h('h3', {}, `${a.n}회차 — ${a.result === 'pass' ? '통과' : '실패'} ${a.note || ''}`),
        h('div', { class: 'list' }, ...(a.tests || []).map((t) => h('div', {}, h('span', { class: `st ${t.ok ? 'ok' : 'bad'}` }, t.name), ` ${t.detail}`)))));
    } else if (r.kind === 'evolve' || r.kind === 'rollback' || r.kind === 'retire') {
      out.append(this.evolve(c));
    } else if (r.kind === 'replay') {
      out.append(h('div', { class: 'card' }, h('h3', {}, 'Held-out 최종 평가'), h('pre', { class: 'code' }, JSON.stringify(c.final, null, 1))));
    }
    return out;
  },
  evolve(c) {
    const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    if (c.detect) box.append(h('div', { class: 'card' }, h('h3', {}, '감지'), h('div', { class: 'list' }, ...c.detect.map((x) => h('div', {}, x)))));
    if (c.kind === 'judgment') {
      box.append(h('div', { class: 'card' }, h('h3', {}, `판단 진화 — ${c.group} (${c.period?.join(' ~ ')})`), h('dl', { class: 'kv' },
        h('dt', {}, '운영 건'), h('dd', {}, `AutoQual ${c.n}건 · Override ${c.overrides}건 (${Object.entries(c.override_reasons || {}).map(([k, v]) => `${k} ${v}`).join(', ')})`),
        h('dt', {}, '추천대로 진행'), h('dd', {}, `${c.followed}건 중 1차 Fail ${c.followed_fail}건 (${Object.entries(c.fail_items || {}).map(([k, v]) => `${k} ${v}`).join(', ')})`),
        h('dt', {}, '원인 분석'), h('dd', {}, `1차 Fail 중 Focus Ring 600h 초과 ${c.fr_fail}건 (part_history_agent 조회)`),
        h('dt', {}, 'Override 분류'), h('dd', {}, `결과로 뒷받침 ${c.backed}건 반영 / 보수적 ${c.conservative}건 학습 제외`),
        c.cluster ? h('dt', {}, '미해결 군집') : null, c.cluster ? h('dd', {}, `${c.cluster.id}: ${c.cluster.n}건 중 ${c.cluster.hit}건 Focus Ring 600h 초과`) : null,
        h('dt', {}, '상태'), h('dd', {}, c.status === 'adopted' ? `채택 (승인 ${c.approver})` : '운영자 승인 대기'))));
    }
    if (c.kind === 'structure') box.append(h('div', { class: 'card' }, h('h3', {}, '결과'), h('dl', { class: 'kv' },
      h('dt', {}, 'FDC 파싱 코드 중복'), h('dd', {}, `${c.dup_before}% → ${c.dup_after}%`), h('dt', {}, 'log_agent p50'), h('dd', {}, `${c.p50_before}s → ${c.p50_after}s`),
      c.shadow ? h('dt', {}, 'Shadow') : null, c.shadow ? h('dd', {}, `요청 ${c.shadow.n}건 (${Object.entries(c.shadow.by_group).map(([k, v]) => `${k} ${v}`).join(', ')}), 불일치 ${c.shadow.mismatch}건`) : null,
      ...(c.changes || []).flatMap((x) => [h('dt', {}, '승격'), h('dd', {}, `${x.agent_id} ${x.from || '-'} → ${x.to}`)]))));
    if (c.kind === 'rollback') box.append(h('div', { class: 'card' }, h('h3', {}, '자동 롤백'), h('dl', { class: 'kv' },
      h('dt', {}, '원인'), h('dd', {}, c.cause), h('dt', {}, '판정 불일치'), h('dd', {}, `${c.group} ${c.n}건 중 ${c.mismatch}건 — ${(c.detail || []).join('; ')}`),
      h('dt', {}, '원자적 롤백'), h('dd', {}, (c.cascade || []).map((x) => `${x.agent_id} ${x.from} → ${x.to}`).join(' / ')), h('dt', {}, 'Held-out 추가'), h('dd', {}, `${c.heldout_added}건`))));
    if (c.kind === 'merge') box.append(h('div', { class: 'card' }, h('h3', {}, '병합 재도전'), h('div', {}, c.line), h('div', { class: 'sub' }, `출발점: ${c.from_archive}`)));
    if (c.scan) {
      const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['Agent', '마지막 호출', '직접/간접(30일)', '기능 중첩', 'Jev', '사유'].map((x) => h('th', {}, x)))));
      t.append(h('tbody', {}, ...c.scan.map((x) => h('tr', {}, h('td', {}, `${x.agent_id} ${x.version}`), h('td', { class: 'num' }, `${x.days_unused}일 전`), h('td', { class: 'num' }, `${x.direct_30d} / ${x.indirect_30d}`),
        h('td', { class: 'num' }, x.overlap), h('td', { class: 'num' }, x.p.toFixed(2)), h('td', {}, x.reason)))));
      box.append(h('div', { class: 'card' }, h('h3', {}, 'Retire 후보 감지'), t));
      box.append(h('div', { class: 'card' }, h('h3', {}, '폐기 검토'), h('div', { class: 'list' }, ...(c.items || []).map((x) => h('div', { class: 'li' },
        h('span', { class: 'li-t' }, `${x.agent_id} ${x.version} — `, h('span', { class: `st ${x.decision === 'hold' ? 'hold' : 'deprecated'}` }, x.decision === 'hold' ? '폐기 보류' : `deprecated (~${String(x.grace_until).slice(0, 10)})`)),
        h('span', {}, x.why || x.reason), x.verify ? h('span', { class: 'li-s' }, `대체 검증 ${x.verify.ok}/${x.verify.total} 일치 · 테스트 이관 ${x.migrated}건`) : null,
        h('span', { class: 'li-s' }, `의존성: ${(x.deps || []).map((d) => `${d.kind}:${d.ref}`).join(', ') || '없음'}`))))));
      if (c.final) box.append(h('div', { class: 'card' }, h('h3', {}, '폐기 확정'), h('div', {}, `편성 후보 Agent ${c.final.n}개: ${c.final.candidates.join(', ')}`)));
    }
    const cands = c.candidates || [];
    if (cands.length) {
      const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['후보', '계층', '결정', '평가'].map((x) => h('th', {}, x)))));
      t.append(h('tbody', {}, ...cands.map((x) => h('tr', {}, h('td', {}, h('b', {}, x.cid), ' ', x.title), h('td', {}, x.layer || ''),
        h('td', {}, h('span', { class: `st ${x.decision}` }, { adopt: '채택', reject: '기각', hold: '보류' }[x.decision] || x.decision)),
        h('td', {}, x.reason || x.line || '', x.lessons?.new?.length ? h('div', { class: 'lesson-txt' }, `신규 교훈 ${x.lessons.new.map((l) => l.id).join(', ')}`) : null,
          x.changes?.length ? h('div', { class: 'muted' }, x.changes.map((ch) => `${ch.agent_id} ${ch.from || '-'}→${ch.to}`).join(' / ')) : null)))));
      box.append(h('div', { class: 'card' }, h('h3', {}, '변이 → 평가 → 선택 (모든 후보 아카이브 보관)'), t));
    }
    if (c.base) box.append(h('div', { class: 'card' }, h('h3', {}, '기준선 (현재 운영 구성)'), h('div', {}, `Evolve셋 판정 일치율 ${c.base.E.accuracy}% (${c.base.E.n}건) · 검증셋 ${c.base.V.accuracy ?? '-'}% (${c.base.V.n ?? 0}건) · 1차 Pass율(백테스트) ${c.base.E.first_pass_rate}%`)));
    if ((c.clusters || []).length) box.append(h('div', { class: 'card' }, h('h3', {}, '미해결 오차 군집'), ...c.clusters.map((x) => h('div', {}, `${x.id}: ${x.text}`))));
    return box;
  },
};

/* ══════════════════════════════════════════════════════════
   Registry · Lineage
   ══════════════════════════════════════════════════════════ */
const Registry = {
  sel: 'log_agent', ver: null,
  async open(agentId) {
    if (agentId) { this.sel = agentId; this.ver = null; }
    const v = $('#view-registry');
    const reg = A.state.registry.agents;
    v.innerHTML = '';
    v.append(pageHead('Agent Registry · Lineage', '모든 Agent는 코드·프롬프트·툴·테스트·지표·버전을 묶은 Genome으로 관리됩니다. 생명주기: 시험 운영 → 운영 → 폐기 유예 → 폐기(아카이브)'));
    const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['Agent', '상태', '버전', '출처', '호출(직접/간접)', '코드', '의존'].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    for (const a of reg) {
      tb.append(h('tr', { class: `clk ${this.sel === a.agent_id ? 'sel' : ''}`, onclick: () => this.open(a.agent_id) },
        h('td', {}, h('b', {}, a.agent_id), h('div', { class: 'muted' }, AGENT_KO[a.agent_id] || a.name_ko, a.kind === 'skill' ? ' · 공용 스킬' : '')),
        h('td', {}, h('span', { class: `st ${a.status}` }, STATUS_KO[a.status] || a.status), a.protected ? h('div', { class: 'muted' }, '보호(폐기 제외)') : null, a.shadow_version ? h('div', { class: 'muted' }, `Shadow ${a.shadow_version}`) : null),
        h('td', {}, a.active_version || '-', h('div', { class: 'muted' }, `${a.versions.length}개 버전`)), h('td', {}, a.origin),
        h('td', { class: 'num' }, `${a.direct_calls} / ${a.indirect_calls}`), h('td', { class: 'num' }, `${a.lines}줄`),
        h('td', {}, Object.keys(a.deps?.skills || {}).map(short).join(', '), a.deps?.agents?.length ? h('div', { class: 'muted' }, `→ ${a.deps.agents.join(', ')}`) : null)));
    }
    t.append(tb);
    v.append(h('div', { class: 'card', style: { marginBottom: '16px', overflow: 'auto' } }, t));
    const d = await api(`/api/genome/${this.sel}${this.ver ? `?version=${encodeURIComponent(this.ver)}` : ''}`);
    const lin = h('div', { class: 'lin' });
    const lineage = d.lineage.slice().reverse();
    for (const l of lineage) {
      lin.append(h('div', { class: 'lv', style: { '--c': LV_C[l.kind] || 'var(--ink-3)' } },
        h('div', { class: 'vh' }, h('b', {}, l.to_version), h('span', { class: 'vk' }, LV_KO[l.kind] || l.kind), l.ref ? h('span', { class: 'vt' }, l.ref) : null),
        h('div', { class: 'vn' }, l.note || '', l.diff_add || l.diff_del ? h('span', { class: 'muted' }, `  +${l.diff_add}/−${l.diff_del}`) : null), h('div', { class: 'vt' }, String(l.ts).slice(0, 16))));
    }
    const vsel = h('select', { class: 'g-note', style: { width: 'auto' }, onchange: (e) => { this.ver = e.target.value; this.open(); } },
      ...d.versions.map((x) => h('option', { value: x.version, selected: x.version === d.genome.version }, `${x.version} (${x.status})`)));
    const params = d.genome.params || {};
    v.append(h('div', { class: 'grid2', style: { gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 2.2fr)' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        h('div', { class: 'card' }, h('h3', {}, `${this.sel} Lineage`), lin),
        h('div', { class: 'card' }, h('h3', {}, `테스트 ${d.tests.length}건`), h('div', { class: 'list', style: { maxHeight: '320px', overflow: 'auto', gap: '2px' } },
          ...d.tests.slice(0, 120).map((x) => h('div', { class: 'muted' }, `${x.test_id} [${x.suite}] ${x.label || ''}`))))),
      h('div', { class: 'card' }, h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, `Genome 코드`), vsel,
        h('span', { class: 'muted' }, `${d.genome.lines}줄 · ${d.genome.reason}${d.genome.ref ? ' ' + d.genome.ref : ''} · 도구 ${(d.genome.tools || []).join(', ')}`)),
        params.features ? h('div', { class: 'muted', style: { marginBottom: '8px' } }, `기능 플래그: ${params.features.join(', ') || '(기본)'}`) : null,
        d.genome.prompt ? h('div', { class: 'sub', style: { marginBottom: '8px' } }, `프롬프트: ${d.genome.prompt.slice(0, 200)}`) : null,
        h('pre', { class: 'code', html: highlight(d.genome.code || '') }))));
  },
};

/* ══════════════════════════════════════════════════════════
   아카이브
   ══════════════════════════════════════════════════════════ */
const Archive = {
  f: 'all', sel: null,
  async open() {
    const v = $('#view-archive');
    const rows = await api('/api/archive');
    v.innerHTML = '';
    const counts = rows.reduce((m, r) => { m[r.decision] = (m[r.decision] || 0) + 1; return m; }, {});
    v.append(pageHead('진화 아카이브', '채택·기각·보류·폐기된 모든 후보를 점수·사유와 함께 보관합니다. 기각 후보는 다음 진화의 출발점이 되고, 폐기 Genome은 복원할 수 있습니다.'),
      h('div', { class: 'tabs' }, ...[['all', `전체 ${rows.length}`], ['adopt', `채택 ${counts.adopt || 0}`], ['reject', `기각 ${counts.reject || 0}`], ['hold', `보류 ${counts.hold || 0}`], ['retired', `폐기 Genome ${counts.retired || 0}`]]
        .map(([k, t]) => h('button', { class: this.f === k ? 'on' : '', onclick: () => { this.f = k; this.open(); } }, t))));
    const list = h('div', { class: 'list' });
    for (const r of rows.filter((x) => this.f === 'all' || x.decision === this.f)) {
      list.append(h('button', { class: `li ${this.sel === r.archive_id ? 'sel' : ''}`, onclick: () => { this.sel = r.archive_id; this.open(); } },
        h('span', { class: 'li-t' }, h('span', { class: `st ${r.decision === 'retired' ? 'retired_d' : r.decision}` }, { adopt: '채택', reject: '기각', hold: '보류', retired: '폐기' }[r.decision]), ` ${r.meta?.title || r.candidate_id}`),
        h('span', { class: 'li-s' }, `${r.archive_id} · ${r.layer} · ${r.report_id} · ${String(r.ts).slice(0, 10)}`), h('span', { class: 'li-s' }, r.reason)));
    }
    const det = h('div', { class: 'detail' });
    if (this.sel) {
      const r = await api(`/api/archive/${this.sel}`);
      det.append(h('div', { class: 'card' }, h('h3', {}, r.meta?.title || r.candidate_id), h('dl', { class: 'kv' },
        h('dt', {}, '결정'), h('dd', {}, r.decision), h('dt', {}, '사유'), h('dd', {}, r.reason), h('dt', {}, '계층'), h('dd', {}, r.layer),
        h('dt', {}, '점수'), h('dd', {}, JSON.stringify(r.scores)),
        ...((r.meta?.lessons || []).length ? [h('dt', {}, '교훈'), h('dd', {}, h('div', { class: 'list' }, ...r.meta.lessons.map((x) => h('div', { class: 'lesson-txt' }, x))))] : [])),
        r.code ? h('div', { class: 'code', style: { marginTop: '12px' } }, ...diffLines(r.code)) : null));
    } else det.append(h('div', { class: 'empty' }, '후보를 선택하세요'));
    v.append(h('div', { class: 'split', style: { height: 'calc(100% - 96px)' } }, list, det));
  },
};

/* ══════════════════════════════════════════════════════════
   승인함
   ══════════════════════════════════════════════════════════ */
const Approvals = {
  async open() {
    const v = $('#view-approvals');
    const rows = await api('/api/approvals');
    const pend = rows.filter((r) => r.status === 'pending');
    v.innerHTML = '';
    v.append(pageHead('승인 패널', '장비 상태 변경(Down→Up), Agent 정식 승격, 진화안 채택, 폐기 확정은 반드시 사람이 승인합니다. 자동·타임아웃 승인은 없습니다.'));
    const pl = h('div', { class: 'list' });
    for (const a of pend) pl.append(h('div', { class: 'li' }, h('span', { class: 'li-t' }, a.title), h('span', { class: 'li-s' }, `${a.request_id} · ${a.kind} · ${a.requested_ts}`),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h('button', { class: 'btn approve small', onclick: async () => { await api(`/api/approval/${a.request_id}`, { approved: true, approver: '운영자' }); this.open(); A.refreshSoon(); } }, '승인'),
        h('button', { class: 'btn danger small', onclick: async () => { await api(`/api/approval/${a.request_id}`, { approved: false, approver: '운영자', reason: '운영자 반려' }); this.open(); A.refreshSoon(); } }, '반려'))));
    if (!pend.length) pl.append(h('div', { class: 'empty' }, '대기 중인 승인 요청이 없습니다.'));
    const kinds = rows.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {});
    const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['요청', '종류', '제목', '결과', '승인자', '시각'].map((x) => h('th', {}, x)))));
    t.append(h('tbody', {}, ...rows.filter((r) => r.kind !== 'state_change' || !r.approver?.includes('교대')).slice(0, 120).map((r) => h('tr', {}, h('td', {}, r.request_id), h('td', {}, r.kind), h('td', {}, r.title),
      h('td', {}, h('span', { class: `st ${r.status}` }, { approved: '승인', rejected: '반려', pending: '대기' }[r.status])), h('td', {}, r.approver || '-'), h('td', {}, r.decided_ts || r.requested_ts)))));
    v.append(h('div', { class: 'grid2' }, h('div', { class: 'card' }, h('h3', {}, `대기 ${pend.length}건`), pl),
      h('div', { class: 'card' }, h('h3', {}, '승인 통계'), h('dl', { class: 'kv' }, ...Object.entries(kinds).flatMap(([k, n]) => [h('dt', {}, k), h('dd', {}, `${n}건`)])),
        h('div', { class: 'sub', style: { marginTop: '8px' } }, '배경 운영의 장비 Up 승인은 가상 교대 리더가 수행 (사람 역할 시뮬레이션)'))),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', {}, '이력 (주요 승인)'), t));
  },
};

/* ══════════════════════════════════════════════════════════
   Fab
   ══════════════════════════════════════════════════════════ */
const Fab = {
  open() {
    const v = $('#view-fab');
    const fab = A.state.fab || [];
    const by = {};
    for (const c of fab) { const eqp = c.chamber_id.slice(0, c.chamber_id.lastIndexOf('-')); (by[eqp] ||= []).push(c); }
    v.innerHTML = '';
    const cnt = fab.reduce((m, c) => { m[c.state] = (m[c.state] || 0) + 1; return m; }, {});
    v.append(pageHead('Fab 현황', `장비 30대 · 챔버 90개 — 생산 ${cnt.RUN || 0} · Down ${cnt.DOWN || 0} · Qual 진행 ${cnt.QUAL || 0} · Up 승인 대기 ${cnt.APPROVAL || 0}`));
    const grid = h('div', { class: 'fab-grid' });
    const MODEL = (e) => (e.startsWith('ETCH') ? (Number(e.slice(5)) <= 8 ? 'ETX-300' : 'ETX-500') : e.startsWith('CVD') ? 'CVX-200' : 'PVX-100');
    for (const [eqp, chs] of Object.entries(by)) {
      grid.append(h('div', { class: 'eqp' }, h('div', { class: 'eh' }, h('b', {}, eqp), h('span', {}, MODEL(eqp))),
        h('div', { class: 'chs' }, ...chs.map((c) => h('div', { class: `chm ${c.state}`, title: `${c.chamber_id} ${c.state}\n${c.note || ''}\n${c.since}`, onmouseenter: (e) => showTip(e, `<b>${c.chamber_id}</b> ${c.state}<br>${esc(c.note || '')}<br>${c.since}`), onmouseleave: hideTip },
          c.chamber_id.slice(-1))))));
    }
    v.append(grid);
  },
};

/* ══════════════════════════════════════════════════════════
   KPI
   ══════════════════════════════════════════════════════════ */
const KPI_NAME = {
  prep_time: 'Qual 준비·판정 소요시간', judge_accuracy: 'AutoQual 판정 정확도', grow_success: 'Agent 자동 생성 성공률', self_heal: '오류 자가 복구율', mttr: '평균 복구 시간(MTTR)',
  structure: '진화 후 구조 개선(코드 중복)', latency: '진화 후 응답시간', replay_effect: '이력 리플레이 진화 효과', future_leak: '미래 정보 누출', first_pass: 'Qual 1차 Pass율',
  override: '엔지니어 Override율', calls: 'Agent 호출 효율', retire: '불필요 Agent 정리', degradation: '진화 퇴화', loop_runaway: '루프 폭주', unapproved: '무승인 장비 상태 변경',
};
const Kpi = {
  async open() {
    const v = $('#view-kpi');
    v.innerHTML = '';
    v.append(pageHead('KPI', '기획서 정량 목표를 저장소·하네스 기록에서 직접 계산합니다 (eval/kpi.py). 루프는 이 계산에 접근할 수 없습니다.',
      h('button', { class: 'btn small', onclick: async () => { await api('/api/kpi?fresh=1'); this.open(); } }, '다시 계산')));
    const k = await api('/api/kpi');
    const grid = h('div', { class: 'kpis' });
    const keys = Object.keys(KPI_NAME).filter((x) => k[x]);
    const ok = keys.filter((x) => k[x].ok).length;
    for (const key of keys) {
      const x = k[key];
      const tgt = x.lower_better ? `목표 ${x.target}${x.unit.replace(/^%.*/, '%').split(' ')[0]} 이하` : `목표 ${x.target}${x.unit.split(' ')[0]} 이상`;
      grid.append(h('div', { class: `kpi ${x.ok ? 'ok' : 'miss'}` },
        h('div', { class: 'kn' }, KPI_NAME[key], h('span', { class: `verdict ${x.ok ? 'ok' : 'miss'}` }, x.ok ? '✓ 달성' : '△ 미달')),
        h('div', { class: 'kv2' }, h('b', {}, fmtNum(x.value, 1)), h('span', {}, x.unit)), h('div', { class: 'kt' }, tgt), h('div', { class: 'kd' }, x.detail)));
    }
    v.append(h('div', { class: 'sub', style: { marginBottom: '12px' } }, `${keys.length}개 지표 중 ${ok}개 달성`), grid);
  },
};

export const Views = {
  init(app) {
    A = app;
    A.trace = [];
    A.on('*', (ev) => {
      if (['node', 'budget'].includes(ev.type)) { A.trace.push(ev); if (A.trace.length > 6000) A.trace.splice(0, 1000); }
      if (ev.type === 'replay_progress' && ev.phase === 'case') A.replayProg = ev;
    });
    const live = { trace: Trace, replay: Replay, approvals: Approvals, fab: Fab };
    A.on('_state', () => { if (live[A.view]) this.open(A.view, true); });
    A.on('replay_quarter', () => { if (A.view === 'replay') this.open('replay'); });
    window.Views = this;
  },
  open(view, soft) {
    const m = { trace: Trace, replay: Replay, reports: Reports, registry: Registry, archive: Archive, approvals: Approvals, fab: Fab, kpi: Kpi }[view];
    if (!m) return;
    if (soft && view === 'trace') return;
    m.open().catch((e) => console.error(e));
  },
  openAgent(id) { Registry.open(id); },
  openReport(id) { A.go('reports'); Reports.open(id); },
};
