// 진화 — Self-Evolving. 위: 진화 사이클(감지 → 변이 → 하네스 평가 → 선택·승인 → 반영·보관)과 지금 진행 중인 런 / 아래: 진화 사건 피드 + 계보·리플레이·5계층
import { useEffect, useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import type { LineageRow, Report } from '@/lib/types';
import EvolvePipeline from '@/components/evolve/EvolvePipeline';
import EventFeed from '@/components/evolve/EventFeed';
import Lineage from '@/components/evolve/Lineage';
import ReplayPanel from '@/components/evolve/ReplayPanel';
import LayerSummary from '@/components/evolve/LayerSummary';

export default function EvolvePage() {
  const reportsVersion = useApp((s) => s.evolve.reportsVersion);
  const lineageVersion = useApp((s) => s.evolve.lineageVersion);
  const [reports, setReports] = useState<Report[]>([]);
  const [lineage, setLineage] = useState<LineageRow[]>([]);
  useEffect(() => { api<Report[]>('/api/reports/full?limit=80').then(setReports).catch(() => setReports([])); }, [reportsVersion]);
  useEffect(() => { api<LineageRow[]>('/api/lineage').then(setLineage).catch(() => setLineage([])); }, [lineageVersion, reportsVersion]);
  const sorted = useMemo(() => [...reports].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)), [reports]);
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <EvolvePipeline reports={sorted} lineage={lineage} />
      <div className="grid min-h-0 grid-cols-[minmax(0,3fr)_minmax(380px,2fr)]">
        <section className="flex min-h-0 flex-col border-r border-line">
          <div className="flex items-baseline gap-2 px-5 pt-3 pb-2"><h2 className="text-[13.5px] font-bold">진화 사건</h2><span className="text-[11.5px] text-ink-3">Agent가 자기 자신을 바꾼 기록. 최근 순 · 펼치면 무엇을 감지해 어떤 후보를 만들고 어떻게 채점해 무엇을 반영했는지</span></div>
          <EventFeed reports={sorted} />
        </section>
        <section className="flex min-h-0 flex-col">
          <Tabs defaultValue="lineage" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="flex items-center gap-3 px-4 pt-3">
              <TabsList variant="line">
                <TabsTrigger value="lineage">Genome 계보</TabsTrigger>
                <TabsTrigger value="replay">이력 리플레이</TabsTrigger>
                <TabsTrigger value="layers">5계층 · 아카이브</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="lineage" className="min-h-0 flex-1 overflow-auto p-4"><Lineage rows={lineage} /></TabsContent>
            <TabsContent value="replay" className="min-h-0 flex-1 overflow-auto p-4"><ReplayPanel /></TabsContent>
            <TabsContent value="layers" className="min-h-0 flex-1 overflow-auto p-4"><LayerSummary reports={sorted} lineage={lineage} /></TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}
