// 진화 대상 5계층 — 계층별 채택 수와 설명, 아카이브 요약
import { useEffect, useState } from 'react';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import { LAYERS, layerNo } from '@/lib/ko';
import type { LineageRow, Report } from '@/lib/types';
import { Section, Empty } from '@/components/common/Section';
import { cn } from '@/lib/utils';

export default function LayerSummary({ reports, lineage }: { reports: Report[]; lineage: LineageRow[] }) {
  const open = useApp((s) => s.openDrawer);
  const [archive, setArchive] = useState<any[]>([]);
  const [f, setF] = useState<'all' | 'adopt' | 'reject' | 'hold' | 'retired'>('all');
  useEffect(() => { api('/api/archive').then(setArchive).catch(() => setArchive([])); }, [reports.length, lineage.length]);
  const cnt = [0, 0, 0, 0, 0];
  for (const r of reports) {
    const c = r.content || {};
    const k = r.kind === 'evolve' ? c.kind || 'quarter' : r.kind;
    for (const x of c.candidates || []) if (x.decision === 'adopt' && layerNo(x.layer) >= 0) cnt[layerNo(x.layer)] += 1;
    if (k === 'heal' && c.status === 'healed') cnt[2] += 1;
    if (k === 'grow' && c.ok) cnt[3] += 1;
    if (k === 'retire') cnt[3] += (c.items || []).filter((x: any) => x.decision === 'deprecated').length;
    if (k === 'orchestration' && c.change) cnt[4] += 1;
    if (k === 'structure' && (c.changes || []).length) cnt[1] += 1;
  }
  const counts = archive.reduce((m: Record<string, number>, r) => { m[r.decision] = (m[r.decision] || 0) + 1; return m; }, {});
  return (
    <div className="space-y-5">
      <Section title="진화 대상 5계층 · 채택된 변경 수">
        <div className="space-y-1.5">
          {LAYERS.map(([no, name, desc], i) => (
            <div key={no} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2', cnt[i] ? 'border-l3/50 bg-l3/8' : 'border-line bg-panel-2')}>
              <b className={cn('text-[18px]', cnt[i] ? 'text-l3' : 'text-ink-3')}>{no}</b>
              <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold">{name}</div><div className="truncate text-[11px] text-ink-3">{desc}</div></div>
              <em className={cn('font-mono text-[18px] font-bold not-italic', cnt[i] ? 'text-l3' : 'text-ink-3')}>{cnt[i]}</em>
            </div>
          ))}
        </div>
      </Section>
      <Section title={<span className="flex items-center gap-2">진화 아카이브 · {archive.length}건 <span className="font-normal text-ink-3">채택·기각·보류·폐기 후보를 점수·사유와 함께 보관. 기각 후보는 다음 진화의 출발점, 폐기 Genome은 복원 가능</span></span>}>
        <div className="mb-2 inline-flex overflow-hidden rounded-lg border border-line-2">
          {([['all', `전체 ${archive.length}`], ['adopt', `채택 ${counts.adopt || 0}`], ['reject', `기각 ${counts.reject || 0}`], ['hold', `보류 ${counts.hold || 0}`], ['retired', `폐기 Genome ${counts.retired || 0}`]] as const).map(([k, t]) => <button key={k} type="button" onClick={() => setF(k)} className={cn('h-7 px-2.5 text-[11.5px] text-ink-2 hover:text-ink', f === k && 'bg-raise font-semibold text-ink')}>{t}</button>)}
        </div>
        {archive.length ? (
          <div className="max-h-[420px] space-y-1 overflow-auto">
            {archive.filter((r) => f === 'all' || r.decision === f).map((r) => (
              <button key={r.archive_id} type="button" onClick={() => open('archive', r.archive_id)} className="flex w-full flex-col gap-0.5 rounded-lg border border-line bg-panel-2 px-3 py-2 text-left hover:border-l3/50">
                <div className="flex items-center gap-2"><span className={cn('st', r.decision === 'adopt' ? 'lane-ok' : r.decision === 'hold' ? 'lane-warn' : r.decision === 'retired' ? 'lane-ink' : 'lane-ink')}><i />{({ adopt: '채택', reject: '기각', hold: '보류', retired: '폐기' } as Record<string, string>)[r.decision]}</span><span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{r.meta?.title || r.candidate_id}</span><span className="font-mono text-[10.5px] text-ink-3">{String(r.ts).slice(0, 10)}</span></div>
                <div className="truncate text-[11.5px] text-ink-3">{r.archive_id} · {r.layer} · {r.report_id} · {r.reason}</div>
              </button>
            ))}
          </div>
        ) : <Empty>아직 아카이브가 없습니다.</Empty>}
      </Section>
    </div>
  );
}
