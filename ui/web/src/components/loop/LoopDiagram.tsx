// 3중 루프 다이어그램 — L3 Evolve(위) · L1 Task(가운데) · L2 Grow/Heal(아래). 트랙 윗변 = 진행, 아랫변 = 되돌아가는 길.
//   토큰(빛나는 점)이 실제 이벤트 노드를 따라 이동하고, 루프 사이의 길(막히면 L2로, 경험은 L3로, 새 버전은 L1로)이 번쩍인다.
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/store/store';
import { LANE_SLOTS, laneOf, NODE_SLOT, runOf } from '@/store/live';
import { hub } from '@/lib/hub';
import type { AnyEv, Lane } from '@/lib/types';
import { cn } from '@/lib/utils';

const VB = { w: 1000, h: 410 };
interface LaneGeo { c: string; x0: number; x1: number; top: number; h: number; below?: boolean; name: string; sub: string; back: string; backX?: number; r: number; a: number; b: number; yT: number; yB: number; total: number; backLen: number; d: string; pw: number; pos: Record<string, { x: number; len: number; label: string; kind?: string }> }
const RAW: Record<Lane, Omit<LaneGeo, 'r' | 'a' | 'b' | 'yT' | 'yB' | 'total' | 'backLen' | 'd' | 'pw' | 'pos'>> = {
  L3: { c: 'l3', x0: 30, x1: 970, top: 54, h: 50, name: 'L3 Evolve', sub: '쌓인 경험으로 Agent 자체를 바꾸는 바깥 루프 · 야간·분기', back: '↺ 다음 진화 주기 — 기각안은 아카이브에서 재출발' },
  L1: { c: 'l1', x0: 30, x1: 970, top: 186, h: 58, name: 'L1 Task', sub: '요청 1건을 처리하는 루프 · 종료: 목표 충족 / 재계획 3회', back: '↺ 경험 기록 → 다음 요청이 꺼내 씀', backX: 190 },
  GROW: { c: 'l2', x0: 30, x1: 486, top: 322, h: 50, below: true, name: 'L2 Grow', sub: '처음 보는 요청 → 새 Agent를 만든다', back: '↺ 테스트 실패 → 다시 생성 (예산 5회·15분)' },
  HEAL: { c: 'l2', x0: 514, x1: 970, top: 322, h: 50, below: true, name: 'L2 Heal', sub: '실행 오류 → 자기 코드를 고친다', back: '↺ 실패 패치는 블랙리스트 후 재시도 (예산 5회·15분)' },
};
export const LANES: Record<Lane, LaneGeo> = {} as never;
for (const [k, L0] of Object.entries(RAW) as [Lane, typeof RAW.L1][]) {
  const slots = LANE_SLOTS[k];
  const r = L0.h / 2, a = L0.x0 + r, b = L0.x1 - r, pad = 14;
  const step = (b - a - 2 * pad) / (slots.length - 1);
  const pos: LaneGeo['pos'] = {};
  slots.forEach((s, i) => { const x = a + pad + i * step; pos[s.key] = { x, len: x - a, label: s.label, kind: s.kind }; });
  const L: LaneGeo = { ...L0, r, a, b, yT: L0.top, yB: L0.top + L0.h, total: 2 * (b - a) + 2 * Math.PI * r, backLen: (b - a) + Math.PI * r + (b - (L0.backX || (a + b) / 2)), d: `M ${a} ${L0.top} H ${b} A ${r} ${r} 0 0 1 ${b} ${L0.top + L0.h} H ${a} A ${r} ${r} 0 0 1 ${a} ${L0.top} Z`, pw: Math.min(step - 8, 118), pos };
  LANES[k] = L;
}
const P = (lane: Lane, k: string) => LANES[lane].pos[k].x;
const vcurve = (x1: number, y1: number, x2: number, y2: number) => { const k = (y2 - y1) * 0.55; return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`; };
const LINKS: Record<string, { d: string; label: string; c: string; side?: 'l' | 'r' }> = {
  'l1-grow': { d: vcurve(P('L1', 'route'), LANES.L1.yB, P('GROW', 'search'), LANES.GROW.yT - 16), label: '처리 불가 → Grow', c: 'l2' },
  'grow-l1': { d: vcurve(P('GROW', 'reg'), LANES.GROW.yT - 16, P('L1', 'plan'), LANES.L1.yB), label: '새 Agent 투입', c: 'l2' },
  'l1-heal': { d: vcurve(P('L1', 'obs'), LANES.L1.yB, P('HEAL', 'cls'), LANES.HEAL.yT - 16), label: '확인 불가 → Heal', c: 'l2' },
  'heal-l1': { d: vcurve(P('HEAL', 'reg'), LANES.HEAL.yT - 16, P('L1', 'resp'), LANES.L1.yB), label: '복구 후 재응답', c: 'l2' },
  'l1-l3': { d: `M 30 ${LANES.L1.yT + LANES.L1.r} C 4 ${LANES.L1.yT}, 4 ${LANES.L3.yB}, 30 ${LANES.L3.yT + LANES.L3.r}`, label: '경험 → 진화 재료', c: 'l3', side: 'l' },
  'l3-l1': { d: `M 970 ${LANES.L3.yT + LANES.L3.r} C 996 ${LANES.L3.yB}, 996 ${LANES.L1.yT}, 970 ${LANES.L1.yT + LANES.L1.r}`, label: '새 버전 배포', c: 'l3', side: 'r' },
};
function textW(t: string, size: number, bold = false) { let w = 0; for (const ch of t) w += /[ㄱ-힝]/.test(ch) ? size * 0.92 : /[A-Z0-9]/.test(ch) ? size * 0.64 : size * 0.52; return w * (bold ? 1.06 : 1); }

export default function LoopDiagram({ className }: { className?: string }) {
  const lanes = useApp((s) => s.live.lanes);
  const budgets = useApp((s) => s.live.budgets);
  const speed = useApp((s) => s.snap?.speed ?? 1);
  const tokRef = useRef<Record<string, SVGGElement | null>>({});
  const trackRef = useRef<Record<string, SVGPathElement | null>>({});
  const lenRef = useRef<Record<string, number>>({ L1: 0, L3: 0, HEAL: 0, GROW: 0 });
  const animRef = useRef<Record<string, number>>({});
  const [hot, setHot] = useState<Record<string, number>>({});
  const [sparks, setSparks] = useState<{ id: number; link: string }[]>([]);
  const sid = useRef(0);

  // 토큰 이동 (트랙 길이 따라 보간)
  const move = (lane: Lane, target: number, instant: boolean) => {
    const L = LANES[lane], tok = tokRef.current[lane], trk = trackRef.current[lane];
    if (!tok || !trk) return;
    cancelAnimationFrame(animRef.current[lane]);
    tok.style.opacity = '1';
    const from = lenRef.current[lane];
    let to = target;
    if (to < from - 0.5) to += L.total;
    const v = Number(speed);
    const d = v ? Math.min(1500, 380 + (to - from) * 0.9) / Math.max(0.5, v) : 0;
    const place = (len: number) => { const pt = trk.getPointAtLength(((len % L.total) + L.total) % L.total); tok.setAttribute('transform', `translate(${pt.x},${pt.y})`); };
    if (instant || !d || to === from) { lenRef.current[lane] = target; place(target); return; }
    const t0 = performance.now();
    const step = (now: number) => { const k = Math.min(1, (now - t0) / d); const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2; place(from + (to - from) * e); if (k < 1) animRef.current[lane] = requestAnimationFrame(step); };
    lenRef.current[lane] = target;
    animRef.current[lane] = requestAnimationFrame(step);
  };
  useEffect(() => {
    // 스토어 상태로 초기 위치 복원
    for (const k of Object.keys(LANES) as Lane[]) { const S = lanes[k]; if (S.cur && LANES[k].pos[S.cur]) move(k, LANES[k].pos[S.cur].len, true); else if (S.backHot) move(k, LANES[k].backLen, true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const spark = (link: string) => { const id = ++sid.current; setSparks((s) => [...s.slice(-6), { id, link }]); setTimeout(() => setSparks((s) => s.filter((x) => x.id !== id)), 2600); };
    const wake = (lane: string) => setHot((h) => ({ ...h, [lane]: Date.now() }));
    const off = [
      hub.on('node', (ev: AnyEv) => {
        const lane = laneOf(ev); if (!lane) return;
        const slot = NODE_SLOT[lane][ev.node]; if (!slot) return;
        const L = LANES[lane];
        const run = runOf(ev);
        const first = run && useApp.getState().live.lanes[lane].run === run && useApp.getState().live.lanes[lane].visited.length <= 1;
        if (first) { if (lane === 'HEAL') spark('l1-heal'); if (lane === 'GROW') spark('l1-grow'); }
        move(lane, slot === '@back' ? L.backLen : slot === '@stop' ? lenRef.current[lane] : L.pos[slot].len, false);
        if (ev.node === 'reanswer_pending') spark('heal-l1');
        if (ev.node === 'register_probation') spark('grow-l1');
        if (ev.node === 'log_experience') spark('l1-l3');
        wake(lane);
      }),
      hub.on('request', (ev: AnyEv) => { if (ev.source !== 'sim') { move('L1', LANES.L1.pos.q.len, false); wake('L1'); } }),
      hub.on('replay_case', () => { move('L1', LANES.L1.pos.q.len, false); wake('L1'); }),
      hub.on('version', (ev: AnyEv) => { if (['evolve', 'compose', 'rollback', 'promote', 'restore'].includes(ev.kind)) { move('L3', LANES.L3.pos.promote.len, false); spark('l3-l1'); wake('L3'); } }),
      hub.on('candidate', () => { move('L3', LANES.L3.pos.eval.len, false); wake('L3'); }),
      hub.on('registry', (ev: AnyEv) => { if (ev.event === 'shadow') move('L3', LANES.L3.pos.shadow.len, false); if (ev.event === 'deprecate') move('L3', LANES.L3.pos.select.len, false); if (ev.event === 'retire') move('L3', LANES.L3.pos.archive.len, false); }),
      hub.on('approval', (ev: AnyEv) => { const L1k = ev.kind === 'state_change'; move(L1k ? 'L1' : 'L3', L1k ? LANES.L1.pos.gate.len : LANES.L3.pos.select.len, false); wake(L1k ? 'L1' : 'L3'); }),
      hub.on('ops_batch', () => wake('L1')), hub.on('replay_progress', () => wake('L3')),
    ];
    return () => off.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className={cn('h-full w-full', className)} role="img" aria-label="3중 루프: L3 Evolve, L1 Task, L2 Grow·Heal">
      <defs>{['l1', 'l2', 'l3'].map((c) => <marker key={c} id={`fa-${c}`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill={`var(--${c})`} opacity={0.8} /></marker>)}</defs>
      {/* 루프 사이 길 */}
      {Object.entries(LINKS).map(([id, L]) => {
        const on = sparks.some((s) => s.link === id);
        const m = /M ([\d.]+) ([\d.]+) C .* ([\d.]+) ([\d.]+)$/.exec(L.d);
        const mx = m ? (Number(m[1]) + Number(m[3])) / 2 : 0, my = m ? (Number(m[2]) + Number(m[4])) / 2 : 0;
        const w = textW(L.label, 10.5) + 12;
        return (
          <g key={id} className={on ? 'opacity-100' : 'opacity-70'}>
            <path d={L.d} fill="none" stroke={`var(--${L.c})`} strokeOpacity={on ? 0.9 : 0.35} strokeWidth={on ? 2.2 : 1.4} strokeDasharray={on ? undefined : '5 5'} markerEnd={`url(#fa-${L.c})`} />
            {on && sparks.filter((s) => s.link === id).map((s) => <circle key={s.id} r={5} fill={`var(--${L.c})`} style={{ filter: 'drop-shadow(0 0 6px currentColor)' }}><animateMotion dur="0.9s" path={L.d} fill="freeze" /></circle>)}
            {L.side ? (
              <text x={L.side === 'l' ? 11 : 989} y={(LANES.L3.yB + LANES.L1.yT) / 2} textAnchor="middle" fontSize={10.5} fill="var(--ink-3)" transform={`rotate(${L.side === 'l' ? -90 : 90} ${L.side === 'l' ? 11 : 989} ${(LANES.L3.yB + LANES.L1.yT) / 2})`}>{L.label}</text>
            ) : (
              <g><rect x={mx - w / 2} y={my - 9} width={w} height={18} rx={9} fill="var(--panel)" stroke={`var(--${L.c})`} strokeOpacity={on ? 0.8 : 0.35} /><text x={mx} y={my + 3.6} textAnchor="middle" fontSize={10.5} fill={on ? 'var(--ink)' : 'var(--ink-2)'}>{L.label}</text></g>
            )}
          </g>
        );
      })}
      {/* 레인 */}
      {(Object.entries(LANES) as [Lane, LaneGeo][]).map(([key, L]) => {
        const S = lanes[key];
        const on = hot[key] && Date.now() - hot[key] < 9000;
        const hy = L.below ? L.yB + 34 : L.yT - 30;
        const bx = L.backX || (L.a + L.b) / 2, bw = textW(L.back, 10.5) + 16;
        const recent = Date.now() / 1000 - S.at < 240;
        const b = recent && (key === 'HEAL' || key === 'GROW') ? Object.values(budgets).find((x) => (key === 'HEAL' ? x.heal_id : x.grow_id) && S.run === (x.heal_id || x.grow_id)) : null;
        return (
          <g key={key} style={{ ['--c' as string]: `var(--${L.c})` }}>
            <text x={L.x0 + 4} y={hy} fontSize={13} fontWeight={800} fill="var(--c)">{L.name}</text>
            {!b && <text x={L.x0 + 4 + textW(L.name, 13, true) + 10} y={hy} fontSize={11} fill="var(--ink-3)">{L.sub}</text>}
            {b ? (
              <g transform={`translate(${L.x1 - 4},${hy})`}>
                <text x={-228} y={0} fontSize={10.5} textAnchor="end" fill="var(--ink)" fontFamily="JetBrains Mono, monospace">{(b.heal_id || b.grow_id)}{S.stopped ? ' 중단' : ''}</text>
                <text x={-218} y={0} fontSize={10} fill="var(--ink-3)">예산 시도</text>
                <rect x={-168} y={-7} width={60} height={7} rx={3.5} fill="var(--raise)" /><rect x={-168} y={-7} width={60 * Math.min(1, b.attempts / Math.max(1, b.max_attempts))} height={7} rx={3.5} fill={b.attempts / b.max_attempts >= 0.8 ? 'var(--bad)' : 'var(--c)'} />
                <text x={-104} y={0} fontSize={10} fill="var(--ink-2)" fontFamily="JetBrains Mono, monospace">{b.attempts}/{b.max_attempts}</text>
                <text x={-76} y={0} fontSize={10} fill="var(--ink-3)">시간</text>
                <rect x={-52} y={-7} width={30} height={7} rx={3.5} fill="var(--raise)" /><rect x={-52} y={-7} width={30 * Math.min(1, b.minutes / Math.max(1, b.max_minutes))} height={7} rx={3.5} fill="var(--c)" />
                <text x={0} y={0} fontSize={10} textAnchor="end" fill="var(--ink-2)" fontFamily="JetBrains Mono, monospace">{Number(b.minutes).toFixed(1)}/{b.max_minutes}분</text>
              </g>
            ) : <text x={L.x1 - 4} y={hy} fontSize={11} textAnchor="end" fill={S.status === '대기' ? 'var(--ink-3)' : 'var(--ink)'} fontFamily="JetBrains Mono, monospace">{S.status}</text>}
            <path d={L.d} fill="none" stroke="var(--line-2)" strokeWidth={on ? 2.4 : 1.6} />
            {on && <path d={L.d} fill="none" stroke="var(--c)" strokeOpacity={0.55} strokeWidth={2} className="dash-run" />}
            <g opacity={S.backHot ? 1 : 0.55}><rect x={bx - bw / 2} y={L.yB - 9} width={bw} height={18} rx={9} fill="var(--panel)" stroke={S.backHot ? 'var(--c)' : 'var(--line-2)'} /><text x={bx} y={L.yB + 3.6} textAnchor="middle" fontSize={10.5} fill={S.backHot ? 'var(--ink)' : 'var(--ink-3)'}>{L.back}</text></g>
            <g ref={(el) => { tokRef.current[key] = el; }} style={{ opacity: 0, transition: 'opacity .3s' }}><circle r={15} fill="var(--c)" opacity={0.22} className="glow" /><circle r={8} fill="var(--c)" style={{ filter: 'drop-shadow(0 0 10px var(--c))' }} /><circle r={3} fill="#fff" /></g>
            <path ref={(el) => { trackRef.current[key] = el; }} d={L.d} fill="none" stroke="none" />
            {Object.entries(L.pos).map(([k, p]) => {
              const cur = S.cur === k, vis = S.visited.includes(k), wait = S.wait === k, stop = S.stopped && cur, bad = S.bad && cur;
              const fill = stop || bad ? 'var(--bad)' : wait ? 'var(--gate)' : cur ? 'var(--c)' : vis ? 'color-mix(in oklab, var(--c) 28%, var(--panel))' : 'var(--panel)';
              const stroke = stop || bad ? 'var(--bad)' : wait ? 'var(--gate)' : cur || vis ? 'var(--c)' : 'var(--line-2)';
              return (
                <g key={k} transform={`translate(${p.x - L.pw / 2},${L.yT - 16})`}>
                  <title>{p.label}</title>
                  <rect width={L.pw} height={32} rx={16} fill={fill} stroke={stroke} strokeWidth={cur ? 2 : 1.2} className={cn(wait && 'glow')} />
                  <text x={L.pw / 2} y={20.5} textAnchor="middle" fontSize={11.5} fontWeight={cur ? 800 : 600} fill={cur || stop || wait ? (wait ? '#2a1a00' : stop || bad ? '#fff' : '#06221f') : vis ? 'var(--ink)' : 'var(--ink-2)'}>{p.label}</text>
                  {p.kind === 'ca' && <circle cx={L.pw - 9} cy={1} r={4} fill="var(--l1)" />}
                  {p.kind === 'det' && <rect x={L.pw - 13} y={-3} width={8} height={8} rx={1.5} fill="var(--ok)" />}
                  {p.kind === 'gate' && <rect x={L.pw - 13} y={-3} width={8} height={8} rx={1.5} fill="var(--gate)" transform={`rotate(45 ${L.pw - 9} 1)`} />}
                  {p.kind === 'jev' && <circle cx={L.pw - 9} cy={1} r={4} fill="var(--jev)" />}
                </g>
              );
            })}
            {S.bubble && S.cur && (() => { const max = key === 'L1' || key === 'L3' ? 72 : 40; const str = S.bubble.length > max ? `${S.bubble.slice(0, max - 1)}…` : S.bubble; const w = textW(str, 11) + 14; const cx = L.pos[S.cur]?.x || bx; const x = Math.max(L.a - L.r + 6, Math.min(L.b + L.r - 6 - w, cx - w / 2)); const y = L.yT + (L.h >= 58 ? 24 : 21); return (
              <g><rect x={x} y={y} width={w} height={17} rx={4} fill={S.bad ? 'color-mix(in oklab, var(--bad) 30%, var(--panel))' : 'var(--panel-2)'} stroke={S.bad ? 'var(--bad)' : 'var(--line-2)'} /><text x={x + 7} y={y + 12.4} fontSize={11} fill="var(--ink)">{str}</text></g>); })()}
          </g>
        );
      })}
    </svg>
  );
}
