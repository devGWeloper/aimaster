// 승인 요청/결정 카드 (트레이스·포커스 공용) — 대기 중이면 바로 승인/반려
import { Button } from '@/components/ui/button';
import { approvalLines } from '@/components/shell/ApprovalGate';
import { useApp } from '@/store/store';
import type { AnyEv } from '@/lib/types';

export default function ApprovalCard({ apr, decided, pending }: { apr: AnyEv; decided?: AnyEv | null; pending?: boolean }) {
  const decide = useApp((s) => s.decide);
  const lines = approvalLines(apr as never);
  return (
    <div className="space-y-2 text-[12.5px]">
      <ul className="space-y-1 text-ink-2">{lines.map((x, i) => <li key={i}>{x}</li>)}</ul>
      {pending && !decided && (
        <div className="flex gap-2">
          <Button size="sm" className="bg-gate text-[#2a1a00] hover:bg-gate/85" onClick={() => decide(apr.request_id, true)}>승인</Button>
          <Button size="sm" variant="destructive" onClick={() => decide(apr.request_id, false)}>반려</Button>
        </div>
      )}
      {decided && <div className={`rounded-md px-3 py-1.5 font-semibold ${decided.approved ? 'bg-ok/12 text-ok' : 'bg-bad/12 text-bad'}`}>{decided.approved ? '승인' : '반려'} — {decided.approver}{decided.reason ? ` (${decided.reason})` : ''}</div>}
    </div>
  );
}
