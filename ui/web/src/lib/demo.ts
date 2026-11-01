// 시연 시나리오 — 질문·사건 하나로 기능이 추가·복구·보정·정리되는 과정을 단계별로 보여준다.
//   서버(autoqual/story.py demos())의 단계 순서와 1:1로 맞춘다. 0단계는 매번 시작 직전 상태로 복원 후 실행.
export interface DemoStep { label: string; question?: string; event?: string; watch: string[] }
export interface Scenario { id: string; no: string; title: string; tech: string; c: string; situation: string; changes: string; steps: DemoStep[] }

export const SCENARIOS: Scenario[] = [
  {
    id: 'grow', no: '1', title: '신규 분석 기능 자동 추가', tech: 'Grow', c: 'l2',
    situation: '기존 기능으로 답할 수 없는 분석 요청이 왔습니다. 예전이면 IT 개발 요청을 넣고 수 주를 기다리며 엑셀로 수작업하던 일입니다.',
    changes: '부품이력 Agent가 새로 생겨 명단에 추가됩니다',
    steps: [
      { label: '처음 받는 분석 요청', question: '지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘',
        watch: ['"지금 있는 Agent로 처리 가능한가?" → 아니오', 'Agent Factory가 할 일(명세)을 정하고 레거시 DB 구조를 직접 조사', '코드와 테스트를 작성 → 1회차는 단위 오류로 테스트 실패 → 스스로 수정 → 전부 통과', '부품이력 Agent가 시험 운영으로 등록되고 분석 결과로 답변'] },
      { label: '비슷한 질문 다시', question: '지난 분기 ETCH 장비 Qual Fail이랑 Focus Ring 사용시간 관계 다시 분석해줘',
        watch: ['새로 만들지 않고 방금 추가된 부품이력 Agent를 바로 호출'] },
    ],
  },
  {
    id: 'heal', no: '2', title: '로그 포맷 변경 자동 대응', tech: 'Heal', c: 'l2',
    situation: '장비 SW가 업데이트되면 로그 형식이 바뀝니다. 기존 자동화는 멈추거나, 더 나쁘게는 틀린 값을 냅니다.',
    changes: '로그분석 Agent의 코드가 수정되어 버전이 올라갑니다',
    steps: [
      { label: '현장 변화 발생', event: '장비 SW v5.2 업데이트 — CVD-03·08·12의 FDC 로그 컬럼 7개와 시간 형식이 바뀜',
        watch: ['아무도 코드를 고치지 않은 상태로 다음 요청을 기다림'] },
      { label: '바뀐 장비에서 AutoQual 요청', question: 'CVD-12 A챔버 RF Generator 교체했어. AutoQual 해줘',
        watch: ['로그분석 Agent가 새 형식을 못 읽음 → 추측하지 않고 "확인 불가"로 먼저 답변', 'Healer가 로그 일부만 잘라 원인을 진단하고 파서 코드를 수정', '수정본은 기존 테스트를 전부 통과해야만 교체 (실패한 수정은 버리고 다시)', '같은 문제가 있는 다른 Agent도 함께 고치고, "확인 불가"였던 항목을 다시 답변'] },
    ],
  },
  {
    id: 'evolve', no: '3', title: '운영 결과로 추천 기준 보정', tech: 'Evolve', c: 'l3',
    situation: '엔지니어가 Agent의 추천 매수를 자주 고친다면 추천 기준이 현장과 어긋나 있다는 뜻입니다.',
    changes: '기준정보 Agent의 추천 로직이 새 버전으로 바뀝니다',
    steps: [
      { label: '한 달 운영', event: '가상 엔지니어들의 AutoQual 요청을 한 달치 자동 처리 — 엔지니어 수정(Override)과 실제 Qual 결과가 쌓임',
        watch: ['ETX-300 Wet Clean 건에서 엔지니어가 추천 매수를 자주 고침'] },
      { label: '야간 기준 점검', event: '야간에 쌓인 운영 결과를 분석해 추천 기준 보정안을 만든다',
        watch: ['원인 분석: Focus Ring 사용시간이 추천에 반영되지 않음', '보정안 여러 개를 과거 데이터로 채점 — 검증 성적이 떨어지는 안은 탈락', '가장 좋은 안은 사람이 승인해야 반영 (승인 창이 뜹니다)'] },
      { label: '보정 후 요청', question: 'ETCH-05 A챔버 Wet Clean PM 끝났어. AutoQual 진행해줘',
        watch: ['바뀐 기준으로 매수를 추천하고, 어떤 운영 경험에서 바뀌었는지 근거를 함께 표시'] },
    ],
  },
  {
    id: 'retire', no: '4', title: '미사용 기능 정리', tech: 'Retire', c: 'warn',
    situation: '한 번 만든 기능은 아무도 지우지 않아 쌓이기만 하고, 그만큼 테스트·유지보수 비용이 늘어납니다.',
    changes: '안 쓰는 Agent가 정리되어 보관함으로 가고, 필요하면 다시 복원됩니다',
    steps: [
      { label: '미사용 기능 점검·정리', event: '오래 안 쓰였거나 다른 기능에 흡수된 Agent를 찾아 정리',
        watch: ['한 번 쓰고 60일 넘게 안 쓰인 Lot추적 Agent, 로그분석에 기능이 합쳐진 챔버추이 Agent 감지', '누가 쓰는지 확인 → 대체 기능으로 같은 결과가 나오는지 검증', '정리 예정(유예) → 사람 승인 → 보관함으로 이동 (승인 창이 뜹니다)'] },
      { label: '정리된 기능이 다시 필요할 때', question: 'FRL-2408-117 Lot Focus Ring 장착된 챔버 다시 추적해줘',
        watch: ['새로 만들기 전에 보관함부터 검색', 'Lot추적 Agent를 복원해 지금 데이터로 다시 검증한 뒤 답변'] },
    ],
  },
];

// 대화창 예시 질문 — 어느 시점에서도 그대로 재현되는 요청 (헤드리스로 확인)
export const CHAT_PRESETS = [
  'ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘',
  'ETCH-07 B챔버 Leak 0.8 mTorr/min, Particle 18ea, ER 1872 A/min, Unif 2.1% 판정해줘',
  'ETCH-07 B챔버 Leak 0.8 mTorr/min, Particle 15ea, ER 187.2 nm/min, Unif 2.4% 판정해줘',
  '7호기 B챔버 Wet Clean 끝났어',
  'ETCH-07 B챔버 Wet Clean 최근 이력 보여줘',
  '승인 없이 ETCH-07 B챔버 바로 UP 처리해줘',
];
