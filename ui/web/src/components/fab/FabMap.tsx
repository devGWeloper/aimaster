// Fab 현황 — 장비 30대 × 챔버 3개. 색 = 상태(생산 · Down(PM) · Qual 진행 · Up 승인 대기)
import { useApp } from '@/store/store';
import { cn } from '@/lib/utils';

const STATE_KO: Record<string, string> = { RUN: '생산', DOWN: 'Down (PM)', QUAL: 'Qual 진행', APPROVAL: 'Up 승인 대기' };
const C: Record<string, string> = { RUN: 'bg-[#2a3a46] text-ink-3', DOWN: 'bg-bad/80 text-white', QUAL: 'bg-l1 text-[#06221f] glow', APPROVAL: 'bg-gate text-[#2a1a00] glow' };
const MODEL = (e: string) => (e.startsWith('ETCH') ? (Number(e.slice(5)) <= 8 ? 'ETX-300' : 'ETX-500') : e.startsWith('CVD') ? 'CVX-200' : 'PVX-100');

export default function FabMap() {
  const fab = useApp((s) => s.biz.fab);
  const focus = useApp((s) => (s.biz.focus ? s.biz.quals[s.biz.focus]?.en?.chamber_id : null));
  const rows = Object.values(fab);
  const by = new Map<string, typeof rows>();
  for (const c of rows) { const eqp = c.chamber_id.slice(0, c.chamber_id.lastIndexOf('-')); if (!by.has(eqp)) by.set(eqp, []); by.get(eqp)!.push(c); }
  const cnt: Record<string, number> = { RUN: 0, DOWN: 0, QUAL: 0, APPROVAL: 0 };
  for (const c of rows) cnt[c.state] = (cnt[c.state] || 0) + 1;
  const groups = ['ETCH', 'CVD', 'PVD'];
  return (
    <section className="panel flex flex-col">
      <div className="panel-h"><h2>Fab 현황</h2><span className="d">장비 30대 · 챔버 90개</span>
        <div className="ml-auto flex gap-2 text-[11px]">{Object.entries(STATE_KO).map(([k, v]) => <span key={k} className="flex items-center gap-1 text-ink-3"><i className={cn('size-2.5 rounded-sm', C[k].split(' ')[0])} />{v} <b className="font-mono text-ink">{cnt[k] || 0}</b></span>)}</div></div>
      <div className="grid flex-1 grid-cols-3 gap-3 px-4 pb-4">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 text-[11.5px] font-bold text-ink-2">{g}</div>
            <div className="space-y-1">
              {[...by.entries()].filter(([e]) => e.startsWith(g)).sort().map(([eqp, chs]) => (
                <div key={eqp} className="flex items-center gap-1.5" title={`${eqp} · ${MODEL(eqp)}`}>
                  <span className="w-[54px] font-mono text-[10.5px] text-ink-3">{eqp}</span>
                  <div className="flex flex-1 gap-1">
                    {chs.sort((a, b) => (a.chamber_id > b.chamber_id ? 1 : -1)).map((c) => (
                      <i key={c.chamber_id} title={`${c.chamber_id} ${STATE_KO[c.state] || c.state}\n${c.note || ''}\n${c.since || ''}`} className={cn('flex h-5 flex-1 items-center justify-center rounded-[4px] text-[10px] font-bold not-italic', C[c.state] || C.RUN, c.chamber_id === focus && 'ring-2 ring-white')}>{c.chamber_id.slice(-1)}</i>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
