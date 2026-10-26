// judge_qual 판정 표 — 결정적 코드의 Pass/Fail 근거 (항목 · 측정 · Spec · 판정)
import { ITEM_KO } from '@/lib/ko';
import { fmtSpec, fmtVal, unitKo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AnyEv } from '@/lib/types';

const REWORK: Record<string, string> = { reseason: '재Seasoning', bp_wait: 'BP 안정화 대기 후 재측정', purge: 'Purge 후 재측정' };

export default function JudgeTable({ j, count, big }: { j: AnyEv; count?: number; big?: boolean }) {
  const res = j.result;
  return (
    <div className="space-y-2">
      <table className={cn('tbl', big && 'text-[13px]')}>
        <thead><tr><th>항목</th><th className="num">측정</th><th>Spec</th><th>판정</th></tr></thead>
        <tbody>
          {(j.details || []).map((x: AnyEv) => {
            const conv = x.input_unit && x.input_unit !== x.unit ? ` (입력 ${fmtVal(x.input_value)} ${unitKo(x.input_unit)} → 환산)` : '';
            return (
              <tr key={x.item} className={x.pass ? '' : 'bad'}>
                <td>{ITEM_KO[x.item] || x.item}</td>
                <td className="num">{fmtVal(x.value)} {unitKo(x.unit)}{conv}</td>
                <td>{fmtSpec(x.spec)} {unitKo(x.unit)}</td>
                <td className={x.pass ? 'text-ok' : 'text-bad'}>{x.pass ? (x.boundary ? '✓ 경계값 PASS' : '✓ PASS') : '✗ FAIL'}</td>
              </tr>
            );
          })}
          {(j.missing || []).map((m: string) => <tr key={m} className="warn"><td>{ITEM_KO[m] || m}</td><td className="num">미측정</td><td /><td>PASS 금지</td></tr>)}
          {(j.hold || []).map((hd: AnyEv) => <tr key={hd.item} className="warn"><td>{ITEM_KO[hd.item] || hd.item}</td><td className="num">{fmtVal(hd.value)}</td><td /><td>보류 — {hd.reason}</td></tr>)}
        </tbody>
      </table>
      <div className={cn('flex items-baseline gap-3 rounded-lg px-3 py-2 font-bold', big ? 'text-[20px]' : 'text-[15px]', res === 'PASS' ? 'bg-ok/12 text-ok' : res === 'FAIL' ? 'bg-bad/12 text-bad' : 'bg-warn/12 text-warn')}>
        Qual {res}
        {count ? <span className="text-[12px] font-normal text-ink-3">Seasoning {count}매</span> : null}
        {j.rework ? <span className="text-[12px] font-normal text-ink-3">재작업: {REWORK[j.rework_type] || j.rework_type}</span> : null}
      </div>
    </div>
  );
}
