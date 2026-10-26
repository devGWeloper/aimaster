// 앱 코어 — 상태, SSE 이벤트 스트림, 상단 제어, 챕터 타임라인, 승인 게이트, 라우팅
import { $, $$, h, api, vdate, debounce, AGENT_KO } from './util.js';
import { Live } from './live.js';
import { Flow } from './flow.js';
import { Views } from './views.js';

export const App = {
  state: null,
  handlers: {},
  view: 'flow',
  loadedAt: Date.now() / 1000,
  lastSeq: 0,
  on(type, fn) { (this.handlers[type] ||= []).push(fn); },
  emit(ev) { for (const fn of [...(this.handlers[ev.type] || []), ...(this.handlers['*'] || [])]) { try { fn(ev); } catch (e) { console.error(ev.type, e); } } },
};
window.App = App;

async function refresh() {
  try {
    App.state = await api('/api/state');
  } catch (e) { return; }
  renderTop();
  renderChapters();
  renderBadge();
  App.emit({ type: '_state', state: App.state });
}
const refreshSoon = debounce(refresh, 350);
App.refresh = refresh;
App.refreshSoon = refreshSoon;

// ── 상단 ────────────────────────────────────────────────
function setClock(vts) {
  if (!vts) return;
  const { d, t } = vdate(vts);
  $('#clock-d').textContent = d;
  $('#clock-t').textContent = t;
}

