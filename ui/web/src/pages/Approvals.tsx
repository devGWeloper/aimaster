// 승인 — 사람이 결정해야 하는 것들. 대기 카드(크게) + 이력
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import { KIND_KO } from '@/lib/ko';
import type { Approval } from '@/lib/types';
import { approvalLines } from '@/components/shell/ApprovalGate';
import { cn } from '@/lib/utils';

export default function ApprovalsPage() {
  const snap = useApp((s) => s.snap);
  const decide = useApp((s) => s.decide);
  const [rows, setRows] = useState<Approval[]>([]);
  useEffect(() => { api<Approval[]>('/api/approvals').then(setRows).catch(() => setRows([])); }, [snap?.approvals?.length, snap?.last_seq]);
  const pend = rows.filter((r) => r.status === 'pending');
  const hist = rows.filter((r) => r.status !== 'pending' && (r.kind !== 'state_change' || !String(r.approver || '').includes('교대')));
  const bg = rows.filter((r) => r.kind === 'state_change' && String(r.approver || '').includes('교대')).length;
  const kinds = rows.reduce((m: Record<string, number>, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {});
  return (
    <div className="page">
      <div className="page-h"><div><h1>사람 승인</h1><p>장비 상태 변경(Down → Up), Agent 정식 승격, 진화안 채택, 폐기 확정은 반드시 사람이 승인합니다. 자동·타임아웃 승인은 없습니다. Jev 확신도가 아무리 높아도 이 게이트를 건너뛸 수 없습니다.</p></div>
        <div className="flex gap-4 text-[11.5px] text-ink-3">{Object.entries(kinds).map(([k, n]) => <span key={k}><b className="font-mono text-[14px] text-ink">{n}</b> {KIND_KO[k] || k}</span>)}<span><b className="font-mono text-[14px] text-ink">0</b> 무승인 변경</span></div></div>
      <h2 className="mb-2 text-[13px] font-bold text-ink-2">대기 중 · {pend.length}</h2>
      {pend.length === 0 && <div className="mb-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-ink-3">대기 중인 승인 요청이 없습니다. Agent가 장비 Up·승격·진화안·폐기를 요청하면 여기와 화면 가운데 게이트에 나타납니다.</div>}
      <div className="mb-6 grid grid-cols-2 gap-3">
        {pend.map((a) => (
          <div key={a.request_id} className="lane-gate rounded-xl border border-gate/60 bg-panel p-4">
            <div className="flex items-start gap-3">
              <div className="beat flex size-9 flex-none items-center justify-center rounded-full bg-gate/20 text-gate"><ShieldCheck className="size-5" /></div>
              <div className="min-w-0"><div className="text-[11.5px] font-semibold text-gate">{KIND_KO[a.kind] || a.kind}</div><div className="text-[15px] font-bold leading-snug">{a.title}</div><div className="text-[11px] text-ink-3">{a.request_id} · {a.requested_ts}</div></div>
            </div>
            <ul className="mt-3 space-y-1 text-[12px] text-ink-2">{approvalLines(a).map((x, i) => <li key={i}>{x}</li>)}</ul>
            <div className="mt-3 flex gap-2"><Button className="bg-gate text-[#2a1a00] hover:bg-gate/85" onClick={() => decide(a.request_id, true)}>승인</Button><Button variant="destructive" onClick={() => decide(a.request_id, false)}>반려</Button></div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 text-[13px] font-bold text-ink-2">이력 · 주요 승인 {hist.length} <span className="font-normal text-ink-3">(배경 운영의 장비 Up 승인 {bg}건은 가상 교대 리더가 수행)</span></h2>
      <div className="rounded-xl border border-line bg-panel">
        <table className="tbl"><thead><tr><th>요청</th><th>종류</th><th>제목</th><th>결과</th><th>승인자</th><th>사유</th><th>시각</th></tr></thead>
          <tbody>{hist.slice(0, 150).map((r) => <tr key={r.request_id}><td className="font-mono">{r.request_id}</td><td>{KIND_KO[r.kind] || r.kind}</td><td>{r.title}</td><td><span className={cn('st', r.status === 'approved' ? 'lane-ok' : 'lane-bad')}><i />{r.status === 'approved' ? '승인' : '반려'}</span></td><td>{r.approver || '-'}</td><td className="text-ink-3">{r.reason || ''}</td><td className="font-mono text-ink-3">{r.decided_ts || r.requested_ts}</td></tr>)}</tbody></table>
        {hist.length === 0 && <div className="px-4 py-6 text-center text-[12px] text-ink-3">아직 이력이 없습니다.</div>}
      </div>
    </div>
  );
}
