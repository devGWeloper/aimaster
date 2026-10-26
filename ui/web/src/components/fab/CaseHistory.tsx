// Agent가 처리한 Qual 이력 — 운영 기간 전체(가상 엔지니어 요청 포함)
import { useApp } from '@/store/store';
import { PM_KO, short } from '@/lib/ko';
import { cn } from '@/lib/utils';

export default function CaseHistory() {
  const rows = useApp((s) => s.biz.cases);
  const n = rows.length;
  const p1 = rows.filter((x) => x.pass1 === true).length, ov = rows.filter((x) => x.override).length, rw = rows.reduce((a, x) => a + Math.max(0, (x.attempts || 1) - 1), 0);
  const corr = rows.filter((x) => (x.corrections || []).length).length;
  const stats: [string | number, string][] = [[n, '처리 건수'], [n ? `${Math.round((p1 / n) * 100)}%` : '-', '1차 Pass'], [n ? `${Math.round((ov / n) * 100)}%` : '-', 'Override'], [n ? `${Math.round((corr / n) * 100)}%` : '-', '교훈 보정 적용'], [rw, '재작업']];
  return (
    <section className="panel">
      <div className="panel-h"><h2>Agent가 처리한 Qual 이력</h2><span className="d">운영 기간 전체 · 가상 엔지니어 요청 포함 · 최근 순</span>
        <div className="ml-auto flex gap-5">{stats.map(([v, k]) => <div key={k} className="text-right"><div className="font-mono text-[16px] font-bold leading-none">{v}</div><div className="text-[10.5px] text-ink-3">{k}</div></div>)}</div></div>
      {n === 0 ? <div className="px-4 pb-6 text-center text-[12.5px] text-ink-3">Autopilot이 운영 기간을 진행하면 Agent가 자율 처리한 AutoQual 건이 여기 쌓입니다.</div> : (
        <div className="max-h-[520px] overflow-auto px-2 pb-2">
          <table className="tbl"><thead><tr><th>PM 종료</th><th>챔버</th><th>PM</th><th className="num">추천</th><th>1차 결과</th><th>조치</th><th>Agent 버전</th></tr></thead>
            <tbody>{rows.slice(0, 200).map((c) => { const res = c.pass1 === true ? 'PASS' : c.pass1 === false ? 'FAIL' : '-'; return (
              <tr key={c.request_id || c.id} className={cn(c.pass1 === false && 'warn')}>
                <td className="font-mono text-ink-3">{String(c.pm_end || c.ts || '').slice(5, 16)}</td><td className="font-semibold">{c.chamber_id}</td><td>{PM_KO[c.pm_type || ''] || c.pm_type}</td>
                <td className="num">{c.count ?? '-'}매{(c.corrections || []).length ? <span title={`교훈 ${c.corrections!.join(', ')} 적용`} className="ml-1 text-l3">L</span> : null}{c.override ? <span title={`Override ${c.override.count}매 — ${c.override.reason}`} className="ml-1 text-warn">→{c.override.count}</span> : null}</td>
                <td><span className={cn('font-bold', res === 'PASS' ? 'text-ok' : res === 'FAIL' ? 'text-bad' : 'text-ink-3')}>{res}</span>{c.fail_items ? <small className="ml-1 text-ink-3">{c.fail_items}</small> : null}{(c.attempts || 1) > 1 ? <small className="ml-1 text-ink-3">×{c.attempts}</small> : null}</td>
                <td className="text-ink-2">{c.escalated ? '에스컬레이션' : c.approved === false ? '반려' : `UP · ${(c.approver || '').replace('(교대 리더)', '')}`}</td>
                <td className="font-mono text-[10.5px] text-ink-3">{Object.entries(c.versions || {}).map(([k, v]) => `${short(k)} ${v}`).join(', ')}</td>
              </tr>); })}</tbody></table>
        </div>
      )}
    </section>
  );
}
