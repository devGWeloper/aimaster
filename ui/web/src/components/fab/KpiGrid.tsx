// KPI — 기획서 정량 목표를 저장소·하네스 기록에서 직접 계산 (eval/kpi.py). 루프는 이 계산에 접근할 수 없다.
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { cn } from '@/lib/utils';

const KPI_NAME: Record<string, string> = {
  prep_time: 'Qual 준비·판정 소요시간', judge_accuracy: 'AutoQual 판정 정확도', grow_success: 'Agent 자동 생성 성공률', self_heal: '오류 자가 복구율', mttr: '평균 복구 시간(MTTR)',
  structure: '진화 후 구조 개선(코드 중복)', latency: '진화 후 응답시간', replay_effect: '이력 리플레이 진화 효과', future_leak: '미래 정보 누출', first_pass: 'Qual 1차 Pass율',
  override: '엔지니어 Override율', calls: 'Agent 호출 효율', retire: '불필요 Agent 정리', degradation: '진화 퇴화', loop_runaway: '루프 폭주', unapproved: '무승인 장비 상태 변경',
};

export default function KpiGrid() {
  const seq = useApp((s) => s.snap?.last_seq);
  const [k, setK] = useState<Record<string, any> | null>(null);
  const load = (fresh = false) => api(`/api/kpi${fresh ? '?fresh=1' : ''}`).then(setK).catch(() => setK(null));
  useEffect(() => { load(); }, [seq]);
  const keys = Object.keys(KPI_NAME).filter((x) => k?.[x]);
  const ok = keys.filter((x) => k![x].ok).length;
  return (
    <section className="panel">
      <div className="panel-h"><h2>KPI</h2><span className="d">기획서 정량 목표 vs 실측 · 저장소·하네스 기록에서 직접 계산 (eval/kpi.py) · 루프는 이 계산에 접근할 수 없습니다</span>
        <span className="ml-auto font-mono text-[12px]"><b className="text-ok">{ok}</b> / {keys.length} 달성</span>
        <button type="button" onClick={() => load(true)} className="rounded-md border border-line p-1 text-ink-3 hover:text-ink" aria-label="다시 계산"><RefreshCw className="size-3.5" /></button></div>
      {!k ? <div className="px-4 pb-6 text-[12px] text-ink-3">계산 중 …</div> : keys.length === 0 ? <div className="px-4 pb-6 text-[12.5px] text-ink-3">Autopilot이 진행되면 측정 가능한 KPI부터 채워집니다.</div> : (
        <div className="grid grid-cols-4 gap-2 px-4 pb-4">
          {keys.map((key) => { const x = k[key]; const tgt = x.lower_better ? `목표 ${x.target}${String(x.unit).replace(/^%.*/, '%').split(' ')[0]} 이하` : `목표 ${x.target}${String(x.unit).split(' ')[0]} 이상`; return (
            <div key={key} className={cn('rounded-lg border bg-panel-2 px-3 py-2.5', x.ok ? 'border-ok/40' : x.ok === false ? 'border-warn/40' : 'border-line')}>
              <div className="flex items-start justify-between gap-2 text-[11.5px]"><span className="text-ink-2">{KPI_NAME[key]}</span><span className={cn('flex-none font-semibold', x.ok ? 'text-ok' : x.ok === false ? 'text-warn' : 'text-ink-3')}>{x.ok ? '달성' : x.ok === false ? '미달' : '-'}</span></div>
              <div className="mt-1 flex items-baseline gap-1.5"><b className="font-mono text-[22px] font-extrabold tracking-tight">{fmtNum(x.value, 1)}</b><span className="text-[11.5px] text-ink-3">{x.unit}</span></div>
              <div className="text-[10.5px] text-ink-3">{tgt}</div>
              <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-2" title={x.detail}>{x.detail}</div>
            </div>); })}
        </div>
      )}
    </section>
  );
}