let replayClock = null;
function renderTop() {
  const st = App.state;
  if (!st) return;
  if (!App.clockLive) setClock(st.clock);
  const mode = $('#mode');
  mode.innerHTML = '';
  const rp = st.replay || {};
  if (rp.state === 'running') {
    mode.append(h('span', { class: 'chip replay' }, h('i', { class: 'dot' }), '리플레이 모드 — Time-Travel Guard ON', replayClock ? `  replay_clock ${replayClock.slice(0, 10)}` : ''));
  } else {
    mode.append(h('span', { class: 'chip ops' }, h('i', { class: 'dot' }), '운영 모드'));
  }
  const llm = st.llm || {};
  mode.append(h('span', { class: 'chip llm', title: llm.mode === 'offline' ? '사내 LLM 미연결 — 결정적 재현용 Playbook 코드 사용 (config/llm.json으로 사내 API 연결)' : llm.base_url },
    h('i', { class: 'dot' }), llm.mode === 'offline' ? 'LLM: 오프라인 Playbook' : `LLM: 사내 API (${llm.mode})`));
  for (const f of st.faults || []) {
    mode.append(h('span', { class: 'chip fault', title: JSON.stringify(f.params) }, h('i', { class: 'dot' }), `장애 주입: ${f.type}`));
  }
  const running = st.story?.running;
  const nDone = (st.story?.done || []).length, nAll = (st.story?.chapters || []).length;
  $('#play-label').textContent = running ? 'Autopilot 실행 중' : (nDone >= nAll && nAll ? 'Autopilot 처음부터' : (nDone ? 'Autopilot 계속' : 'Autopilot 시작'));
  $('#btn-play').disabled = !!running;
  $('#btn-pause').classList.toggle('on', st.paused);
  $('#auto-approve').checked = st.approval_mode === 'auto';
  $('#approve-label').textContent = st.approval_mode === 'auto' ? '승인: 데모 자동' : '승인: 사람';
  $$('#speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === Number(st.speed)));
}

function renderBadge() {
  const n = (App.state?.approvals || []).length;
  const b = $('#badge-approvals');
  b.textContent = n;
  b.classList.toggle('on', n > 0);
  Gate.sync(App.state?.approvals || []);
}

// ── 챕터 ────────────────────────────────────────────────
let curChapter = null;
function renderChapters() {
  const st = App.state?.story;
  if (!st) return;
  const nav = $('#chapters');
  nav.innerHTML = '';
  const track = h('div', { class: 'ch-track' });
  for (const c of st.chapters) {
    const cls = ['ch', c.done ? 'done' : '', (st.current || curChapter) === c.id && st.running ? 'cur' : ''].join(' ');
    track.append(h('button', { class: cls, title: `${c.title}\n${c.desc}${c.checkpoint ? '\n(체크포인트 있음 — 클릭해 이 지점으로 이동)' : ''}`, onclick: () => chapterMenu(c) },
      h('span', { class: 'ch-date' }, c.date), h('span', { class: 'ch-title' }, c.title), h('i', { class: 'ch-bar' })));
  }
  nav.append(track);
}

function chapterMenu(c) {
  const st = App.state.story;
  if (st.running) { toast('Autopilot 실행 중입니다. 정지 후 이동하세요.', 'warn'); return; }
  const idx = st.chapters.findIndex((x) => x.id === c.id);
  const prev = st.chapters[idx - 1];
  const g = $('#gate');
  g.hidden = false;
  g.innerHTML = '';
  g.append(h('div', { class: 'g-h' }, h('div', { class: 'shield' }, '⤴'), h('div', {}, h('div', { class: 'g-kind' }, c.date), h('div', { class: 'g-title' }, c.title))),
    h('div', { class: 'g-body' }, c.desc, prev && !prev.checkpoint ? h('div', { class: 'muted' }, '이전 챕터 체크포인트가 없어 처음부터 실행해야 합니다.') : null),
    h('div', { class: 'g-act' },
      h('button', { class: 'btn primary', disabled: idx > 0 && !prev.checkpoint, onclick: async () => {
        g.hidden = true;
        try { await api('/api/story/jump', { id: c.id }); await api('/api/story/start', { from: c.id }); } catch (e) { toast(e.message, 'error'); }
        refresh();
      } }, '이 챕터부터 실행'),
      h('button', { class: 'btn', disabled: idx > 0 && !prev.checkpoint, onclick: async () => {
        g.hidden = true;
        try { await api('/api/story/jump', { id: c.id }); toast(`${c.title} 직전 상태로 이동했습니다.`); } catch (e) { toast(e.message, 'error'); }
        refresh();
      } }, '이 지점으로 이동'),
      h('button', { class: 'btn', onclick: () => { g.hidden = true; Gate.sync(App.state.approvals || []); } }, '닫기')));
}

// ── 승인 게이트 ─────────────────────────────────────────
const KIND_KO = { state_change: '장비 상태 변경', promotion: 'Agent 정식 승격', evolution: '진화안 채택', retire: 'Agent 폐기 확정', policy: '평가 기준 변경' };
export const Gate = {
  cur: null,
  countdown: null,
  sync(pending) {
    const g = $('#gate');
    if (!pending.length) { if (this.cur) { g.hidden = true; this.cur = null; } return; }
    const a = pending[pending.length - 1];
    if (this.cur === a.request_id && !g.hidden) return;
    this.cur = a.request_id;
    this.render(a);
  },
  render(a) {
    const g = $('#gate');
    g.hidden = false;
    g.innerHTML = '';
    const p = a.payload || {};
    const lines = [];
    if (a.kind === 'state_change') {
      const ev = p.evidence || {};
      const j = ev.judgement || {};
      lines.push(`판정 judge_qual: ${j.result} (${(j.details || []).map((d) => `${d.item} ${d.value}`).join(', ')})`);
      lines.push(`절차 ${ev.procedure} · Seasoning ${ev.count}매 · 시도 ${ev.attempts}회`);
      lines.push('Jev 확신도와 무관하게 장비 상태 변경은 사람 승인 필수 (임계값 하한 0.95, 루프 밖 고정)');
    } else if (a.kind === 'evolution') {
      (p.lines || []).forEach((x) => lines.push(x));
    } else if (a.kind === 'promotion') {
      lines.push(`${p.agent_id} ${p.version}: ${p.why}`);
      lines.push(`테스트 ${p.tests} · 누적 호출 ${p.calls}건`);
    } else if (a.kind === 'retire') {
      lines.push(p.note || '');
      lines.push(`유예 종료 ${String(p.grace_until || '').slice(0, 10)} · 대체 ${p.replacement || '-'}`);
    }
    const note = h('input', { class: 'g-note', placeholder: '사유 (선택)' });
    const cd = h('span', { class: 'g-cd', id: 'gate-cd' });
    g.append(
      h('div', { class: 'g-h' }, h('div', { class: 'shield' }, h('svg', { viewBox: '0 0 24 24', class: 'ic', html: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>' })),
        h('div', {}, h('div', { class: 'g-kind' }, `사람 승인 필요 — ${KIND_KO[a.kind] || a.kind}`), h('div', { class: 'g-title' }, a.title))),
      h('div', { class: 'g-body' }, ...lines.map((x) => h('div', {}, x))),
      h('div', { class: 'g-act' },
        h('button', { class: 'btn approve', onclick: () => this.decide(a, true, note.value) }, '승인'),
        h('button', { class: 'btn danger', onclick: () => this.decide(a, false, note.value || '운영자 반려') }, '반려'),
        h('button', { class: 'btn', onclick: () => { g.hidden = true; } }, '나중에'), cd),
      note);
  },
  async decide(a, ok, reason) {
    try { await api(`/api/approval/${a.request_id}`, { approved: ok, approver: '운영자', reason }); } catch (e) { toast(e.message, 'error'); }
    $('#gate').hidden = true;
    this.cur = null;
    refreshSoon();
  },
  startCountdown(rid, sec) {
    const el = $('#gate-cd');
    if (!el || this.cur !== rid) return;
    let n = sec;
    clearInterval(this.countdown);
    el.textContent = `데모 운영자 자동 승인 ${n}s`;
    this.countdown = setInterval(() => { n -= 1; if (n <= 0 || !$('#gate-cd')) { clearInterval(this.countdown); return; } $('#gate-cd').textContent = `데모 운영자 자동 승인 ${n}s`; }, 1000 / Math.max(0.5, App.state?.speed || 1));
  },
};

// ── 토스트 ──────────────────────────────────────────────
export function toast(text, level = 'ok') {
  const t = h('div', { class: `toast ${level}` }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6500);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}
App.toast = toast;

// ── 라우팅 ──────────────────────────────────────────────
function go(view) {
  App.view = view;
  document.body.dataset.view = view;
  $$('#rail button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${view}`));
  if (view === 'flow') Flow.shown();
  else if (view !== 'live') Views.open(view);
  location.hash = view;
}
App.go = go;

// ── SSE ────────────────────────────────────────────────
function connect() {
  const es = new EventSource(`/api/events?since=${App.lastSeq}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.seq <= App.lastSeq) return;
    App.lastSeq = ev.seq;
    ev.backlog = ev.wall < App.loadedAt - 1;
    if (ev.vts) { App.clockLive = true; setClock(ev.vts); }
    if (ev.type === 'replay_progress' && ev.replay_clock) replayClock = ev.replay_clock;
    App.emit(ev);
    if (['version', 'registry', 'approval', 'chapter', 'fab', 'fault', 'policy', 'report', 'replay_quarter'].includes(ev.type)) refreshSoon();
    if (ev.type === 'replay_progress' && (ev.phase === 'start' || ev.phase === 'quarter_start')) refreshSoon();
    if (ev.type === 'story' && /타임라인 완료|중단|오류/.test(ev.text)) refreshSoon();
    if (!ev.backlog) {
      if (ev.type === 'toast') toast(ev.text, ev.level || 'ok');
      if (ev.type === 'version' && ev.kind !== 'baseline') toast(`${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.from_version || '-'} → ${ev.to_version} (${ev.kind}${ev.ref ? ' ' + ev.ref : ''})`, ev.kind === 'rollback' ? 'warn' : 'ver');
      if (ev.type === 'approval_countdown') setTimeout(() => Gate.startCountdown(ev.request_id, ev.seconds), 400);
      if (ev.type === 'chapter' && ev.phase === 'start') { curChapter = ev.id; }
    }
  };
  es.onerror = () => { es.close(); setTimeout(connect, 1500); };
}

// ── 제어 바인딩 ──────────────────────────────────────────
function bind() {
  $('#btn-play').onclick = async () => { try { await api('/api/story/start', {}); } catch (e) { toast(e.message, 'error'); } refreshSoon(); };
  $('#btn-pause').onclick = async () => { await api(App.state?.paused ? '/api/resume' : '/api/pause', {}); refreshSoon(); };
  $('#btn-stop').onclick = async () => { await api('/api/story/stop', {}); refreshSoon(); };
  $$('#speed button').forEach((b) => { b.onclick = async () => { await api('/api/speed', { speed: Number(b.dataset.v) }); refreshSoon(); }; });
  $('#auto-approve').onchange = async (e) => { await api('/api/approval_mode', { mode: e.target.checked ? 'auto' : 'manual' }); refreshSoon(); };
  $$('#rail button').forEach((b) => { b.onclick = () => go(b.dataset.view); });
  App.on('chapter', (ev) => { if (!ev.backlog) renderChapters(); });
}

async function boot() {
  bind();
  await refresh();
  Flow.init(App);
  Live.init(App);
  Views.init(App);
  connect();
  const hv = location.hash.replace('#', '');
  if (hv && hv !== 'flow') go(hv);
  setInterval(refresh, 15000);
}
boot();
