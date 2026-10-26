// 승인 게이트 — 사람 승인이 필요한 순간 화면 가운데에 나트륨 앰버 카드로 멈춘다. (장비 Up · 승격 · 진화안 · 폐기)
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApp } from '@/store/store';
import { KIND_KO, ITEM_KO } from '@/lib/ko';
import { fmtVal } from '@/lib/format';
import { operatorName, setOperatorName } from '@/lib/api';
import type { Approval } from '@/lib/types';

const EMPTY: Approval[] = [];

export function approvalLines(a: Approval): string[] {
  const p = a.payload || {};
  const lines: string[] = [];
  if (a.kind === 'state_change') {
    const ev = p.evidence || {}, j = ev.judgement || {};
    lines.push(`근거: judge_qual ${j.result} (${(j.details || []).map((x: any) => `${ITEM_KO[x.item] || x.item} ${fmtVal(x.value)}`).join(', ')})`);
    lines.push(`절차 ${ev.procedure} · Seasoning ${ev.count}매 · 시도 ${ev.attempts}회 · ${p.chamber_id} ${p.from_state} → ${p.to_state}`);
    lines.push('장비 상태 변경은 Jev 확신도와 무관하게 사람 승인 필수 (임계값 하한 0.95는 루프 밖 고정)');
  } else if (a.kind === 'evolution') (p.lines || []).forEach((x: string) => lines.push(x));
  else if (a.kind === 'promotion') { lines.push(`${p.agent_id} ${p.version}: ${p.why}`); lines.push(`테스트 ${p.tests} · 누적 호출 ${p.calls}건`); }
  else if (a.kind === 'retire') { lines.push(p.note || ''); lines.push(`유예 종료 ${String(p.grace_until || '').slice(0, 10)} · 대체 ${p.replacement || '-'}`); }
  return lines.filter(Boolean);
}

export default function ApprovalGate() {
  const pending = useApp((s) => s.snap?.approvals ?? EMPTY);
  const countdown = useApp((s) => s.countdown);
  const decide = useApp((s) => s.decide);
  const [hidden, setHidden] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [who, setWho] = useState(operatorName());
  const [left, setLeft] = useState<number | null>(null);
  const modal = pending.filter((x) => x.kind !== 'promotion');
  const docked = pending.filter((x) => x.kind === 'promotion' || hidden === x.request_id);
  const a = modal.filter((x) => hidden !== x.request_id)[modal.length - 1];
  useEffect(() => { setReason(''); }, [a?.request_id]);
  useEffect(() => {
    if (!countdown || !pending.some((x) => x.request_id === countdown.rid)) { setLeft(null); return; }
    const tick = () => setLeft(Math.max(0, countdown.seconds - Math.floor((Date.now() - countdown.at) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [countdown, pending]);
  const lines = a ? approvalLines(a) : [];

  return (
    <>
      {docked.length > 0 && (
        <div className="fixed right-4 top-[116px] z-40 flex w-[380px] flex-col gap-2">
          {docked.map((d) => (
            <div key={d.request_id} className="lane-gate flash-in rounded-xl border border-gate/60 bg-popover p-3.5 shadow-xl">
              <div className="flex items-start gap-2.5">
                <div className="flex size-8 flex-none items-center justify-center rounded-full bg-gate/20 text-gate"><ShieldCheck className="size-4" /></div>
                <div className="min-w-0"><div className="text-[11px] font-semibold text-gate">사람 승인 대기 · {KIND_KO[d.kind] || d.kind}</div><div className="text-[13px] font-bold leading-snug">{d.title}</div><div className="text-[10.5px] text-ink-3">{d.request_id} · {d.requested_ts}</div></div>
              </div>
              <ul className="mt-2 space-y-0.5 text-[11.5px] text-ink-2">{approvalLines(d).slice(0, 2).map((x, i) => <li key={i}>{x}</li>)}</ul>
              <div className="mt-2.5 flex items-center gap-1.5">
                <Button size="sm" className="bg-gate text-[#2a1a00] hover:bg-gate/85" onClick={() => decide(d.request_id, true)}>승인</Button>
                <Button size="sm" variant="destructive" onClick={() => decide(d.request_id, false)}>반려</Button>
                {countdown?.rid === d.request_id && left != null && <span className="ml-auto text-[11px] text-gate">자동 승인 {left}s</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {a && <Modal a={a} lines={lines} who={who} setWho={setWho} reason={reason} setReason={setReason} left={left} nPending={modal.length} decide={decide} onLater={() => setHidden(a.request_id)} />}
    </>
  );
}

function Modal({ a, lines, who, setWho, reason, setReason, left, nPending, decide, onLater }: { a: Approval; lines: string[]; who: string; setWho: (v: string) => void; reason: string; setReason: (v: string) => void; left: number | null; nPending: number; decide: (rid: string, ok: boolean, reason?: string) => void; onLater: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
      <div className="pop w-[560px] max-w-[92vw] rounded-2xl border border-gate/60 bg-popover p-6 shadow-[0_30px_80px_rgba(0,0,0,.55),0_0_0_1px_color-mix(in_oklab,var(--gate)_30%,transparent)]">
        <div className="flex items-start gap-4">
          <div className="lane-gate beat flex size-12 flex-none items-center justify-center rounded-full bg-gate/20 text-gate"><ShieldCheck className="size-6" /></div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-gate">사람 승인 필요 · {KIND_KO[a.kind] || a.kind}</div>
            <div className="mt-0.5 text-[18px] font-bold leading-snug tracking-tight">{a.title}</div>
            <div className="mt-1 text-[11.5px] text-ink-3">{a.request_id} · 요청 {a.requested_ts}{nPending > 1 ? ` · 대기 ${nPending}건` : ''}</div>
          </div>
        </div>
        <ul className="mt-4 space-y-1.5 rounded-lg bg-raise/60 p-3.5 text-[12.5px] leading-relaxed text-ink-2">
          {lines.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
        <div className="mt-4 grid grid-cols-[140px_1fr] gap-2">
          <Input value={who} onChange={(e) => { setWho(e.target.value); setOperatorName(e.target.value); }} placeholder="승인자" aria-label="승인자" />
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 (선택)" aria-label="사유" />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button size="lg" className="bg-gate font-semibold text-[#2a1a00] hover:bg-gate/85" onClick={() => decide(a.request_id, true, reason)}>승인</Button>
          <Button size="lg" variant="destructive" onClick={() => decide(a.request_id, false, reason)}>반려</Button>
          <Button size="lg" variant="ghost" onClick={onLater}>나중에</Button>
          {left != null && <span className="ml-auto text-[12px] text-gate">데모 운영자 자동 승인 {left}s</span>}
        </div>
      </div>
    </div>
  );
}
