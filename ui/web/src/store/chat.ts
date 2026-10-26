// 대화 슬라이스 — 엔지니어 요청과 Super Agent 응답 전문 (Mock Fab 진행·Heal/Grow 기동 메모 포함)
import type { AnyEv } from '@/lib/types';

export interface Block { kind: string; title: string; lines: string[]; warn?: boolean; count?: number }
export interface ChatMsg { id: number; kind: 'user' | 'bot' | 'replay'; rid?: string; who: string; text?: string; vts?: string; blocks: Block[]; notes: { text: string; cls: string }[]; latency?: number; rtype?: string; ev?: AnyEv }
export interface ChatState { msgs: ChatMsg[]; byRid: Record<string, number>; nextId: number }
export const initialChat = (): ChatState => ({ msgs: [], byRid: {}, nextId: 1 });

function group(C: ChatState, rid: string): ChatMsg {
  const id = C.byRid[rid];
  let m = id != null ? C.msgs.find((x) => x.id === id) : undefined;
  if (!m) {
    m = { id: C.nextId++, kind: 'bot', rid, who: 'Super Agent', blocks: [], notes: [] };
    C.msgs.push(m);
    C.byRid[rid] = m.id;
  }
  return m;
}
function trim(C: ChatState) { while (C.msgs.length > 220) { const m = C.msgs.shift(); if (m?.rid && C.byRid[m.rid] === m.id) delete C.byRid[m.rid]; } }

export function chatReduce(C: ChatState, ev: AnyEv) {
  switch (ev.type) {
    case 'request':
      if (ev.source === 'sim') break;
      C.msgs.push({ id: C.nextId++, kind: 'user', rid: ev.request_id, who: ev.user || '엔지니어', text: ev.text, vts: ev.vts, blocks: [], notes: [] });
      group(C, ev.request_id).vts = ev.vts;
      trim(C);
      break;
    case 'response': {
      if (!ev.request_id) break;
      const g = group(C, ev.request_id);
      g.vts = g.vts || ev.vts;
      g.latency = ev.latency_ms;
      g.rtype = ev.rtype;
      for (const b of ev.blocks || []) g.blocks.push(b);
      break;
    }
    case 'fab_progress': if (ev.request_id) group(C, ev.request_id).notes.push({ text: `Mock Fab · ${ev.text}`, cls: 'fab' }); break;
    case 'thought': if (ev.request_id && (ev.kind === 'warn' || ev.kind === 'ask')) group(C, ev.request_id).notes.push({ text: ev.text, cls: 'warn' }); break;
    case 'node':
      if (ev.loop === 'L2' && ev.request_id && C.byRid[ev.request_id] != null) {
        if (ev.node === 'start') group(C, ev.request_id).notes.push({ text: `${ev.sub === 'grow' ? 'Agent Factory' : 'Self-Healing'} 기동 — ${ev.detail}`, cls: 'l2' });
        if (ev.node === 'register_version' || ev.node === 'register_probation') group(C, ev.request_id).notes.push({ text: ev.detail, cls: 'ok' });
      }
      break;
    case 'replay_case_done': {
      C.msgs.push({ id: C.nextId++, kind: 'replay', who: '리플레이', vts: ev.vts, blocks: [], notes: [], ev });
      trim(C);
      break;
    }
    default: break;
  }
}
