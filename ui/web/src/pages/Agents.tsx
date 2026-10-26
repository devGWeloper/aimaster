// Agent — Registry 카드 그리드(클릭 → Genome 드로어) · 생명주기 설명 · 공용 스킬
import { useApp } from '@/store/store';
import { AGENT_DESC, AGENT_KO, STATUS_KO, short } from '@/lib/ko';
import type { Agent } from '@/lib/types';
import { cn } from '@/lib/utils';

const EMPTY: Agent[] = [];
const ST_C: Record<string, string> = { active: 'l1', probation: 'l2', deprecated: 'warn', retired: 'ink', candidate: 'ink' };

export default function AgentsPage() {
  const agents = useApp((s) => s.snap?.registry.agents ?? EMPTY);
  const open = useApp((s) => s.openDrawer);
  const sup = agents.find((a) => a.agent_id === 'super_agent');
  const mains = agents.filter((a) => a.kind === 'agent' && a.agent_id !== 'super_agent');
  const skills = agents.filter((a) => a.kind === 'skill');
  const Card = ({ a, big }: { a: Agent; big?: boolean }) => (
    <button type="button" onClick={() => open('agent', a.agent_id)} className={cn(`lane-${ST_C[a.status] || 'ink'} flex flex-col gap-2 rounded-xl border bg-panel p-4 text-left transition-colors hover:bg-panel-2`, a.status === 'active' ? 'border-line' : 'border-dashed border-[var(--c)]', a.status === 'retired' && 'opacity-60', big && 'border-l1/60')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={cn('font-extrabold tracking-tight', big ? 'text-[18px]' : 'text-[15px]')}>{AGENT_KO[a.agent_id] || short(a.agent_id)}</div>
          <div className="font-mono text-[11px] text-ink-3">{a.agent_id}</div>
        </div>
        <span className="st"><i />{STATUS_KO[a.status] || a.status}</span>
      </div>
      <div className="text-[12px] text-ink-2">{AGENT_DESC[a.agent_id] || a.name_ko || ''}</div>
      <div className="mt-auto grid grid-cols-3 gap-2 text-[11px] text-ink-3">
        <div><div className="font-mono text-[14px] font-bold text-ink">{a.active_version || '-'}</div>운영 버전 · {a.versions.length}개</div>
        <div><div className="font-mono text-[14px] font-bold text-ink">{a.direct_calls}</div>직접 호출 · 간접 {a.indirect_calls}</div>
        <div><div className="font-mono text-[14px] font-bold text-ink">{a.lines}</div>코드 줄 · {a.origin}</div>
      </div>
      {(Object.keys(a.deps?.skills || {}).length > 0 || (a.deps?.agents || []).length > 0) && <div className="text-[11px] text-ink-3">의존: {Object.keys(a.deps?.skills || {}).map(short).join(', ')}{(a.deps?.agents || []).length ? ` → ${a.deps!.agents!.map(short).join(', ')}` : ''}</div>}
      {a.shadow_version ? <div className="text-[11px] text-l3">Shadow {a.shadow_version} 병행 중</div> : null}
      {a.status === 'deprecated' ? <div className="text-[11px] text-warn">유예 ~{String(a.grace_until || '').slice(0, 10)} · 호출은 {short(a.replacement || '-')}로 리다이렉트</div> : null}
    </button>
  );
  return (
    <div className="page">
      <div className="page-h"><div><h1>Agent Registry</h1><p>모든 Agent는 코드 · 프롬프트 · 도구 · 테스트 · 지표 · 버전을 묶은 Genome으로 관리됩니다. 생명주기: 시험 운영(probation) → 운영(active) → 폐기 유예(deprecated) → 폐기(retired, 아카이브 보관). 카드를 누르면 Genome 코드와 Lineage가 열립니다.</p></div>
        <div className="flex gap-3 text-[11.5px] text-ink-3">{Object.entries(ST_C).slice(0, 4).map(([k, c]) => <span key={k} className={`lane-${c} flex items-center gap-1`}><i className="size-2 rounded-full bg-[var(--c)]" />{STATUS_KO[k]} {agents.filter((a) => a.status === k).length}</span>)}</div></div>
      {sup && <div className="mb-4 grid grid-cols-[minmax(0,1fr)]"><Card a={sup} big /></div>}
      <h2 className="mb-2 text-[13px] font-bold text-ink-2">하위 Agent · {mains.length}</h2>
      <div className="mb-6 grid grid-cols-3 gap-3 xl:grid-cols-4">{mains.map((a) => <Card key={a.agent_id} a={a} />)}</div>
      <h2 className="mb-2 text-[13px] font-bold text-ink-2">공용 스킬 · {skills.length} <span className="font-normal text-ink-3">(성공한 CodeAct를 추출한 공용 함수. Agent Genome이 버전으로 의존)</span></h2>
      <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">{skills.map((a) => <Card key={a.agent_id} a={a} />)}</div>
    </div>
  );
}
