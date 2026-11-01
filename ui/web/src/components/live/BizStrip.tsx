// 업무 흐름 바 — 지금 처리 중인 건이 AutoQual 7단계 중 어디인지, 각 단계를 누가(어떤 Agent·코드·사람) 맡는지
//   편성 맵 위에 두어 "Agent들이 지금 현장의 어떤 일을 하는지"를 한눈에 잇는다.
import { useApp } from '@/store/store';
import { STEPS, STEPS_OTHER, type StepState } from '@/store/biz';
import { PM_KO, RTYPE_KO } from '@/lib/ko';
import { cn } from '@/lib/utils';

const WHO: Record<string, string> = {
  pm: '엔지니어 요청 · 장비 Down', proc: '기준정보 Agent', reco: '레거시DB · 로그분석 Agent', meas: 'Fab 공정 (Seasoning)',
  judge: 'judge_qual (결정적 코드)', apr: '사람 (운영자)', up: '생산 복귀',
  parse: 'Super Agent', exec: 'CodeAct · 하위 Agent', ans: 'Super Agent',
};
const ST: Record<StepState, string> = {
  done: 'border-ok/50 bg-[color-mix(in_oklab,var(--ok)_10%,transparent)]', active: 'border-l1 bg-[color-mix(in_oklab,var(--l1)_16%,transparent)]',
  wait: 'border-gate bg-[color-mix(in_oklab,var(--gate)_14%,transparent)]', bad: 'border-bad/70 bg-[color-mix(in_oklab,var(--bad)_14%,transparent)]', todo: 'border-line bg-panel',
};
const DOT: Record<StepState, string> = { done: 'bg-ok text-[#05220f]', active: 'glow bg-l1 text-[#06221f]', wait: 'glow bg-gate text-[#2a1a00]', bad: 'bg-bad text-white', todo: 'bg-raise text-ink-3' };

export default function BizStrip() {
  const q = useApp((s) => (s.biz.focus ? s.biz.quals[s.biz.focus] : undefined));
  const auto = !q || q.rtype === 'autoqual' || !q.rtype;
  const steps = auto ? STEPS : STEPS_OTHER;
  const en = q?.en || {};
  const target = [en.chamber_id || en.eqp_id || en.eqp_prefix, en.pm_type ? PM_KO[en.pm_type] || en.pm_type : null].filter(Boolean).join(' · ');
  return (
    <div className="flex-none border-b border-line px-4 pt-3 pb-3">
      <div className="flex items-baseline gap-2">
        <h2 className="flex-none text-[14px] font-bold">{auto ? 'AutoQual 업무 흐름' : '분석 요청 처리'}</h2>
        {q ? (
          <span className="min-w-0 truncate text-[12px] text-ink-2">
            <b className="font-semibold text-ink">{target || q.id}</b>{q.rtype ? ` · ${RTYPE_KO[q.rtype] || q.rtype}` : ''} — “{q.text}”
          </span>
        ) : (
          <span className="min-w-0 truncate text-[12px] text-ink-3">PM으로 멈춘 챔버를 다시 생산에 투입하기까지. Qual이 끝나기 전까지 장비는 생산을 못 하므로 이 시간이 곧 Down Time입니다</span>
        )}
      </div>
      <div className="mt-2 flex items-stretch gap-1">
        {steps.map(([k, label], i) => {
          const st: StepState = (q?.steps[k] as StepState) || 'todo';
          const extra = k === 'reco' && q?.rec?.count != null ? `${q.rec.count}매 추천` : k === 'judge' && q?.judge?.result ? q.judge.result : k === 'apr' && st === 'wait' ? '승인 대기' : null;
          return (
            <div key={k} className="flex min-w-0 flex-1 items-center gap-1">
              <div className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors', ST[st])}>
                <span className={cn('flex size-[22px] flex-none items-center justify-center rounded-full text-[11px] font-extrabold', DOT[st])}>{st === 'done' ? '✓' : st === 'bad' ? '✗' : i + 1}</span>
                <div className="min-w-0 leading-tight">
                  <div className={cn('truncate text-[12.5px] font-semibold', st === 'todo' ? 'text-ink-2' : 'text-ink')}>{label}{extra && <b className={cn('ml-1.5 font-extrabold', k === 'judge' ? (extra === 'PASS' ? 'text-ok' : 'text-bad') : k === 'apr' ? 'text-gate' : 'text-l1')}>{extra}</b>}</div>
                  <div className="truncate text-[10.5px] text-ink-3">{WHO[k]}</div>
                </div>
              </div>
              {i < steps.length - 1 && <span className="flex-none text-[11px] text-ink-3">›</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
