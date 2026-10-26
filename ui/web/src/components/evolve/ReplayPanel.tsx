// 이력 리플레이 진화 — 3년치 Qual 이력을 시간순 재생(Walk-forward)하며 분기마다 L3 Evolve. 최근 6개월은 Held-out(평가만).
import { useEffect, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { Section, Line as L, Empty } from '@/components/common/Section';

export default function ReplayPanel() {
  const snap = useApp((s) => s.snap);
  const prog = useApp((s) => s.live.replayProg);
  const [final, setFinal] = useState<any>(null);
  const [lessons, setLessons] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const rows: any[] = snap?.replay_rows || [];
  useEffect(() => {
    api('/api/report/REPLAY-01').then((r) => setFinal(r.content?.final)).catch(() => setFinal(null));
    api('/api/memory?kind=lesson').then(setLessons).catch(() => setLessons([]));
    api('/api/memory?kind=cluster').then(setClusters).catch(() => setClusters([]));
  }, [rows.length, snap?.counts?.lessons]);
  const data = rows.map((r) => ({ q: String(r.quarter).replace(' ', ''), acc: r.accuracy, err: r.rec_error, heldout: r.split === 'heldout', events: r.events || [], pred: r.pred_acc, judge: r.judge_acc, lessons: r.lessons_active }));
  const ho = data.findIndex((d) => d.heldout);
  const running = snap?.replay?.state === 'running' && prog && prog.phase === 'case';
  return (
    <div className="space-y-4">
      <div className="text-[12px] text-ink-2">3년치 Qual 이력 3,000건을 시간순으로 재생하며 분기마다 L3 Evolve를 수행합니다(Walk-forward). 최근 6개월은 <b className="text-ink">Held-out</b>으로 진화에 쓰지 않고 평가만 합니다. <b className="text-ink">Time-Travel Guard</b>가 replay_clock 이후 데이터를 차단해 미래 정보 누출을 막습니다.</div>
      {running && (
        <div className="lane-l3 rounded-lg border border-l3/50 bg-panel-2 p-3">
          <div className="flex items-baseline gap-2 text-[12.5px]"><b className="text-l3">{prog.quarter} 재생 중</b><span className="font-mono text-ink-3">{Number(prog.done).toLocaleString()} / {Number(prog.total).toLocaleString()}건</span><span className="ml-auto font-mono text-[11px] text-ink-3">replay_clock {String(prog.replay_clock || '').slice(0, 16)}</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-raise"><i className="block h-full rounded-full bg-l3 transition-[width]" style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} /></div>
          <div className="mt-1 text-[11px] text-ink-3">Guard 누적 필터·차단 {fmtNum(prog.guard, 0)}건</div>
        </div>
      )}
      <Section title="분기별 판정 일치율 (진화 구간 → Held-out)">
        {data.length ? (
          <div className="h-[220px] rounded-lg border border-line bg-bg p-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="q" tick={{ fill: 'var(--ink-3)', fontSize: 10.5 }} axisLine={{ stroke: 'var(--line-2)' }} tickLine={false} />
                <YAxis domain={[(min: number) => Math.max(0, Math.floor((min - 8) / 10) * 10), 100]} tick={{ fill: 'var(--ink-3)', fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                {ho >= 0 && <ReferenceArea x1={data[ho].q} x2={data[data.length - 1].q} fill="var(--l3)" fillOpacity={0.08} label={{ value: 'Held-out (평가만)', position: 'insideTopLeft', fill: 'var(--l3)', fontSize: 10.5 }} />}
                <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: 'var(--ink)' }} formatter={(v: any, name: any) => [name === 'acc' ? `${v}%` : `±${v}매`, name === 'acc' ? '판정 일치율' : '추천 오차']} />
                <Area type="monotone" dataKey="acc" stroke="none" fill="var(--l3)" fillOpacity={0.12} />
                <Line type="monotone" dataKey="acc" stroke="var(--l3)" strokeWidth={2.2} dot={{ r: 3.5, fill: 'var(--l3)', strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : <Empty>리플레이(SC-006)가 시작되면 분기별 진화 곡선이 그려집니다.</Empty>}
      </Section>
      <Section title="Held-out 최종 평가 (2026 상반기)">
        {final ? (
          <div className="rounded-lg border border-line bg-panel-2 p-3">
            <div className="flex items-baseline gap-3"><span className="text-[12px] text-ink-3">판정 일치율</span><b className="font-mono text-[26px] font-extrabold"><span className="text-ink-3">{final.before.accuracy.toFixed(0)}%</span><span className="mx-2 text-ink-3">→</span><span className="text-l3">{final.after.accuracy.toFixed(0)}%</span></b><span className="text-[12px] text-ink-3">{final.n}건, 같은 건을 고정 하네스로 재채점</span></div>
            <dl className="kv mt-2 text-[12px]">
              <dt>1차 Pass 예측</dt><dd>{final.before.pred_acc}% → {final.after.pred_acc}%</dd>
              <dt>judge_qual 판정</dt><dd>{final.before.judge_acc}% → {final.after.judge_acc}%</dd>
              <dt>백테스트 1차 Pass율</dt><dd>{final.before.first_pass_rate}% → {final.after.first_pass_rate}%{snap?.after_sc007 ? <span className="text-ink-3"> → {snap.after_sc007.first_pass_rate}% (SC-007 판단 진화 후)</span> : null}</dd>
              <dt>추천 오차</dt><dd>±{final.before.rec_error} → ±{final.after.rec_error}매</dd>
              <dt>미래 정보 누출</dt><dd><b className="text-ok">{final.leaks}건</b> (Guard 필터·차단 {fmtNum(final.guard_blocked, 0)}건)</dd>
            </dl>
          </div>
        ) : <Empty>리플레이 종료 후 표시</Empty>}
      </Section>
      {data.length > 0 && (
        <Section title="분기별 진화 사건">
          <table className="tbl"><thead><tr><th>구간</th><th className="num">일치율</th><th className="num">오차</th><th className="num">교훈 +/만료</th><th>주요 사건</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.q}><td>{d.q}{d.heldout ? <span className="text-ink-3"> Held-out</span> : null}</td><td className="num">{d.acc}%</td><td className="num">±{d.err}</td><td className="num">{rows.find((r) => String(r.quarter).replace(' ', '') === d.q)?.new_lessons || '-'} / {rows.find((r) => String(r.quarter).replace(' ', '') === d.q)?.expired_lessons || '-'}</td><td className="text-ink-2">{d.events.length ? d.events.map((x: string, i: number) => <div key={i}>{x}</div>) : <span className="text-ink-3">{d.heldout ? '평가만' : '-'}</span>}</td></tr>)}</tbody></table>
        </Section>
      )}
      <Section title={`학습된 교훈 (적용 ${lessons.filter((x) => x.status === 'active').length} / 전체 ${lessons.length})`}>
        {lessons.length ? <div className="max-h-[260px] overflow-auto rounded-lg border border-line"><table className="tbl"><thead><tr><th>ID</th><th>상태</th><th>교훈</th><th className="num">원천</th><th>학습</th></tr></thead>
          <tbody>{[...lessons].reverse().map((x) => <tr key={x.id}><td className="font-mono">{x.id}</td><td><span className={`st ${x.status === 'active' ? 'lane-ok' : 'lane-ink'}`}><i />{x.status === 'active' ? '적용' : '만료'}</span></td><td className={x.status === 'active' ? 'text-[#d9d7ff]' : 'text-ink-3'}>{x.content?.text}</td><td className="num">{x.sources}건</td><td>{x.content?.learned_q || ''}</td></tr>)}</tbody></table></div> : <Empty>아직 교훈이 없습니다.</Empty>}
      </Section>
      {clusters.length > 0 && <Section title="미해결 오차 군집">{clusters.map((c) => <L key={c.id}>{c.id} {c.status === 'resolved' ? '(해소)' : ''} — {c.content?.text} <span className="text-ink-3">{c.content?.resolved_by ? `· ${c.content.resolved_by}에서 원인 변수 확인` : '· 억지 교훈을 만들지 않고 미해결로 보존'}</span></L>)}</Section>}
    </div>
  );
}
