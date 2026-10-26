// CodeAct 코드 뷰 — 라이브일 때는 타자 연출(속도 연동), diff면 +/- 하이라이트, 위에 생성→검사→실행 파이프라인.
import { useEffect, useRef, useState } from 'react';
import { diffClass, highlight } from '@/lib/format';
import { ms } from '@/store/store';
import { cn } from '@/lib/utils';

export const PIPE: Record<string, string[]> = {
  plan: ['LLM 코드 작성', 'AST 정적 검사', 'import 화이트리스트', '샌드박스 실행', '사후 검증'],
  diag: ['진단 코드 작성', 'AST 정적 검사', '로그 슬라이싱 실행', '원인 도출'],
  patch: ['패치 작성', 'AST·블랙리스트', '회귀 테스트', '버전 반영'],
  explore: ['탐색 코드 작성', 'AST 정적 검사', '읽기 전용 실행', '스키마 파악'],
  gen: ['Agent 코드 생성', 'AST 정적 검사', '자가·하네스 테스트', 'probation 등록'],
  evolve: ['변이 생성', '하네스 평가', '선택·승인', 'Registry 반영'],
};

export function Pipeline({ steps, done, bad, cur }: { steps: string[]; done?: number; bad?: boolean; cur?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      {steps.map((s, i) => {
        const isDone = done != null && i < done;
        const isCur = cur != null && i === cur;
        const isBad = bad && done != null && i === done - 1;
        return (
          <span key={s} className="flex items-center gap-1">
            {i > 0 && <span className="text-ink-3">→</span>}
            <span className={cn('inline-flex h-[22px] items-center gap-1.5 rounded-full border border-line px-2 text-ink-3', isDone && 'border-ok/40 bg-ok/10 text-ink', isCur && 'border-l1/60 bg-l1/10 text-ink', isBad && 'border-bad/60 bg-bad/10 text-ink')}>
              <i className={cn('flex size-3.5 items-center justify-center rounded-full bg-raise text-[9px] font-bold not-italic', isDone && 'bg-ok text-[#05220f]', isCur && 'bg-l1 text-[#05221f]', isBad && 'bg-bad text-white')}>{i + 1}</i>{s}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export default function CodeView({ code, diff, live, pipe, output, maxHeight = 320 }: { code: string; diff?: boolean; live?: boolean; pipe?: string; output?: string; maxHeight?: number }) {
  const [shown, setShown] = useState(live && !diff ? 0 : code.length);
  const ref = useRef<HTMLPreElement>(null);
  const [stage, setStage] = useState(live ? 1 : 99);
  useEffect(() => {
    if (!live || diff) { setShown(code.length); setStage(99); return; }
    setShown(0); setStage(1);
    const tick = Math.max(10, ms(22));
    if (!tick || !ms(1)) { setShown(code.length); setStage(99); return; }
    const stepN = Math.max(6, Math.ceil(code.length / 70));
    let i = 0;
    const t = setInterval(() => {
      i = Math.min(code.length, i + stepN);
      setShown(i);
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      if (i >= code.length) { clearInterval(t); setStage(3); }
    }, tick);
    return () => clearInterval(t);
  }, [code, live, diff]);
  const steps = pipe ? PIPE[pipe] || PIPE.plan : null;
  return (
    <div className="space-y-2">
      {steps && <Pipeline steps={steps} done={stage >= 99 ? steps.length : stage} cur={stage < 99 ? stage : undefined} />}
      {diff ? (
        <pre className="code" style={{ maxHeight }}>{code.split('\n').map((ln, i) => <div key={i} className={cn('dl', diffClass(ln))}>{ln || ' '}</div>)}</pre>
      ) : (
        <pre ref={ref} className="code" style={{ maxHeight }} dangerouslySetInnerHTML={{ __html: highlight(code.slice(0, shown)) + (shown < code.length ? '<span class="caret"></span>' : '') }} />
      )}
      {output && <div className="rounded-md bg-raise/60 px-3 py-2 font-mono text-[11px] text-ink-2"><b className="mr-1 text-ink">실행 결과</b>{output}</div>}
    </div>
  );
}
