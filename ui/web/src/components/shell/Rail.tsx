// 좌측 레일 — 시연(기본) · 라이브 · 루프 · 진화가 위, 조회 셋(Agent · 승인 · Fab)이 아래.
import { Activity, Dna, Factory, Orbit, Presentation, ShieldCheck, Users } from 'lucide-react';
import { useApp, type View } from '@/store/store';
import { cn } from '@/lib/utils';
import { beaconView, useLoopActivity } from './LoopBeacon';

const ITEMS: { id: View; label: string; icon: React.ComponentType<{ className?: string }>; title: string }[] = [
  { id: 'demo', label: '시연', icon: Presentation, title: '시연: 질문 하나로 기능이 추가·복구·보정·정리되는 과정을 단계별로' },
  { id: 'live', label: '라이브', icon: Activity, title: '지금 Agent가 하는 일: 자막 · 편성 맵 · 대화' },
  { id: 'loop', label: '루프', icon: Orbit, title: 'Loop Engineering: L1 Task · L2 Heal/Grow · L3 Evolve 3중 루프와 실행 트레이스' },
  { id: 'evolve', label: '진화', icon: Dna, title: 'Self-Evolving: 감지 → 변이 → 하네스 평가 → 선택 → 반영, 5계층 · Genome 계보 · 리플레이' },
  { id: 'agents', label: 'Agent', icon: Users, title: 'Agent Registry: Genome 코드 · 버전 · Lineage · 테스트 · 아카이브' },
  { id: 'approvals', label: '승인', icon: ShieldCheck, title: '사람 승인: 장비 Up · 승격 · 진화안 · 폐기' },
  { id: 'fab', label: 'Fab', icon: Factory, title: 'Fab·업무: AutoQual 단계 · 챔버 현황 · 처리 이력 · KPI' },
];

export default function Rail() {
  const view = useApp((s) => s.view);
  const go = useApp((s) => s.go);
  const pending = useApp((s) => (s.snap?.approvals || []).length);
  const act = useLoopActivity();
  const hotView = beaconView(act);   // L2 → 루프, L3 → 진화 (L3는 루프에도 점)
  const hotC = act?.lane === 'L3' ? 'lane-l3 bg-l3' : 'lane-l2 bg-l2';
  return (
    <aside className="row-start-3 flex flex-col gap-1 border-r border-line bg-panel px-1.5 py-2.5">
      {ITEMS.map((it, i) => (
        <button key={it.id} type="button" title={it.title} onClick={() => go(it.id)}
          className={cn('relative flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-[11px] text-ink-3 hover:bg-panel-2 hover:text-ink', view === it.id && 'bg-panel-2 text-ink', i === 4 && 'mt-3 border-t border-line pt-4')}>
          {view === it.id && <i className="absolute -left-1.5 top-2.5 bottom-2.5 w-[3px] rounded bg-l1" />}
          <it.icon className="size-[19px]" />
          <span>{it.label}</span>
          {act && view !== it.id && (it.id === hotView || (it.id === 'loop' && hotView === 'evolve')) && <b title="지금 이 화면에서 루프가 움직이고 있습니다" className={cn('beat absolute right-2 top-1.5 size-2.5 rounded-full', hotC)} />}
          {it.id === 'approvals' && pending > 0 && <b className="absolute right-1.5 top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-gate px-1 text-[10.5px] text-[#2a1a00]">{pending}</b>}
        </button>
      ))}
    </aside>
  );
}
