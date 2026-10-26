// 앱 스토어 — 스냅샷(/api/state) + SSE 이벤트 스트림(/api/events)을 슬라이스별 리듀서로 접어 넣는다.
//   백로그(새로고침 전 이벤트)는 한 번에 묶어 처리하고, 라이브 이벤트는 hub 로도 흘려 연출 컴포넌트가 바로 반응하게 한다.
import { create } from 'zustand';
import { produce } from 'immer';
import { api, operatorName } from '@/lib/api';
import { hub } from '@/lib/hub';
import { AGENT_KO, VKIND } from '@/lib/ko';
import type { AnyEv, Snapshot } from '@/lib/types';
import { initialLive, liveReduce, type LiveState } from './live';
import { initialChat, chatReduce, type ChatState } from './chat';
import { initialTrace, traceReduce, type TraceState } from './trace';
import { initialBiz, bizReduce, type BizState } from './biz';
import { initialEvolve, evolveReduce, type EvolveState } from './evolve';

export type View = 'live' | 'loop' | 'evolve' | 'agents' | 'approvals' | 'fab';
export interface Toast { id: number; text: string; level: string }

export interface AppState {
  snap: Snapshot | null;
  view: View;
  connected: boolean;
  loadedAt: number;
  lastSeq: number;
  clock: string;
  live: LiveState;
  chat: ChatState;
  trace: TraceState;
  biz: BizState;
  evolve: EvolveState;
  toasts: Toast[];
  countdown: { rid: string; seconds: number; at: number } | null;
  drawer: { kind: 'agent' | 'report' | 'archive'; id: string } | null;
  // actions
  refresh: () => Promise<void>;
  refreshSoon: () => void;
  connect: () => void;
  go: (v: View) => void;
  toast: (text: string, level?: string) => void;
  decide: (rid: string, approved: boolean, reason?: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  control: (path: string, body?: unknown) => Promise<void>;
  openDrawer: (kind: 'agent' | 'report' | 'archive', id: string) => void;
  closeDrawer: () => void;
  toggleSpan: (id: number) => void;
  toggleRun: (key: string) => void;
  setFocus: (id: number) => void;
  setBizFocus: (id: string | null) => void;
  setCases: (cases: BizState['cases']) => void;
}

const REFRESH_ON = new Set(['version', 'registry', 'approval', 'chapter', 'fab', 'fault', 'policy', 'report', 'replay_quarter', 'kpi']);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 1;

function reduceAll(s: AppState, ev: AnyEv) {
  try { liveReduce(s.live, ev); } catch (e) { console.error('live', ev.type, e); }
  try { chatReduce(s.chat, ev); } catch (e) { console.error('chat', ev.type, e); }
  try { traceReduce(s.trace, ev); } catch (e) { console.error('trace', ev.type, e); }
  try { bizReduce(s.biz, ev); } catch (e) { console.error('biz', ev.type, e); }
  try { evolveReduce(s.evolve, ev); } catch (e) { console.error('evolve', ev.type, e); }
}

export const useApp = create<AppState>()((set, get) => ({
  snap: null,
  view: (location.hash.replace('#', '') as View) || 'live',
  connected: false,
  loadedAt: Date.now() / 1000,
  lastSeq: 0,
  clock: '',
  live: initialLive(),
  chat: initialChat(),
  trace: initialTrace(),
  biz: initialBiz(),
  evolve: initialEvolve(),
  toasts: [],
  countdown: null,
  drawer: null,

  async refresh() {
    try {
      const snap = await api<Snapshot>('/api/state');
      set(produce((s: AppState) => {
        s.snap = snap;
        if (!s.clock) s.clock = snap.clock;
        for (const c of snap.fab || []) if (!s.biz.fab[c.chamber_id] || s.biz.fab[c.chamber_id].since <= c.since) s.biz.fab[c.chamber_id] = c;
      }));
      hub.emit({ seq: 0, type: '_state', wall: Date.now() / 1000, state: snap } as AnyEv);
    } catch { /* 서버 재시작 중 */ }
  },
  refreshSoon() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; get().refresh(); }, 350);
  },

