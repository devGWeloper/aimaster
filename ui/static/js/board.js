// Agent 무대(기본 화면) — 과제의 핵심 셋만 크게: LOOP ENGINEERING(3중 루프 트랙) · AGENT 편성(호출·값·생성/치유) · SELF-EVOLVING(진화 사건 피드 + 5계층 + 계보)
//   같은 SSE 이벤트 스트림을 세 영역이 각자의 관점으로 그린다. 요청·응답 전문과 실행 트레이스는 「대화」 화면, AutoQual 업무 흐름·Fab 현황은 「Fab·업무」 화면에 있다.
import { $, h } from './util.js';
import { Stage, Cap } from './stage.js';
import { Trace } from './trace.js';
import { createGraph } from './graph.js';
import { Evolve } from './evolve.js';

let A = null;
let graph = null;

function syncCounts() {
  const st = A.state || {};
  const c = Trace.counts;
  const sb = st.counts?.sandbox || {};
  Cap.counts({
    code: Math.max(c.code, sb.executions || 0), calls: c.calls, jev: Math.max(c.jev, st.jev?.calls || 0),
    heal: Math.max(c.heal, st.counts?.heals || 0), grow: Math.max(c.grow, st.counts?.grows || 0), evolve: Math.max(c.evolve, st.counts?.evolves || 0),
    human: c.human, unapproved: 0,
  });
}

export const StageView = {
  init(app) {
    A = app;
    const v = $('#view-stage');
    const cap = h('section', { class: 'fl-cap st-cap' });
    const loops = h('section', { class: 'fl-panel st-loops' });
    const graphHost = h('section', { class: 'fl-panel st-graph' });
    const evolve = h('section', { class: 'fl-panel st-evolve' });
    loops.append(h('header', { class: 'fp-h' }, h('b', { class: 'kw l1' }, 'LOOP ENGINEERING'), h('span', { class: 'fp-d' }, '3중 루프 — L1 요청 처리 · L2 Heal/Grow(예산 5회·15분) · L3 Evolve · 토큰 = 지금 실행 중인 위치')));
    const map = h('div', { class: 'fl-map' });
    loops.append(map, h('footer', { class: 'fl-leg' },
      h('span', {}, h('i', { class: 'lg-tok' }), '토큰 = 지금 위치'),
      h('span', {}, h('i', { class: 'lg-ca' }), 'CodeAct (코드 작성·실행)'),
      h('span', {}, h('i', { class: 'lg-jev' }), 'Jev 판단 (보정 확률)'),
      h('span', {}, h('i', { class: 'lg-det' }), '결정적 코드 (LLM 아님)'),
      h('span', {}, h('i', { class: 'lg-gate' }), '사람 승인')));
    v.append(cap, h('div', { class: 'st-row1' }, loops, graphHost), evolve);
    Stage.init(A, { cap, loops: map, evo: null });
    graph = createGraph(A, graphHost, { live: false });
    Evolve.init(A, evolve);
    Trace.onCount = syncCounts;
    A.on('*', (ev) => { Stage.event(ev); graph.event(ev); Evolve.event(ev); if (ev.type === '_state') syncCounts(); });
    syncCounts();
  },
  shown() { Evolve.shown(); },
};
