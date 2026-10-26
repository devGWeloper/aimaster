// 현재 AutoQual 건 — 7단계 스테퍼 + 단계별 내용 (추천 매수 크게 · 판정 표 · 승인)
import { useApp } from '@/store/store';
import { STEPS, STEPS_OTHER, type Qual } from '@/store/biz';
import { PM_KO, RTYPE_KO } from '@/lib/ko';
import { hhmm } from '@/lib/format';
import JudgeTable from '@/components/common/JudgeTable';
import { cn } from '@/lib/utils';

const ST: Record<string, string> = { done: 'bg-ok text-[#05220f] border-ok', active: 'bg-l1 text-[#06221f] border-l1 glow', wait: 'bg-gate text-[#2a1a00] border-gate glow', bad: 'bg-bad text-white border-bad', todo: 'bg-panel text-ink-3 border-line-2' };
const LN: Record<string, string> = { muted: 'text-ink-3', warn: 'text-[#ffe9c6]', ok: 'text-ok', bad: 'text-[#ffd6d4]', gate: 'text-gate', l2: 'text-l2', ask: 'text-warn' };

export default function QualFlow() {
  const quals = useApp((s) => s.biz.quals);
  const order = useApp((s) => s.biz.order);
  const focus = useApp((s) => s.biz.focus);
  const setFocus = useApp((s) => s.setBizFocus);
  const q: Qual | undefined = focus ? quals[focus] : undefined;
  const others = order.map((k) => quals[k]).filter((x) => x && !x.done && x.id !== focus).slice(-4);
  return (
    <section className="panel flex min-h-[320px] flex-col">
      <div className="panel-h"><h2>현재 진행 중인 AutoQual</h2><span className="d">PM으로 Down된 챔버를 Qual 거쳐 UP시키는 일</span>
        <div className="ml-auto flex gap-1">{others.map((x) => <button key={x.id} type="button" onClick={() => setFocus(x.id)} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink">{x.en.chamber_id || x.id}</button>)}</div></div>
      {!q ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-[12.5px] text-ink-3"><div className="text-ink-2">아직 진행 중인 AutoQual 건이 없습니다.</div>Autopilot을 시작하거나 라이브 화면 대화창에 "ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘"처럼 요청하면 여기에 업무 흐름이 단계별로 채워집니다.</div>
      ) : <Body q={q} />}
    </section>
  );
}

function Body({ q }: { q: Qual }) {
  const en = q.en || {};
  const auto = q.rtype === 'autoqual';
  const steps = auto ? STEPS : STEPS_OTHER;
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <b className="text-[20px] font-extrabold tracking-tight">{en.chamber_id || en.eqp_id || en.eqp_prefix || q.id}</b>
        {en.eqp_model && <span className="text-[12px] text-ink-3">{en.eqp_model}</span>}
        <span className={cn('st', auto ? 'lane-l1' : 'lane-ink')}><i />{RTYPE_KO[q.rtype || ''] || (q.rtype ? q.rtype : '해석 중')}</span>
        {en.pm_type && <span className="text-[12px] text-ink-2">{PM_KO[en.pm_type] || en.pm_type}</span>}
        {q.done && <span className="st lane-ok"><i />완료</span>}
        <span className="ml-auto text-[11px] text-ink-3">{q.user || '엔지니어'} · {hhmm(q.ts)} · {q.id}</span>
      </div>
      <div className="mt-0.5 text-[12.5px] text-ink-2">“{q.text}”</div>
      <div className="mt-3 flex items-center">
        {steps.map(([k, label], i) => { const st = q.steps[k] || 'todo'; return (
          <div key={k} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span className={cn('flex size-8 items-center justify-center rounded-full border-2 text-[12px] font-extrabold', ST[st])}>{st === 'done' ? '✓' : st === 'bad' ? '✗' : i + 1}</span>
              <span className={cn('whitespace-nowrap text-[11px]', st === 'todo' ? 'text-ink-3' : 'font-semibold text-ink')}>{label}</span>
            </div>
            {i < steps.length - 1 && <i className={cn('mx-1 mb-5 h-[2px] flex-1', st === 'done' ? 'bg-ok' : 'bg-line-2')} />}
          </div>); })}
      </div>
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-auto">
        {steps.map(([k, label]) => { const st = q.steps[k]; if (!st) return null; const lines = q.lines[k] || []; return (
          <div key={k} className={cn('rounded-lg border border-line bg-panel-2 px-3 py-2', st === 'active' && 'border-l1/60', st === 'wait' && 'border-gate/60', st === 'bad' && 'border-bad/60', (k === 'judge' || k === 'reco') && 'col-span-2')}>
            <div className="flex items-center gap-2 text-[12px] font-bold">{label}{st === 'active' && <em className="text-[10.5px] font-semibold not-italic text-l1">진행 중</em>}{st === 'wait' && <em className="text-[10.5px] font-semibold not-italic text-gate">대기</em>}</div>
            {k === 'reco' && q.rec?.count != null && <div className="my-1 flex items-baseline gap-2"><b className="text-[30px] font-extrabold tracking-tight text-l1">{q.rec.count}매</b><span className="text-[12px] text-ink-3">Seasoning 웨이퍼 추천{q.rec.corrections.length ? ` · 교훈 ${q.rec.corrections.join(', ')} 적용` : ''}</span></div>}
            {k === 'judge' && q.judge && <div className="my-1"><JudgeTable j={q.judge} count={q.judgeCount} /></div>}
            {k === 'meas' && q.meas && <div className="my-1"><div className="h-2 overflow-hidden rounded-full bg-raise"><i className={cn('block h-full rounded-full bg-l1 transition-[width] duration-[2000ms]', (q.steps.meas === 'done' || q.judge) ? 'w-full' : q.meas.live ? 'w-full' : 'w-0')} /></div><div className="mt-1 text-[11.5px] text-ink-2">{q.meas.text}</div></div>}
            {lines.map((ln, i) => <div key={i} className={cn('text-[12px]', LN[ln.cls || ''] || 'text-ink-2')}>{ln.text}</div>)}
          </div>); })}
        {q.alerts.slice(-3).map((al, i) => <div key={i} className={cn('col-span-2 rounded-lg border px-3 py-2 text-[12px]', al.cls === 'warn' || al.cls === 'ask' ? 'border-warn/50 text-[#ffe9c6]' : al.cls === 'l2' ? 'border-l2/50 text-l2' : al.cls === 'ok' ? 'border-ok/50 text-ok' : 'border-line text-ink-2')}>{al.text}</div>)}
      </div>
    </div>
  );
}
