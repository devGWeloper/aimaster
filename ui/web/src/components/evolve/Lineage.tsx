// Agent Genome 계보 — 행 = Agent, 열 = 사건(시간순, 챕터 띠), 알약 = 새 버전. 사람이 만든 1.0.0에서 Agent가 스스로 바꾼 기록.
import { useEffect, useRef } from 'react';
import { useApp } from '@/store/store';
import type { LineageRow } from '@/lib/types';
import { AGENT_KO, VKIND, short } from '@/lib/ko';

const MAIN = ['super_agent', 'spec_agent', 'log_agent', 'legacy_agent'];
const EV_C: Record<string, string> = { baseline: 'var(--ink-3)', heal: 'var(--l2)', grow: 'var(--l2)', evolve: 'var(--l3)', compose: 'var(--l3)', rollback: 'var(--bad)', promote: 'var(--ok)', restore: 'var(--l1)', deprecate: 'var(--warn)', retire: '#7b8691', grace_restart: 'var(--warn)', defect: 'var(--bad)', shadow: 'var(--l3)' };
function textW(t: string, size: number) { let w = 0; for (const ch of t) w += /[ㄱ-힝]/.test(ch) ? size * 0.92 : /[A-Z0-9]/.test(ch) ? size * 0.64 : size * 0.52; return w; }

