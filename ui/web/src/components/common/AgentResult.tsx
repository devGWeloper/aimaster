// Agent 호출 결과 — 입력 · 가져온 값 · 도구 원장(권한 프록시) · 감사 ID
import type { AnyEv } from '@/lib/types';

export default function AgentResult({ D }: { D: Record<string, any> }) {
  const st = D.start || {};
  const inputs = D.inputs || {};
  const ik = Object.entries(inputs).filter(([k]) => !['eqp_model', 'eqp_group'].includes(k));
  const tools: AnyEv[] = D.tools || [];
  return (
    <div className="space-y-2 text-[12px]">
      {ik.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-ink-3">입력</span>{ik.map(([k, v]) => <span key={k} className="rounded bg-raise px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{k}={String(v)}</span>)}</div>}
      {D.summary?.length > 0 && (
        <div><div className="mb-1 text-ink-3">가져온 값 · 산출</div><ul className="space-y-0.5 rounded-md border border-l1/30 bg-l1/6 px-3 py-2 text-ink">{D.summary.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
      )}
      {D.error && <div className="rounded-md bg-bad/10 px-3 py-2 text-[#ffd6d4]">{D.error_type || '오류'}: {D.error}<div className="mt-1 text-ink-3">→ 사후 검증 실패는 "확인 불가"로 표시되고 L2 Heal이 기동됩니다 (추측 답변 없음)</div></div>}
      {!D.error && D.violations?.length > 0 && <div className="rounded-md bg-bad/10 px-3 py-2 text-[#ffd6d4]">사후 검증 위반: {D.violations.join('; ')}</div>}
      {(tools.length > 0 || st.tools_allowed) && (
        <div>
          <div className="mb-1 text-ink-3">도구 호출 {tools.reduce((a, x) => a + (x.n || 0), 0)}회 · 허용 도구 {(st.tools_allowed || []).length}개 (Genome에 선언된 것만)</div>
          <table className="tbl"><thead><tr><th>도구 (권한 프록시)</th><th className="num">호출</th><th className="num">ms</th></tr></thead>
            <tbody>{tools.map((x) => <tr key={x.tool} className={x.denied ? 'bad' : ''}><td>{x.tool}{x.denied ? ' — 권한 없음(차단)' : ''}</td><td className="num">{x.n}</td><td className="num">{x.ms}</td></tr>)}</tbody></table>
        </div>
      )}
      <div className="text-ink-3">감사 {D.audit_id || '-'} · status={D.status || '-'}{D.end?.replay ? ' · 리플레이(Time-Travel Guard)' : ''}{D.end?.guard ? ` · Guard 차단 ${D.end.guard}` : ''}</div>
    </div>
  );
}
