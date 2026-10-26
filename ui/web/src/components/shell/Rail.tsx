// 좌측 레일 — 6개 화면. 핵심 셋(라이브 · 루프 · 진화)이 위, 조회 셋(Agent · 승인 · Fab)이 아래.
import { Activity, Dna, Factory, Orbit, ShieldCheck, Users } from 'lucide-react';
import { useApp, type View } from '@/store/store';
import { cn } from '@/lib/utils';

const ITEMS: { id: View; label: string; icon: React.ComponentType<{ className?: string }>; title: string }[] = [
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
  return (
    <aside className="row-start-3 flex flex-col gap-1 border-r border-line bg-panel px-1.5 py-2.5">
      {ITEMS.map((it, i) => (
        <button key={it.id} type="button" title={it.title} onClick={() => go(it.id)}
          className={cn('relative flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-[11px] text-ink-3 hover:bg-panel-2 hover:text-ink', view === it.id && 'bg-panel-2 text-ink', i === 3 && 'mt-3 border-t border-line pt-4')}>
          {view === it.id && <i className="absolute -left-1.5 top-2.5 bottom-2.5 w-[3px] rounded bg-l1" />}
          <it.icon className="size-[19px]" />
          <span>{it.label}</span>
          {it.id === 'approvals' && pending > 0 && <b className="absolute right-1.5 top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-gate px-1 text-[10.5px] text-[#2a1a00]">{pending}</b>}
        </button>
      ))}
    </aside>
  );
}
