// Fab·업무 — AutoQual이 무엇인지 10초 안에 읽히도록: 현재 건의 단계(PM → 절차 → 추천 → 측정 → 판정 → 승인 → UP) · Fab 90챔버 · 처리 이력 · KPI
import { useEffect, useState } from 'react';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import QualFlow from '@/components/fab/QualFlow';
import FabMap from '@/components/fab/FabMap';
import CaseHistory from '@/components/fab/CaseHistory';
import KpiGrid from '@/components/fab/KpiGrid';

export default function FabPage() {
  const reload = useApp((s) => s.biz.reloadCases);
  const loaded = useApp((s) => s.biz.casesLoaded);
  const setCases = useApp((s) => s.setCases);
  const [tab, setTab] = useState<'cases' | 'kpi'>('kpi');
  useEffect(() => { api('/api/autoqual/cases?limit=200').then(setCases).catch(() => { /* noop */ }); }, [reload, setCases]);
  void loaded;
  return (
    <div className="page space-y-4">
      <div className="page-h"><div><h1>Fab · AutoQual 업무</h1><p><b className="text-ink">AutoQual</b>이란 반도체 장비가 PM·부품 교체로 <span className="text-bad">Down</span>된 뒤, Qual 절차를 정하고 Seasoning 웨이퍼를 몇 매 흘릴지 추천하고, 측정값을 Spec으로 판정해 사람 승인 후 <span className="text-ok">UP</span>시키는 업무입니다. 이 판단·준비를 Agent가 엔지니어 대신 수행합니다.</p></div></div>
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] gap-4">
        <QualFlow />
        <FabMap />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setTab('kpi')} className={`h-8 rounded-lg px-3 text-[12.5px] ${tab === 'kpi' ? 'bg-raise font-semibold text-ink' : 'text-ink-2 hover:text-ink'}`}>KPI</button>
        <button type="button" onClick={() => setTab('cases')} className={`h-8 rounded-lg px-3 text-[12.5px] ${tab === 'cases' ? 'bg-raise font-semibold text-ink' : 'text-ink-2 hover:text-ink'}`}>Agent가 처리한 Qual 이력</button>
      </div>
      {tab === 'kpi' ? <KpiGrid /> : <CaseHistory />}
    </div>
  );
}
