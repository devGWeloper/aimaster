// Jev 보정 확률 막대 — 선택된 답은 파랑, LLM 재검토 대상은 앰버, 나머지는 회색
import { useEffect, useState } from 'react';
import { AGENT_KO, HEAD_KO } from '@/lib/ko';
import { cn } from '@/lib/utils';
import type { AnyEv } from '@/lib/types';

export default function JevBars({ ev, live, max = 7, big }: { ev: AnyEv; live?: boolean; max?: number; big?: boolean }) {
  const [grow, setGrow] = useState(!live);
  useEffect(() => { if (!live) { setGrow(true); return; } setGrow(false); const t = requestAnimationFrame(() => requestAnimationFrame(() => setGrow(true))); return () => cancelAnimationFrame(t); }, [ev, live]);
  const sel: string[] = Array.isArray(ev.answer) ? ev.answer : [ev.answer];
  const esc = (ev.escalated || []).map((x: AnyEv) => x.agent_id);
  const rows = Object.entries((ev.probs || {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, max);
  const f = ev.features || {};
  return (
    <div className="space-y-2">
      <div className={cn('text-ink-2', big ? 'text-[13px]' : 'text-[12px]')}>
        <b className="text-ink">{ev.question || HEAD_KO[ev.head] || ev.head}</b>
        <span className="ml-2 text-ink-3">보정 확률 · {ev.model || 'jev-local-calibrated'}{ev.threshold ? ` · 자율 ≥${ev.threshold}, 재검토 ≥0.60` : ''}</span>
      </div>
      <div className="space-y-1.5">
        {rows.map(([k, p]) => (
          <div key={k} className={cn('jv', sel.includes(k) ? 'sel' : esc.includes(k) ? 'esc' : 'off', big && 'text-[13px]')}>
            <span className="truncate">{AGENT_KO[k] || k}</span>
            <span className="bar" style={big ? { height: 14 } : undefined}><i style={{ width: grow ? `${Math.round(p * 100)}%` : '0%' }} /></span>
            <span className="v">{p.toFixed(2)}</span>
          </div>
        ))}
      </div>
      {f.missing?.length ? <div className="text-[12px] text-warn">부족한 능력: {f.missing.join(', ')} → Grow</div> : null}
      {(ev.escalated || []).map((e: AnyEv) => <div key={e.agent_id} className="text-[12px] text-ink-2">LLM 재검토: {AGENT_KO[e.agent_id] || e.agent_id} p={Number(e.p).toFixed(2)} → {e.keep ? '편입' : '제외'} ({e.why})</div>)}
    </div>
  );
}

export function RouteBars({ route }: { route: AnyEv }) {
  const sel: string[] = route.selected || [];
  const probs = (route.probs || {}) as Record<string, number>;
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-ink-2">Jev 보정 확률로 편성 (처리 가능 p={(route.can_handle ?? 0).toFixed(2)}) → {sel.length}개 Agent{sel.length > 1 ? ' 병렬' : ''} 호출</div>
      <div className="space-y-1.5">
        {Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([k, p]) => {
          const c = sel.includes(k) ? 'sel' : (route.escalated || []).some((x: AnyEv) => x.agent_id === k) ? 'esc' : 'off';
          return <div key={k} className={cn('jv', c)}><span className="truncate">{AGENT_KO[k] || k}</span><span className="bar"><i style={{ width: `${Math.round(p * 100)}%` }} /></span><span className="v">{p.toFixed(2)}</span></div>;
        })}
      </div>
      {(route.escalated || []).map((e: AnyEv) => <div key={e.agent_id} className="text-[12px] text-ink-2">LLM 재검토: {AGENT_KO[e.agent_id] || e.agent_id} p={Number(e.p).toFixed(2)} → {e.keep ? '편입' : '제외'} ({e.why})</div>)}
      {(route.skipped || []).map((s: AnyEv) => <div key={s.agent_id} className="text-[12px] text-ink-3">편성 전략 생략: {AGENT_KO[s.agent_id] || s.agent_id} — {s.reason} [{s.rule}]</div>)}
    </div>
  );
}
