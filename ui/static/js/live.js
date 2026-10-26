// 대화 화면 — 엔지니어 채팅(요청·응답 전문) · 동적 Agent 편성 맵(요청이 처리되는 동안 누가 불리고 무엇을 받아오는지) · 실행 트레이스(모든 단계가 값·코드와 함께 남는다)
import { $, h, api, vdate } from './util.js';
import { createGraph } from './graph.js';
import { Trace } from './trace.js';

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
      'CVD-05 A챔버 Showerhead 교체 PM 끝났어. AutoQual 진행해줘',
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
      h('div', { style: { color: 'var(--ink)', fontWeight: 650, marginBottom: '6px' } }, '엔지니어처럼 요청하면 Super Agent가 처리합니다'),
      h('div', {}, '가운데 편성 맵에서 어떤 Agent가 불리고 무엇을 가져오는지, 오른쪽 트레이스에서 코드·확률·값을 볼 수 있습니다. 상단 Autopilot을 누르면 시나리오가 자동 진행됩니다.'));
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
  note(ev, text, cls) {
    const g = this.group(ev.request_id);
    g.append(h('div', { class: `fabline ${cls || ''}` }, text));
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

let graph = null;

function onEvent(ev) {
  switch (ev.type) {
    case 'request': if (ev.source !== 'sim') Chat.request(ev); break;
    case 'response': Chat.response(ev); break;
    case 'fab_progress': Chat.fab(ev); break;
    case 'replay_case_done': Chat.replayCase(ev); break;
    case 'thought': if (ev.kind === 'warn' || ev.kind === 'ask') Chat.note(ev, `Super Agent · ${ev.text}`, 'warn'); break;
    case 'node':
      if (ev.loop === 'L2' && ev.node === 'start' && ev.request_id && Chat.groups.has(ev.request_id)) Chat.note(ev, `${ev.sub === 'grow' ? 'Agent Factory' : 'Self-Healing'} 기동 — ${ev.detail}`, 'l2');
      if (ev.loop === 'L2' && (ev.node === 'register_version' || ev.node === 'register_probation') && ev.request_id && Chat.groups.has(ev.request_id)) Chat.note(ev, ev.detail, 'ok');
      break;
    default: break;
  }
  graph.event(ev);
  Trace.event(ev);
}

export const Live = {
  init(app) {
    A = app;
    Chat.init();
    graph = createGraph(A, $('#live-graph'), { live: true });
    Trace.init(A, $('#live-trace'));
    A.on('*', onEvent);
  },
};
