// 리포트 전문 — Heal(진단·패치 시도·diff) · Grow(명세·시도·테스트) · Evolve(감지·후보·결과) · 롤백 · 폐기 · 리플레이
import { AGENT_KO } from '@/lib/ko';
import { fmtNum } from '@/lib/format';
import CodeView from '@/components/common/CodeView';
import { Line, Section } from '@/components/common/Section';
import { cn } from '@/lib/utils';

export default function ReportDetail({ r }: { r: any }) {
  const c = r.content || {};
  if (r.kind === 'heal') {
    const cls = c.classification || {};
    const probs = Object.entries((cls.probs || {}) as Record<string, number>).sort((a, b) => b[1] - a[1]);
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-5">
          <Section title="진단">
            <dl className="kv text-[12.5px]"><dt>대상</dt><dd>{c.agent_id} {c.from_version} → {c.to_version || '(미반영)'}</dd><dt>오류 시그니처</dt><dd className="font-mono text-[11.5px]">{c.signature}</dd><dt>오류 유형</dt><dd>{cls.type} (Jev {cls.p}){cls.reclassified ? ' — 진단 후 재분류' : ''}</dd>
              {c.slicing ? <><dt>로그 슬라이싱</dt><dd>{c.slicing}</dd></> : null}<dt>원인</dt><dd>{c.cause || '-'}</dd><dt>시도/소요</dt><dd>{(c.attempts || []).length}회 / {c.mttr}</dd><dt>상태</dt><dd>{({ healed: '복구 완료', escalated: '운영자 에스컬레이션', external: '외부 장애' } as Record<string, string>)[c.status] || c.status}{c.escalate_reason ? ` — ${c.escalate_reason}` : ''}</dd></dl>
          </Section>
          <Section title="Jev 오류 유형 분류 확률">
            <div className="space-y-1.5">{probs.map(([k, p]) => <div key={k} className={cn('jv', k === cls.type ? 'sel' : 'off')}><span>{k}</span><span className="bar"><i style={{ width: `${p * 100}%` }} /></span><span className="v">{p.toFixed(2)}</span></div>)}</div>
          </Section>
        </div>
        <Section title="패치 시도">
          {(c.attempts || []).map((a: any) => <Line key={a.n} cls={a.result === 'pass' ? 'ok' : 'bad'}>{a.n}회차 {a.result === 'pass' ? '통과' : '기각'} — {a.summary} (+{a.diff_add}/−{a.diff_del}, {a.model}) · 회귀 {a.tests?.passed ?? 0}/{a.tests?.total ?? 0}{(a.tests?.failures || []).length ? ` — ${a.tests.failures.map((f: any) => `${f.label || f.case}: ${f.error}`).join('; ').slice(0, 220)}` : ''}{a.result !== 'pass' ? ` · 블랙리스트 ${a.hash}` : ''}</Line>)}
        </Section>
        {(c.cascade || []).length > 0 && <Section title="연쇄 복구">{c.cascade.map((x: any, i: number) => <Line key={i} cls="ok">{x.agent_id} {x.from} → {x.to || '실패'} · 회귀 {x.tests} · {x.why}</Line>)}</Section>}
        {c.diff && <Section title="패치 diff"><CodeView code={c.diff} diff maxHeight={9999} /></Section>}
      </div>
    );
  }
  if (r.kind === 'grow') return (
    <div className="space-y-5">
      <Section title={c.ok ? `${c.agent_id} ${c.version} 생성` : '생성 중단'}>{(c.lines || []).map((x: string, i: number) => <Line key={i}>{x}</Line>)}</Section>
      {c.spec && <Section title="Agent 명세 (LLM 작성)"><dl className="kv text-[12.5px]">{Object.entries(c.spec).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>)}</dl></Section>}
      {c.schema?.codes && <Section title="스키마 탐색 (CodeAct)"><Line>코드값 PRT_CD {c.schema.codes.total}종 (사전 {c.schema.codes.documented} + 추론 {(c.schema.codes.undocumented || []).length}) · 엣지 후보 {Object.keys(c.schema.edges || {}).length}종</Line></Section>}
      {(c.attempts || []).map((a: any) => <Section key={a.n} title={`${a.n}회차 — ${a.result === 'pass' ? '통과' : '실패'} ${a.note || ''}`}>{(a.tests || []).map((t: any, i: number) => <Line key={i} cls={t.ok ? 'ok' : 'bad'}>{t.name} — {t.detail}</Line>)}</Section>)}
    </div>
  );
  if (r.kind === 'replay') { const f = c.final || {}; return (
    <Section title="Held-out 최종 평가 (진화에 쓰지 않은 최근 6개월)">
      <Line>{f.n}건 — 판정 일치율 {f.before?.accuracy?.toFixed(0)}% → {f.after?.accuracy?.toFixed(0)}% · 1차 Pass 예측 {f.before?.pred_acc}% → {f.after?.pred_acc}% · 추천 오차 ±{f.before?.rec_error} → ±{f.after?.rec_error}매</Line>
      <Line cls="ok">미래 정보 누출 {f.leaks}건 (Time-Travel Guard 차단·필터 {fmtNum(f.guard_blocked, 0)}건)</Line>
    </Section>); }
  // evolve / rollback / retire
  return (
    <div className="space-y-5">
      {c.detect && <Section title="감지">{c.detect.map((x: string, i: number) => <Line key={i}>{x}</Line>)}</Section>}
      {c.kind === 'judgment' && <Section title={`판단 진화 — ${c.group} (${(c.period || []).join(' ~ ')})`}>
        <dl className="kv text-[12.5px]"><dt>운영 건</dt><dd>AutoQual {c.n}건 · Override {c.overrides}건 ({Object.entries(c.override_reasons || {}).map(([k, v]) => `${k} ${v}`).join(', ')})</dd><dt>추천대로 진행</dt><dd>{c.followed}건 중 1차 Fail {c.followed_fail}건 ({Object.entries(c.fail_items || {}).map(([k, v]) => `${k} ${v}`).join(', ')})</dd>
          <dt>원인 분석</dt><dd>1차 Fail 중 Focus Ring 600h 초과 {c.fr_fail}건 (part_history_agent 조회)</dd><dt>Override 분류</dt><dd>결과로 뒷받침 {c.backed}건 반영 / 보수적 {c.conservative}건 학습 제외</dd>
          {c.cluster ? <><dt>미해결 군집</dt><dd>{c.cluster.id}: {c.cluster.n}건 중 {c.cluster.hit}건 Focus Ring 600h 초과</dd></> : null}<dt>상태</dt><dd>{c.status === 'adopted' ? `채택 (승인 ${c.approver})` : '운영자 승인 대기'}</dd></dl></Section>}
      {c.kind === 'structure' && <Section title="결과"><dl className="kv text-[12.5px]"><dt>FDC 파싱 코드 중복</dt><dd>{c.dup_before}% → {c.dup_after}%</dd><dt>log_agent p50</dt><dd>{c.p50_before}s → {c.p50_after}s</dd>{c.shadow ? <><dt>Shadow</dt><dd>요청 {c.shadow.n}건 ({Object.entries(c.shadow.by_group || {}).map(([k, v]) => `${k} ${v}`).join(', ')}), 불일치 {c.shadow.mismatch}건</dd></> : null}{(c.changes || []).map((x: any, i: number) => <div key={i} className="contents"><dt>승격</dt><dd>{x.agent_id} {x.from || '-'} → {x.to}</dd></div>)}</dl></Section>}
      {c.kind === 'rollback' && <Section title="자동 롤백"><dl className="kv text-[12.5px]"><dt>원인</dt><dd>{c.cause}</dd><dt>판정 불일치</dt><dd>{c.group} {c.n}건 중 {c.mismatch}건 — {(c.detail || []).join('; ')}</dd><dt>원자적 롤백</dt><dd>{(c.cascade || []).map((x: any) => `${x.agent_id} ${x.from} → ${x.to}`).join(' / ')}</dd><dt>Held-out 추가</dt><dd>{c.heldout_added}건</dd></dl></Section>}
      {c.kind === 'merge' && <Section title="병합 재도전"><Line>{c.line}</Line><Line cls="muted">출발점: {c.from_archive}</Line></Section>}
      {c.kind === 'orchestration' && c.calls && <Section title="결과"><Line>요청당 호출 Agent {c.calls[0]} → {c.calls[1]}</Line>{c.change && <Line cls="ok">super_agent {c.change.from} → {c.change.to}</Line>}</Section>}
      {c.scan && <Section title="Retire 후보 감지">
        <table className="tbl"><thead><tr><th>Agent</th><th className="num">마지막 호출</th><th className="num">직접/간접(30일)</th><th className="num">기능 중첩</th><th className="num">Jev</th><th>사유</th></tr></thead>
          <tbody>{c.scan.map((x: any) => <tr key={x.agent_id}><td>{x.agent_id} {x.version}</td><td className="num">{x.days_unused}일 전</td><td className="num">{x.direct_30d} / {x.indirect_30d}</td><td className="num">{x.overlap}</td><td className="num">{Number(x.p).toFixed(2)}</td><td>{x.reason}</td></tr>)}</tbody></table></Section>}
      {c.items && <Section title="폐기 검토">{c.items.map((x: any) => <Line key={x.agent_id} cls={x.decision === 'hold' ? 'warn' : 'ok'}>{x.agent_id} {x.version} — {x.decision === 'hold' ? '폐기 보류' : `deprecated (유예 ~${String(x.grace_until || '').slice(0, 10)})`} · {x.why || x.reason}{x.verify ? ` · 대체 검증 ${x.verify.ok}/${x.verify.total} 일치 · 테스트 이관 ${x.migrated}건` : ''} · 의존성 {(x.deps || []).map((d: any) => `${d.kind}:${d.ref}`).join(', ') || '없음'}</Line>)}</Section>}
      {c.grace_event && <Section title="유예 중 사건"><Line>대체 검증 재수행 {c.grace_event.verify?.ok}/{c.grace_event.verify?.total} → 유예 재시작 ~{String(c.grace_event.grace_until).slice(0, 10)}</Line></Section>}
      {c.final && <Section title="확정"><Line>편성 후보 Agent {c.final.n}개: {(c.final.candidates || []).join(', ')} — 폐기 Genome·테스트·Lineage는 아카이브 보관(복원 가능)</Line></Section>}
      {(c.candidates || []).length > 0 && <Section title="변이 → 평가 → 선택 (모든 후보 아카이브 보관)"><CandTable cands={c.candidates} /></Section>}
      {c.base && <Section title="기준선 (현재 운영 구성)"><Line>Evolve셋 판정 일치율 {c.base.E?.accuracy}% ({c.base.E?.n}건) · 검증셋 {c.base.V?.accuracy ?? '-'}% ({c.base.V?.n ?? 0}건) · 1차 Pass율(백테스트) {c.base.E?.first_pass_rate}%</Line></Section>}
      {(c.clusters || []).length > 0 && <Section title="미해결 오차 군집">{c.clusters.map((x: any) => <Line key={x.id}>{x.id}: {x.text}</Line>)}</Section>}
      {(c.adopted || []).length > 0 && <Line cls="ok">채택 {c.adopted.join(', ')} → 다음 분기부터 새 버전으로 재생 (Walk-forward)</Line>}
    </div>
  );
}