export default function Lineage({ rows }: { rows: LineageRow[] }) {
  const snap = useApp((s) => s.snap);
  const open = useApp((s) => s.openDrawer);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = box.current; if (el) el.scrollLeft = el.scrollWidth; }, [rows]);
  if (!rows.length || !snap) return <div className="text-[12.5px] text-ink-3">아직 계보가 없습니다.</div>;
  const chapters = snap.story?.chapters || [];
  const reg = new Map((snap.registry?.agents || []).map((a) => [a.agent_id, a]));
  const cols: { key: string; ts: string; ref?: string; items: LineageRow[]; ch?: string }[] = [];
  let prev: string | null = null;
  for (const r of rows) { const key = r.ref || r.ts; if (key !== prev) { cols.push({ key, ts: r.ts, ref: r.ref, items: [] }); prev = key; } cols[cols.length - 1].items.push(r); }
  const base = chapters[0]?.date || '2026-07-01';
  for (const c of cols) {
    if (c.items.every((r) => r.kind === 'baseline')) { c.ch = chapters[0]?.id; continue; }
    const t = String(c.ts).slice(0, 10);
    if (t < base) { c.ch = chapters[1]?.id; continue; }
    let best = chapters[1]?.id;
    for (const ch of chapters) { const d = ch.date.length === 7 ? `${ch.date}-01` : ch.date; if (d <= t) best = ch.id; }
    c.ch = best;
  }
  const first = new Map<string, number>();
  rows.forEach((r) => { if (!first.has(r.agent_id)) first.set(r.agent_id, r.id); });
  const ids = [...first.keys()];
  const kindOf = (id: string) => reg.get(id)?.kind || 'agent';
  const order = [...MAIN.filter((x) => first.has(x)), ...ids.filter((x) => !MAIN.includes(x) && kindOf(x) === 'agent').sort((a, b) => first.get(a)! - first.get(b)!), ...ids.filter((x) => kindOf(x) === 'skill').sort((a, b) => first.get(a)! - first.get(b)!)];
  const RH = 30, TOP = 22, NAMEW = 0;
  const avail = (box.current?.clientWidth || 420) - 20;
  const CW = Math.max(56, Math.min(92, avail / Math.max(1, cols.length)));
  const W = Math.max(avail + 20, NAMEW + cols.length * CW + 20), H = TOP + order.length * RH + 6;
  const bands: { x: number; w: number; ch?: string }[] = [];
  let i0 = 0;
  for (let i = 1; i <= cols.length; i += 1) if (i === cols.length || cols[i].ch !== cols[i0].ch) { bands.push({ x: NAMEW + i0 * CW, w: (i - i0) * CW, ch: cols[i0].ch }); i0 = i; }
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-ink-2">행 = Agent · 열 = 사건(시간순) · 알약 = 새 버전. <span className="text-l2">분홍</span> Grow·Heal, <span className="text-l3">보라</span> Evolve, <span className="text-ok">초록</span> 승격, <span className="text-bad">빨강</span> 롤백·결함, <span className="text-warn">앰버</span> 폐기 유예, × 폐기(아카이브)</div>
      <div className="flex rounded-lg border border-line bg-bg">
        <div className="flex-none border-r border-line" style={{ width: 150, paddingTop: TOP }}>
          {order.map((id) => { const a = reg.get(id); const gone = a?.status === 'retired'; return (
            <button key={id} type="button" onClick={() => open('agent', id)} className="flex w-full items-center justify-between px-2.5 text-left hover:bg-panel-2" style={{ height: RH }}>
              <span className={`text-[12px] font-bold ${gone ? 'text-ink-3 line-through' : a?.status === 'deprecated' ? 'text-warn' : 'text-ink'}`}>{AGENT_KO[id] || short(id)}</span>
              <span className="font-mono text-[10.5px] text-ink-3">{a?.active_version || ''}</span>
            </button>); })}
        </div>
        <div ref={box} className="min-w-0 flex-1 overflow-auto">
        <svg width={W} height={H} className="block">
          {bands.map((b, i) => { const ch = chapters.find((c) => c.id === b.ch); const m = /SC-\d+/.exec(ch?.title || ''); const label = m ? m[0] : ch?.title || ''; return <g key={i}><rect x={b.x} y={0} width={b.w} height={H} fill={i % 2 ? 'rgba(255,255,255,0.025)' : 'transparent'} /><text x={b.x + 6} y={14} fontSize={10.5} fill="var(--ink-3)">{textW(label, 10.5) < b.w - 8 ? label : ''}</text></g>; })}
          {order.map((id, ri) => {
            const y = TOP + ri * RH + RH / 2;
            const a = reg.get(id);
            const cs = cols.map((c, ci) => ({ ci, it: c.items.filter((r) => r.agent_id === id) })).filter((x) => x.it.length);
            const x0 = NAMEW + cs[0].ci * CW + CW / 2;
            const gone = a?.status === 'retired';
            const xEnd = gone ? NAMEW + cs[cs.length - 1].ci * CW + CW / 2 : W - 10;
            return (
              <g key={id}>
                <line x1={x0} y1={y} x2={xEnd} y2={y} stroke={gone ? 'var(--line-2)' : a?.status === 'deprecated' ? 'var(--warn)' : 'var(--line-2)'} strokeWidth={gone ? 1 : 2} strokeDasharray={a?.status === 'deprecated' ? '4 4' : undefined} opacity={gone ? 0.6 : 1} />
                {cs.map(({ ci, it }) => {
                  const pick = it.filter((r) => r.from_version !== r.to_version).pop() || it[it.length - 1];
                  const x = NAMEW + ci * CW + CW / 2;
                  const tip = it.map((r) => `${id} ${r.from_version || '—'} → ${r.to_version} · ${VKIND[r.kind] || r.kind} ${r.ref || ''} · ${String(r.ts).slice(0, 16)}\n${r.note || ''}`).join('\n\n');
                  const c = EV_C[pick.kind] || EV_C.baseline;
                  if (pick.from_version !== pick.to_version) { const w = textW(pick.to_version, 11) + 14; return <g key={ci} transform={`translate(${x},${y})`}><title>{tip}</title><rect x={-w / 2} y={-9} width={w} height={18} rx={9} fill={c} /><text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fontFamily="JetBrains Mono, monospace" fill={pick.kind === 'baseline' || pick.kind === 'retire' ? '#fff' : '#0b1116'}>{pick.to_version}</text></g>; }
                  if (pick.kind === 'retire') return <g key={ci} transform={`translate(${x},${y})`}><title>{tip}</title><path d="M-5 -5L5 5M5 -5L-5 5" stroke="#9aa6b2" strokeWidth={2} /></g>;
                  return <g key={ci} transform={`translate(${x},${y})`}><title>{tip}</title><rect x={-5} y={-5} width={10} height={10} rx={2} fill={c} transform="rotate(45)" /></g>;
                })}
              </g>
            );
          })}
        </svg>
        </div>
      </div>
    </div>
  );
}
