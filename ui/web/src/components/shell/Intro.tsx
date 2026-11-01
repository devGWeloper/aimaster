// 업무 소개 — "이 Agent는 무엇을 하나요?" AutoQual 업무·문제(As-Is)·Agent가 하는 일(To-Be)·Self-Evolving이 필요한 이유·핵심 차별 기술·안전장치·목표 KPI·화면 보는 법
//   처음 접속 시 한 번 자동으로 열리고, 상단 바 버튼으로 언제든 다시 연다. 목표 수치는 기획서(가상 Fab 기준 추정), 실측 수치는 E2E 문서 그대로.
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useApp } from '@/store/store';
import { cn } from '@/lib/utils';

const FLOW: [string, string, string][] = [
  ['PM 완료', '장비 Down', 'bad'], ['Qual 절차 확인', '어떤 항목·Spec?', 'l1'], ['Seasoning 매수 결정', '몇 장 돌릴까?', 'l1'], ['Seasoning · 측정', '약 2.5시간', 'ink'],
  ['Spec 판정', 'Pass / Fail', 'ok'], ['사람 승인', 'Up 결정', 'gate'], ['생산 복귀', '장비 Up', 'ok'],
];
const ASIS: [string, string, string][] = [
  ['Qual 준비', '기준정보 시스템에서 절차서·Spec·Seasoning 레시피 조회', '20~30분'],
  ['챔버 상태 확인', 'FDC 화면에서 PM 전후 센서 트레이스를 눈으로 비교', '30분'],
  ['과거 이력 확인', '약어 컬럼·미문서화 코드값투성이 레거시 DB 조회, 선임에게 문의', '30~60분'],
  ['Seasoning 매수 결정', '경험과 감. 같은 챔버·같은 PM에도 엔지니어별 25~45매 편차', '—'],
  ['1차 Fail 시', '원인 재분석 + 재Seasoning·재측정', '+3~4시간'],
];
const AGENTS: [string, string, string, string][] = [
  ['Super Agent', '지휘자', '요청을 해석하고 필요한 Agent를 골라 부른 뒤, 결과를 모아 추천안으로 답합니다', '요청 · 경험 메모리'],
  ['기준정보 Agent', 'spec_agent', '이 PM 뒤 어떤 Qual 항목·Spec·Seasoning 기준을 따라야 하는지 찾습니다', '기준정보 시스템'],
  ['로그분석 Agent', 'log_agent', 'PM 뒤 챔버 센서·알람이 정상인지, 위험 신호가 있는지 봅니다', 'FDC 센서 · 알람 로그'],
  ['레거시DB Agent', 'legacy_agent', '같은 챔버·PM에서 과거 몇 매로 통과했는지, 어떤 Fail이 반복됐는지 찾습니다', '레거시 Qual 이력 DB'],
];
const EVOLVE: [string, string, string, string][] = [
  ['신규 분석 기능 자동 추가', 'Grow', '"Fail이 부품 사용시간과 관계있나?" 같은 기존 기능 밖 질문 → IT 개발 수 주 대신 수 분 안에 새 Agent 생성', 'l2'],
  ['로그 포맷 변경 자동 대응', 'Heal', '장비 SW 업데이트로 로그 포맷이 바뀌면 추측 대신 "확인 불가" → 자기 파서 코드를 패치하고 테스트 후 교체', 'l2'],
  ['운영 결과로 추천 기준 보정', 'Evolve', '3년치 이력과 운영 결과·엔지니어 수정을 학습해 Seasoning 판단·편성 전략을 개선. 검증셋이 떨어지면 채택 안 함', 'l3'],
  ['미사용 기능 정리', 'Retire', '쓰이지 않거나 대체된 Agent를 대체 검증 → 유예 → 사람 승인 → 아카이브 보관 순으로 폐기', 'l3'],
];
const EDGE: [string, string, string, string][] = [
  ['Zero-Hallucination 메모리', 'RAG를 전략적으로 배제', 'AutoQual은 판단 하나가 장비 Up·Lot Scrap으로 이어져 환각을 허용할 수 없습니다. 유사도 검색 대신 장비·챔버·PM·시점 키로 정확히 DB를 조회하고, 추천마다 교훈 ID·원천 이력 건수를 인용합니다.', '같은 질문 = 같은 근거 · 근거마다 원천 이력 인용'],
  ['적대적 자율 검증', 'Grow Loop Edge 검증', '새 Agent를 만들면 자기 코드를 공격하는 엣지 케이스(미등록 코드·단위 혼재·경계일·결측)를 스스로 도출해 검증하고, 걸리면 스스로 고쳐 재검증한 뒤에만 투입합니다. 사람 리뷰 없이 도는 자율형 CI/CD.', 'SC-002: 1회차 단위 오류(60배 과대) 자가 수정 → 14/14 통과'],
  ['Walk-forward 사전 검증', '운영 전 3,000건으로 미리 검증', '과거 3년 이력을 시간순으로 재생하며 분기마다 진화 → 다음 분기로 검증. Time-Travel Guard가 미래 데이터 참조를 차단해 과적합 없이 성능을 올립니다.', 'Held-out 판정 일치율 65.6% → 85.0% · 미래 누출 0건'],
];
const SAFE = ['장비 Up(상태 변경)은 반드시 사람 승인 — 무승인 변경 0건', 'Spec Pass/Fail은 LLM이 아니라 결정적 코드(judge_qual)가 판정', 'Agent가 쓴 코드는 샌드박스에서만 실행 (읽기 전용·감사 로그)', '평가 기준·예산은 루프가 못 바꾸는 곳에 고정, 이상 시 자동 롤백'];
const KPI: [string, string][] = [['Qual 1차 Pass율', '+15%p'], ['판단 준비 시간', '70%↓'], ['판정 일치율', '95%'], ['자가 복구율 · MTTR', '70% · 10분'], ['새 Agent 생성 성공률', '70%'], ['무승인 상태 변경', '0건']];
const SCREEN: [string, string][] = [
  ['시연 화면', '시나리오 4개를 단계별로 — 질문 하나로 기능이 추가·수정·보정·정리되는 과정과 Agent 명단 변화'],
  ['라이브 왼쪽', '지금 Agent가 하는 일을 한 문장으로 · 어느 루프의 몇 번째 단계인지 · 행동 일지'],
  ['라이브 가운데 위', '지금 건이 AutoQual 7단계 중 어디인지, 그 단계를 누가 맡는지'],
  ['라이브 가운데', 'Agent 편성 맵 — 누구를 부르고 무엇을 가져오는지, 어떤 기능이 추가·수정·정리되는지'],
  ['라이브 가운데 아래', '방금 일어난 일 자세히 — Agent가 쓴 코드, 확률 판단, 판정 표, 승인'],
  ['라이브 오른쪽', '엔지니어 대화 — 직접 요청해 볼 수도 있습니다'],
];

