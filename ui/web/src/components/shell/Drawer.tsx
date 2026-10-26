// 드로어 — Agent Genome(코드·버전·Lineage·테스트) / 리포트 전문 / 아카이브 후보
import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import AgentDetail from '@/components/agents/AgentDetail';
import ReportDetail from '@/components/evolve/ReportDetail';
import CodeView from '@/components/common/CodeView';
import { Line } from '@/components/common/Section';

export default function Drawer() {
  const drawer = useApp((s) => s.drawer);
  const close = useApp((s) => s.closeDrawer);
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    setData(null);
    if (!drawer) return;
    const path = drawer.kind === 'agent' ? `/api/genome/${drawer.id}` : drawer.kind === 'report' ? `/api/report/${drawer.id}` : `/api/archive/${drawer.id}`;
    api(path).then(setData).catch(() => setData({ error: true }));
  }, [drawer]);
  return (
    <Sheet open={!!drawer} onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent side="right" className="w-[min(960px,92vw)] sm:max-w-none overflow-auto bg-panel p-0">
        <SheetHeader className="border-b border-line px-6 py-4">
          <SheetTitle className="text-[16px]">{drawer?.kind === 'agent' ? `Agent Genome · ${drawer.id}` : drawer?.kind === 'report' ? data?.title || '리포트' : data?.meta?.title || drawer?.id || ''}</SheetTitle>
          <SheetDescription>{drawer?.kind === 'agent' ? '코드 · 프롬프트 · 도구 · 테스트 · 버전 · Lineage를 묶은 Genome' : drawer?.kind === 'report' ? `${data?.report_id || ''} · ${data?.ts || ''}` : '진화 아카이브 후보'}</SheetDescription>
        </SheetHeader>
        <div className="px-6 py-4">
          {!data && <div className="text-ink-3">불러오는 중 …</div>}
          {data?.error && <div className="text-bad">불러오지 못했습니다.</div>}
          {data && !data.error && drawer?.kind === 'agent' && <AgentDetail d={data} agentId={drawer.id} onVersion={(v) => api(`/api/genome/${drawer.id}?version=${encodeURIComponent(v)}`).then(setData)} />}
          {data && !data.error && drawer?.kind === 'report' && <ReportDetail r={data} />}
          {data && !data.error && drawer?.kind === 'archive' && (
            <div className="space-y-3">
              <dl className="kv text-[12.5px]"><dt>결정</dt><dd>{data.decision}</dd><dt>사유</dt><dd>{data.reason}</dd><dt>계층</dt><dd>{data.layer}</dd><dt>점수</dt><dd className="font-mono">{JSON.stringify(data.scores)}</dd><dt>리포트</dt><dd>{data.report_id}</dd></dl>
              {(data.meta?.lessons || []).map((x: string, i: number) => <Line key={i}>{x}</Line>)}
              {data.code && <CodeView code={data.code} diff={/^[+-]/m.test(data.code)} maxHeight={9999} />}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