  connect() {
    const st = get();
    const es = new EventSource(`/api/events?since=${st.lastSeq}`);
    let backlog: AnyEv[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!backlog.length) return;
      const batch = backlog; backlog = [];
      set(produce((s: AppState) => { for (const ev of batch) reduceAll(s, ev); s.lastSeq = batch[batch.length - 1].seq; }));
      const last = batch[batch.length - 1];
      if (last.vts) set({ clock: last.vts });
      hub.emit({ seq: 0, type: '_backlog', wall: Date.now() / 1000, n: batch.length } as AnyEv);
    };
    es.onopen = () => set({ connected: true });
    es.onmessage = (m) => {
      const ev: AnyEv = JSON.parse(m.data);
      if (ev.seq <= get().lastSeq) return;
      ev.backlog = ev.wall < get().loadedAt - 1;
      if (ev.backlog) {
        backlog.push(ev);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 120);
        return;
      }
      flush();
      const evHub: AnyEv = { ...ev };   // 스토어에 들어간 원본은 immer가 동결하므로 허브용 사본
      set(produce((s: AppState) => {
        reduceAll(s, ev);
        s.lastSeq = ev.seq;
        if (ev.vts) s.clock = ev.vts;
        if (ev.type === 'toast') s.toasts = [...s.toasts.slice(-3), { id: toastSeq++, text: ev.text, level: ev.level || 'ok' }];
        if (ev.type === 'version' && ev.kind !== 'baseline') s.toasts = [...s.toasts.slice(-3), { id: toastSeq++, text: `${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.from_version || '—'} → ${ev.to_version} (${VKIND[ev.kind] || ev.kind}${ev.ref ? ' ' + ev.ref : ''})`, level: ev.kind === 'rollback' ? 'warn' : 'ver' }];
        if (ev.type === 'approval_countdown') s.countdown = { rid: ev.request_id, seconds: ev.seconds, at: Date.now() };
        if (ev.type === 'approval' && ev.action === 'decided' && s.countdown?.rid === ev.request_id) s.countdown = null;
      }));
      hub.emit(evHub);
      if (REFRESH_ON.has(ev.type) || (ev.type === 'replay_progress' && (ev.phase === 'start' || ev.phase === 'quarter_start')) || (ev.type === 'story' && /타임라인 완료|중단|오류/.test(ev.text))) get().refreshSoon();
    };
    es.onerror = () => { es.close(); set({ connected: false }); setTimeout(() => get().connect(), 1500); };
  },

  go(v) { set({ view: v }); location.hash = v; },
  toast(text, level = 'ok') { set((s) => ({ toasts: [...s.toasts.slice(-3), { id: toastSeq++, text, level }] })); },
  async decide(rid, approved, reason = '') {
    try { await api(`/api/approval/${rid}`, { approved, approver: operatorName(), reason: reason || (approved ? '' : '운영자 반려') }); }
    catch (e) { get().toast((e as Error).message, 'error'); }
    set({ countdown: null });
    get().refreshSoon();
  },
  async send(text) {
    try { await api('/api/chat', { text }); } catch (e) { get().toast((e as Error).message, 'error'); }
  },
  async control(path, body = {}) {
    try { await api(path, body); } catch (e) { get().toast((e as Error).message, 'error'); }
    get().refreshSoon();
  },
  openDrawer(kind, id) { set({ drawer: { kind, id } }); },
  closeDrawer() { set({ drawer: null }); },
  toggleSpan(id) { set(produce((s: AppState) => { const sp = s.trace.spans[id]; if (!sp) return; sp.open = !(sp.open || s.trace.autoOpenId === id); sp.pinned = sp.open; if (s.trace.autoOpenId === id && !sp.open) s.trace.autoOpenId = null; })); },
  toggleRun(key) { set(produce((s: AppState) => { const r = s.trace.runs[key]; if (r) r.open = !r.open; })); },
  setFocus(id) { set(produce((s: AppState) => { const f = s.live.acts.find((a) => a.id === id); if (f) s.live.focus = f; })); },
  setBizFocus(id) { set(produce((s: AppState) => { s.biz.focus = id; })); },
  setCases(cases) { set(produce((s: AppState) => { s.biz.cases = cases; s.biz.caseIds = cases.map((c) => c.request_id || c.id); s.biz.casesLoaded = true; })); },
}));

// 연출 속도 — 스토리 재생 속도에 맞춘 애니메이션 길이 (speed=0 이면 즉시)
export function ms(base: number) { const v = Number(useApp.getState().snap?.speed ?? 1); return v ? base / Math.max(0.5, v) : 0; }
export function dismissToast(id: number) { useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); }
