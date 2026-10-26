// 일시적 연출용 이벤트 허브 — 편성 맵·루프 트랙처럼 "지금 이 순간"만 그리면 되는 컴포넌트가 구독한다 (스토어를 거치지 않음).
import type { AnyEv } from './types';

type Fn = (ev: AnyEv) => void;
const subs = new Map<string, Set<Fn>>();

export const hub = {
  on(type: string, fn: Fn) {
    if (!subs.has(type)) subs.set(type, new Set());
    subs.get(type)!.add(fn);
    return () => { subs.get(type)?.delete(fn); };
  },
  emit(ev: AnyEv) {
    for (const fn of subs.get(ev.type) || []) { try { fn(ev); } catch (e) { console.error('hub', ev.type, e); } }
    for (const fn of subs.get('*') || []) { try { fn(ev); } catch (e) { console.error('hub*', ev.type, e); } }
  },
};