export function CandTable({ cands }: { cands: any[] }) {
  return (
    <table className="tbl">
      <thead><tr><th>후보</th><th>계층</th><th className="num">Evolve셋</th><th className="num">Held-out</th><th>결정</th></tr></thead>
      <tbody>
        {cands.map((x) => { const sc = x.scores || {}; return (
          <tr key={x.cid} className={x.decision === 'adopt' ? 'ok' : ''}>
            <td><b>{x.cid}</b> {(x.title || x.line || '').slice(0, 90)}{x.why ? <div className="text-ink-3">{String(x.why).slice(0, 100)}</div> : null}</td>
            <td>{x.layer || ''}</td>
            <td className="num">{sc.dE != null ? `${sc.dE > 0 ? '+' : ''}${sc.dE}%p` : x.dE != null ? `${x.dE > 0 ? '+' : ''}${x.dE}` : '-'}</td>
            <td className="num">{sc.dV != null ? `${sc.dV > 0 ? '+' : ''}${sc.dV}%p` : '-'}</td>
            <td><span className={cn('st', x.decision === 'adopt' ? 'lane-ok' : x.decision === 'hold' ? 'lane-warn' : 'lane-ink')}><i />{({ adopt: '채택', reject: '기각', hold: '보류' } as Record<string, string>)[x.decision] || x.decision}</span>
              {x.reason ? <div className="mt-1 text-ink-3">{String(x.reason).slice(0, 120)}</div> : null}
              {(x.changes || []).length ? <div className="text-ok">{x.changes.map((ch: any) => `${AGENT_KO[ch.agent_id] || ch.agent_id} ${ch.from || '-'} → ${ch.to}`).join(' / ')}</div> : null}
              {x.lessons?.new?.length ? <div className="text-[#d9d7ff]">신규 교훈 {x.lessons.new.map((l: any) => l.id || l).join(', ')}</div> : null}</td>
          </tr>); })}
      </tbody>
    </table>
  );
}