export default function Intro() {
  const open = useApp((s) => s.intro);
  const setIntro = useApp((s) => s.setIntro);
  const go = useApp((s) => s.go);
  return (
    <Dialog open={open} onOpenChange={(o) => setIntro(o)}>
      <DialogContent className="max-h-[90vh] w-[min(1120px,calc(100%-2rem))] max-w-none overflow-y-auto border border-line bg-panel p-6 sm:max-w-none">
        <DialogHeader>
          <div className="text-[12px] font-semibold text-l1">AutoQual Self-Evolving Agent</div>
          <DialogTitle className="text-[24px] font-extrabold leading-tight tracking-tight">PM으로 멈춘 반도체 장비를 다시 생산에 투입하기까지의 <span className="text-l1">판단</span>을 대신하는 Agent</DialogTitle>
          <DialogDescription className="text-[13.5px] leading-relaxed text-ink-2">
            엔지니어가 "ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘" 한 줄만 쓰면, Agent들이 기준정보·센서 로그·과거 이력을 직접 뒤져 <b className="text-ink">Seasoning 웨이퍼를 몇 장 돌릴지</b> 근거와 함께 추천하고,
            측정 결과를 Spec과 비교해 판정한 뒤, 사람 승인을 받아 장비를 Up시킵니다. 그리고 이 과정에서 <b className="text-ink">스스로 기능을 만들고, 고치고, 진화</b>합니다.
          </DialogDescription>
        </DialogHeader>

        {/* AutoQual 업무 흐름 */}
        <Block n="1" title="AutoQual이란" sub="Qual이 끝나기 전까지 장비는 생산을 못 합니다. AutoQual 소요시간 = 장비 Down Time">
          <div className="flex items-stretch gap-1">
            {FLOW.map(([t, d, c], i) => (
              <div key={t} className="flex flex-1 items-center gap-1">
                <div className={cn(`lane-${c} flex-1 rounded-lg border border-[color-mix(in_oklab,var(--c)_45%,var(--line))] bg-[color-mix(in_oklab,var(--c)_8%,transparent)] px-2.5 py-2`)}>
                  <div className="text-[12.5px] font-bold text-ink">{t}</div>
                  <div className="text-[11px] text-ink-3">{d}</div>
                </div>
                {i < FLOW.length - 1 && <span className="text-ink-3">›</span>}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-ink-3">가상 Fab 기준: 장비 30대 · 챔버 90개 · PM 8종 → 연 약 1,000건의 AutoQual</p>
        </Block>

        <div className="grid grid-cols-2 gap-4">
          {/* As-Is */}
          <Block n="2" title="지금은 (As-Is)" sub="엔지니어가 세 시스템을 직접 오가며 경험으로 판단">
            <div className="divide-y divide-line rounded-lg border border-line">
              {ASIS.map(([k, d, t]) => (
                <div key={k} className="flex items-baseline gap-3 px-3 py-1.5">
                  <span className="w-[120px] flex-none text-[12.5px] font-semibold text-ink">{k}</span>
                  <span className="min-w-0 flex-1 text-[12px] text-ink-2">{d}</span>
                  <span className={cn('flex-none font-mono text-[12px]', t.startsWith('+') ? 'text-bad' : 'text-ink-2')}>{t}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 rounded-lg bg-[color-mix(in_oklab,var(--bad)_12%,transparent)] px-3 py-2 text-[12.5px] leading-snug text-[#ffd6d4]">
              꼭 필요한 공정은 약 2.5시간인데 판단 준비와 1차 Fail 재작업이 붙어 7~8시간. <b>Down Time의 절반 이상이 장비가 아니라 '판단'에서 생깁니다.</b>
            </p>
          </Block>

          {/* To-Be */}
          <Block n="3" title="Agent가 하면 (To-Be)" sub="세 시스템을 Agent 하나씩 맡고, Super Agent가 지휘">
            <div className="space-y-1.5">
              {AGENTS.map(([n, id, d, src]) => (
                <div key={n} className="rounded-lg border border-line bg-panel-2 px-3 py-1.5">
                  <div className="flex items-baseline gap-2"><b className="text-[13px]">{n}</b><span className="font-mono text-[10.5px] text-ink-3">{id}</span><span className="ml-auto rounded-sm bg-raise px-1.5 text-[10.5px] text-ink-2">{src}</span></div>
                  <div className="text-[12px] text-ink-2">{d}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-ink-3">모든 Agent는 JSON 툴 호출이 아니라 Python 코드를 직접 써서 실행합니다(CodeAct). 그래서 기능을 고르는 데서 그치지 않고 직접 만들고 고칠 수 있습니다.</p>
          </Block>
        </div>

        {/* Self-Evolving */}
        <Block n="4" title="Agent가 스스로 바뀌는 네 가지 경우" sub="현장은 계속 바뀝니다. 사람이 만든 기능만 수행하는 자동화는 새 질문엔 멈추고, 데이터 형식이 바뀌면 조용히 깨지거나 틀립니다">
          <div className="grid grid-cols-4 gap-2">
            {EVOLVE.map(([k, t, d, c]) => (
              <div key={k} className={cn(`lane-${c} rounded-lg border border-[color-mix(in_oklab,var(--c)_45%,var(--line))] bg-panel-2 px-3 py-2`)}>
                <div className="text-[14px] font-extrabold text-[var(--c)]">{k}</div>
                <div className="font-mono text-[10.5px] text-ink-3">{t}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-ink-2">{d}</div>
              </div>
            ))}
          </div>
        </Block>

        {/* 핵심 차별 기술 */}
        <Block n="5" title="핵심 차별 기술" sub="정확해야 하는 현장에서 자율 Agent를 믿고 쓸 수 있게 만드는 세 가지 설계">
          <div className="grid grid-cols-3 gap-2">
            {EDGE.map(([k, t, d, proof]) => (
              <div key={k} className="flex flex-col rounded-lg border border-l1/40 bg-[color-mix(in_oklab,var(--l1)_6%,transparent)] px-3 py-2.5">
                <div className="text-[15px] font-extrabold text-l1">{k}</div>
                <div className="text-[12.5px] font-semibold text-ink">{t}</div>
                <div className="mt-1 flex-1 text-[11.5px] leading-snug text-ink-2">{d}</div>
                <div className="mt-2 rounded-md bg-bg/60 px-2 py-1 font-mono text-[11px] text-ok">{proof}</div>
              </div>
            ))}
          </div>
        </Block>

        <div className="grid grid-cols-[1.1fr_1fr] gap-4">
          <Block n="6" title="안전장치" sub="자율성은 높이되, 위험한 결정은 사람과 결정적 코드에">
            <ul className="space-y-1">{SAFE.map((x) => <li key={x} className="flex gap-2 text-[12.5px] text-ink-2"><span className="text-gate">■</span>{x}</li>)}</ul>
          </Block>
          <Block n="7" title="목표 KPI" sub="기획서 기준 (가상 Fab 추정)">
            <div className="grid grid-cols-3 gap-1.5">
              {KPI.map(([k, v]) => <div key={k} className="rounded-lg border border-line bg-panel-2 px-2.5 py-1.5"><div className="text-[10.5px] text-ink-3">{k}</div><div className="font-mono text-[16px] font-bold text-l1">{v}</div></div>)}
            </div>
          </Block>
        </div>

        <Block n="8" title="화면 보는 법" sub="Autopilot을 누르면 시나리오(SC-006 → SC-009)가 실제 메커니즘으로 순서대로 실행됩니다">
          <div className="grid grid-cols-3 gap-2">
            {SCREEN.map(([k, d]) => <div key={k} className="rounded-lg border border-line px-3 py-2"><div className="text-[12.5px] font-bold">{k}</div><div className="text-[11.5px] leading-snug text-ink-2">{d}</div></div>)}
          </div>
        </Block>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setIntro(false)}>닫기</Button>
          <Button onClick={() => { setIntro(false); go('demo'); }}>시연 화면으로</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Block({ n, title, sub, children }: { n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="flex size-5 flex-none items-center justify-center rounded-full bg-raise text-[11px] font-bold text-ink-2">{n}</span>
        <h3 className="text-[15px] font-bold">{title}</h3>
        {sub && <span className="text-[12px] text-ink-3">{sub}</span>}
      </div>
      {children}
    </section>
  );
}
