// Agent Genome 상세 — 코드(버전 선택) · 프롬프트 · 도구 · 기능 플래그 · Lineage · 테스트
import { AGENT_DESC, AGENT_KO, STATUS_KO, VKIND } from '@/lib/ko';
import CodeView from '@/components/common/CodeView';
import { cn } from '@/lib/utils';

const LV_C: Record<string, string> = { baseline: 'ink', heal: 'l2', grow: 'l2', evolve: 'l3', compose: 'l3', rollback: 'bad', promote: 'ok', deprecate: 'warn', retire: 'ink', restore: 'l1', grace_restart: 'warn', defect: 'bad', shadow: 'l3' };

export default function AgentDetail({ d, agentId, onVersion }: { d: any; agentId: string; onVersion: (v: string) => void }) {
  const a = d.agent || {};
  const g = d.genome || {};
  const params = g.params || {};
  const lineage = [...(d.lineage || [])].reverse();
  return (
    <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-5">
      <div className="space-y-4">
        <div className="rounded-lg border border-line bg-panel-2 p-3">
          <div className="text-[16px] font-extrabold">{AGENT_KO[agentId] || agentId}</div>
          <div className="text-[12px] text-ink-3">{AGENT_DESC[agentId] || a.name_ko || ''}</div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11.5px]">
            <span className={cn('st', a.status === 'active' ? 'lane-l1' : a.status === 'probation' ? 'lane-l2' : a.status === 'deprecated' ? 'lane-warn' : 'lane-ink')}><i />{STATUS_KO[a.status] || a.status}</span>
            <span className="st lane-ink"><i />{a.active_version} 운영</span>
            {a.protected ? <span className="st lane-gate"><i />보호(폐기 제외)</span> : null}
            {a.shadow_version ? <span className="st lane-l3"><i />Shadow {a.shadow_version}</span> : null}
          </div>
          <dl className="kv mt-3 text-[12px]"><dt>출처</dt><dd>{a.origin}</dd><dt>호출</dt><dd>직접 {a.direct_calls} · 간접 {a.indirect_calls}</dd><dt>생성</dt><dd>{String(a.created_ts || '').slice(0, 16)}</dd><dt>최근 호출</dt><dd>{String(a.last_called_ts || '-').slice(0, 16)}</dd></dl>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-semibold text-ink-3">Lineage · {lineage.length}건</div>
          <ol className="space-y-1.5">
            {lineage.map((l: any) => (
              <li key={l.id} className={cn('rounded-md border-l-[3px] bg-panel-2 px-3 py-1.5 text-[12px]', `lane-${LV_C[l.kind] || 'ink'} border-[var(--c)]`)}>
                <div className="flex items-baseline gap-2"><b className="font-mono">{l.to_version}</b><span className="text-[var(--c)]">{VKIND[l.kind] || l.kind}</span>{l.ref ? <span className="font-mono text-[10.5px] text-ink-3">{l.ref}</span> : null}<span className="ml-auto font-mono text-[10.5px] text-ink-3">{String(l.ts).slice(0, 16)}</span></div>
                {l.note ? <div className="text-ink-2">{l.note}{l.diff_add || l.diff_del ? <span className="text-ink-3"> +{l.diff_add}/−{l.diff_del}</span> : null}</div> : null}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-semibold text-ink-3">테스트 · {(d.tests || []).length}건 (루프 밖 하네스가 실행)</div>
          <div className="max-h-[260px] space-y-0.5 overflow-auto text-[11.5px] text-ink-2">{(d.tests || []).slice(0, 200).map((t: any) => <div key={t.test_id} className="truncate"><span className="font-mono text-ink-3">{t.test_id}</span> <span className="rounded bg-raise px-1 text-[10px]">{t.suite}</span> {t.label || ''}</div>)}</div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-[13.5px] font-bold">Genome 코드</h3>
          <select className="h-7 rounded-md border border-line-2 bg-bg px-2 text-[12px]" value={g.version} onChange={(e) => onVersion(e.target.value)}>
            {(d.versions || []).map((v: any) => <option key={v.version} value={v.version}>{v.version} ({v.status})</option>)}
          </select>
          <span className="text-[12px] text-ink-3">{g.lines}줄 · {g.reason}{g.ref ? ` ${g.ref}` : ''} · 도구 {(g.tools || []).join(', ')}</span>
        </div>
        {params.features ? <div className="text-[12px] text-ink-3">기능 플래그: {params.features.join(', ') || '(기본)'}</div> : null}
        {g.prompt ? <div className="rounded-md bg-panel-2 px-3 py-2 text-[12px] text-ink-2">프롬프트: {String(g.prompt).slice(0, 400)}</div> : null}
        <CodeView code={g.code || ''} maxHeight={9999} />
      </div>
    </div>
  );
}
