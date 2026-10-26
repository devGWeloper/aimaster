// 한글 표시명 — Agent·상태·노드·루프 자막 (백엔드 id → 사람이 읽는 말)
import type { Lane } from './types';

export const AGENT_KO: Record<string, string> = {
  super_agent: 'Super Agent', spec_agent: '기준정보', log_agent: '로그분석', legacy_agent: '레거시DB',
  chamber_trend_agent: '챔버추이', part_history_agent: '부품이력', lot_trace_agent: 'Lot추적',
  legacy_sql_toolkit: 'SQL 툴킷', code_value_resolver: '코드값 해석', seasoning_pass_curve: 'Pass 곡선', fdc_toolkit: 'FDC 툴킷',
};
export const AGENT_DESC: Record<string, string> = {
  super_agent: '요청 해석 · Jev 편성 · CodeAct 계획', spec_agent: 'Qual 절차와 Spec 기준정보', log_agent: 'FDC 센서·알람 로그 분석', legacy_agent: '과거 Qual 이력 DB 조회',
  chamber_trend_agent: 'PM 사이클 간 추이', part_history_agent: '교체 부품 사용시간 분석', lot_trace_agent: '부품 Lot 장착 추적',
  legacy_sql_toolkit: '약어 컬럼·코드값 SQL', code_value_resolver: '미문서화 코드값 해석', seasoning_pass_curve: 'Seasoning 매수와 Pass 곡선', fdc_toolkit: 'SW 버전별 FDC 파서',
};
export const ACTOR_KO: Record<string, string> = { super_agent: 'Super Agent', healer: 'Healer', factory: 'Agent Factory', evolver: 'Evolver', jev: 'Jev', sandbox: 'Sandbox',
  judge: 'judge_qual', human: '사람(운영자)', fab: 'Mock Fab', memory: '경험 메모리', harness: '평가 하네스', registry: 'Registry', world: '장애 주입기' };
export const STATUS_KO: Record<string, string> = { active: '운영', probation: '시험 운영', deprecated: '폐기 유예', retired: '폐기', candidate: '후보' };
export const PM_KO: Record<string, string> = { WET_CLEAN: 'Wet Clean', RF_GEN_REPLACE: 'RF Generator 교체', SHOWERHEAD_REPLACE: 'Showerhead 교체', ESC_REPLACE: 'ESC 교체',
  TARGET_REPLACE: 'Target 교체', PUMP_PM: 'Pump PM', QUARTERLY_PM: '정기 PM(분기)', ALARM_RECOVERY: '알람 Down 복구' };
export const ITEM_KO: Record<string, string> = { PARTICLE: 'Particle', ER: 'Etch Rate', ER_UNIF: 'ER Uniformity', DR: 'Dep. Rate', THK_UNIF: 'THK Uniformity', RS_UNIF: 'Rs Uniformity',
  BASE_PRESSURE: 'Base Pressure', LEAK_RATE: 'Leak Rate' };
export const RTYPE_KO: Record<string, string> = { autoqual: 'PM 후 AutoQual', judge: 'Qual 판정', remeasure: '재측정 판정', history: '이력 분석', analysis: '신규 분석',
  trend: 'PM 사이클 추이', lot_trace: '부품 Lot 추적', reanswer: '추가 응답(복구 후)', rework: '재작업 계획', state: '장비 상태 변경', escalate: '에스컬레이션' };
export const KIND_KO: Record<string, string> = { state_change: '장비 상태 변경', promotion: 'Agent 정식 승격', evolution: '진화안 채택', retire: 'Agent 폐기 확정', policy: '평가 기준 변경' };
export const VKIND: Record<string, string> = { heal: 'Heal 패치', grow: 'Grow 생성', evolve: 'Evolve 채택', compose: '구성 변경', rollback: '자동 롤백', promote: '정식 승격',
  restore: '아카이브 복원', baseline: '초기 구축', deprecate: '폐기 유예', retire: '폐기 확정', grace_restart: '유예 재시작', defect: '결함 판정', shadow: 'Shadow' };
export const LANE_KO: Record<Lane | string, string> = { L1: 'L1 Task', HEAL: 'L2 Heal', GROW: 'L2 Grow', L3: 'L3 Evolve', OPS: '배경 운영', REPLAY: '리플레이', SYS: 'System' };
export const LANE_C: Record<string, string> = { L1: 'l1', HEAL: 'l2', GROW: 'l2', L3: 'l3', OPS: 'ink', REPLAY: 'l3', SYS: 'ink' };
export const HEAD_KO: Record<string, string> = { can_handle: '기존 Agent로 처리 가능한가', route: '어떤 Agent를 부를까', classify_error: '오류 유형은', need_evolve: '진화가 필요한가',
  need_merge: 'Agent를 병합할까', need_retire: '폐기할까', unrecoverable: '복구 불가인가', need_grow: '새 분석 Agent가 필요한가', template_match: '편성 템플릿을 쓸까', entity: '요청 장비는' };

export const NODE_KO: Record<string, string> = {
  parse_request: '요청 해석', retrieve_memory: '경험 메모리 조회', jev_route: 'Jev 편성', grow_subgraph: 'Grow 진입', plan_codeact: 'CodeAct 계획',
  execute_sandbox: '샌드박스 실행', observe: '관찰·사후 검증', mark_unavailable: '확인 불가 표시', synthesize: '결과 종합', respond: '응답',
  await_qual_result: 'Qual 결과 대기', deterministic_judge: '결정적 판정', rework_plan: '재작업 계획', approval_gate: '사람 승인',
  apply_state_change: '상태 반영', log_experience: '경험 기록', jev_classify_error: '오류 유형 분류', diagnose_codeact: '진단(CodeAct)',
  write_patch: '패치 작성', check_blacklist: '블랙리스트 확인', run_regression: '회귀 테스트', register_version: '버전 반영', blacklist_patch: '패치 기각',
  cascade: '연쇄 복구', reanswer_pending: '재응답', escalate_operator: '운영자 에스컬레이션', heal_history: 'Heal 이력 조회', start: '루프 진입',
  search_archive: '아카이브 검색', restore_genome: 'Genome 복원', write_spec: '명세 작성', explore_schema: '스키마 탐색',
  generate_code_and_tests: '코드·테스트 생성', run_tests: '테스트', register_probation: 'probation 등록', abort_with_reason: '생성 중단',
  collect_metrics: '지표 수집', jev_need_evolve: 'Jev 진화 판단', mutate: '변이 후보 생성', evaluate_harness: '하네스 평가', select: '선택',
  archive: '아카이브 보관', shadow_run: 'Shadow', promote: '승격', auto_rollback: '자동 롤백', jev_need_grow: 'Jev 신규 분석 판단',
  analyze_cause: '원인 분석', cluster_recheck: '미해결 군집 재분석', classify_override: 'Override 분류', jev_need_retire: 'Jev 폐기 판단',
  verify_replacement: '대체 검증', migrate_tests: '테스트 이관', replay_measure: '당시 측정값', compare_actual: '실제 결과 비교',
};

// 자막 — 노드마다 "지금 Agent가 무엇을 하는지" 한 문장 (주어는 항상 행위자)
export const SAY: Record<string, string> = {
  parse_request: 'Super Agent가 요청에서 장비·챔버·PM 종류를 읽어냅니다',
  retrieve_memory: '과거 경험(교훈·유사 사례·편성 템플릿)을 꺼내 옵니다',
  jev_route: 'Jev가 어떤 Agent를 부를지 확률로 판단합니다',
  grow_subgraph: '기존 Agent로는 처리할 수 없습니다. Grow 루프로 내려갑니다',
  plan_codeact: 'Super Agent가 실행 계획을 Python 코드로 작성합니다 (CodeAct)',
  rework_plan: 'Qual Fail. 재작업 계획을 다시 세웁니다',
  execute_sandbox: '작성한 코드를 샌드박스에서 실행해 하위 Agent들을 호출합니다',
  observe: '실행 결과를 사후 검증합니다',
  mark_unavailable: '검증에 실패한 항목은 추측하지 않고 "확인 불가"로 표시합니다',
  synthesize: '결과를 종합해 추천안을 만듭니다',
  respond: '엔지니어에게 응답합니다',
  await_qual_result: 'Mock Fab에서 Seasoning·Qual 측정 결과를 기다립니다',
  replay_measure: '리플레이: 당시 실제 측정값을 불러옵니다',
  deterministic_judge: 'Pass/Fail은 LLM이 아니라 결정적 코드 judge_qual이 판정합니다',
  compare_actual: '추천·판정을 당시 실제 결과와 비교해 채점합니다',
  approval_gate: '장비 Up은 Jev 확신도와 무관하게 반드시 사람이 승인합니다',
  apply_state_change: '승인된 장비 상태 변경을 반영합니다',
  log_experience: '이번 결과를 경험 메모리에 기록합니다. 다음 요청과 진화의 재료가 됩니다',
  'HEAL:start': '오류 감지. L2 Heal 루프에 진입합니다',
  jev_classify_error: 'Jev가 오류 유형을 분류합니다 (코드 결함 / 외부 장애)',
  heal_history: '같은 오류를 고친 적이 있는지 Heal 이력을 찾아봅니다',
  diagnose_codeact: 'Healer가 진단 코드로 로그를 슬라이싱해 원인을 찾습니다',
  write_patch: 'Healer가 Agent의 소스 코드를 직접 고칩니다',
  check_blacklist: '이미 실패했던 패치인지 블랙리스트(AST 해시)로 확인합니다',
  blacklist_patch: '패치 실패. 블랙리스트에 올리고 다른 패치를 다시 시도합니다',
  run_regression: '회귀 테스트로 패치가 기존 기능을 깨지 않는지 검증합니다',
  register_version: '테스트를 통과한 패치를 새 버전으로 교체합니다',
  cascade: '같은 문제를 가진 다른 Agent도 연쇄 복구합니다',
  reanswer_pending: '"확인 불가"였던 항목을 다시 분석해 답합니다',
  escalate_operator: '복구 불가. 예산 안에서 멈추고 사람에게 넘깁니다',
  'GROW:start': '처음 보는 요청. Agent Factory가 새 Agent를 만들기 시작합니다',
  search_archive: '진화 아카이브에 재사용할 수 있는 Genome이 있는지 찾습니다',
  restore_genome: '아카이브의 Genome을 복원해 현재 스키마로 다시 시험합니다',
  write_spec: '새 Agent의 명세(역할·입출력)를 작성합니다',
  explore_schema: '탐색 코드로 레거시 스키마·코드값 분포·결측·경계일을 파악합니다',
  generate_code_and_tests: '새 Agent의 코드와 테스트(정상 + 엣지 케이스)를 생성합니다',
  run_tests: '생성한 Agent를 정상·엣지 케이스 + 하네스 불변식으로 검증합니다',
  register_probation: '새 Agent를 probation(시험 운영)으로 등록하고 L1로 복귀합니다',
  abort_with_reason: '생성 중단. 예산 초과 또는 불가 사유를 기록합니다',
  collect_metrics: 'Registry·경험 메모리에서 성능 지표를 모읍니다',
  analyze_cause: '원인 분석 코드를 실행해 실패 패턴을 찾습니다',
  cluster_recheck: '리플레이 때 풀지 못한 군집을 다시 분석합니다',
  classify_override: '엔지니어 Override 중 결과로 뒷받침된 것만 학습에 씁니다',
  jev_need_evolve: 'Jev가 진화가 필요한지 판단합니다',
  jev_need_grow: 'Jev가 새 분석 Agent가 필요한지 판단합니다',
  jev_need_retire: 'Jev가 폐기할 Agent가 있는지 판단합니다',
  jev_need_merge: 'Jev가 Agent 병합이 필요한지 판단합니다',
  mutate: '변이 후보(파라미터·스킬·코드·구성)를 만듭니다',
  evaluate_harness: '루프 밖에 고정된 평가 하네스로 후보를 채점합니다',
  verify_replacement: '폐기 대상의 기능을 대체 Agent가 처리하는지 검증합니다',
  migrate_tests: '폐기 대상의 테스트를 대체 Agent로 이관합니다',
  select: '가장 좋은 후보를 고르고 사람 승인을 요청합니다',
  archive: '채택·기각 후보를 모두 아카이브에 보관합니다',
  shadow_run: '새 버전을 Shadow로 병행 실행해 구 버전과 결과를 비교합니다',
  promote: '검증을 통과한 새 버전을 운영에 승격합니다',
  auto_rollback: 'Shadow 불일치. 관련 Agent를 원자적으로 자동 롤백합니다',
};

export const BAD: Record<string, RegExp> = {
  observe: /확인 불가/, mark_unavailable: /./, run_regression: /재현 테스트 실패|— 실패/, run_tests: /실패/, check_blacklist: /일치/,
  blacklist_patch: /./, escalate_operator: /./, abort_with_reason: /./, auto_rollback: /./, evaluate_harness: /— 실패/,
};

export const short = (id: unknown) => String(id || '').replace(/_agent$/, '');
export const agentKo = (id: unknown) => AGENT_KO[String(id)] || short(id);
export const actorKo = (id: unknown) => ACTOR_KO[String(id)] || AGENT_KO[String(id)] || short(id);

export const LAYERS = [
  ['①', '파라미터·교훈', 'Jev 임계값 · Seasoning 보정 계수 · 교훈 세트'],
  ['②', '스킬', '성공한 CodeAct를 공용 함수로 추출'],
  ['③', 'Agent 코드', '파서 · SQL · 판정 로직 패치'],
  ['④', 'Agent 구성', '생성 · 병합 · 분리 · 폐기'],
  ['⑤', '편성 전략', 'Super Agent 호출 규칙 · 템플릿 · 임계값'],
] as const;
export const layerNo = (s: unknown) => { const m = /[①②③④⑤]/.exec(String(s || '')); return m ? '①②③④⑤'.indexOf(m[0]) : -1; };

export const RUN_KIND: Record<string, string> = { 'E-': '판단 진화 (운영 결과 학습)', 'V-': '구조 진화 (중복·성능)', 'O-': '편성 전략 진화', 'R-': 'Agent 폐기 검토', 'RB-': '승격 후 Shadow 점검',
  'Q-': '분기 진화 (리플레이 Walk-forward)' };
export function runTitle(id: string) {
  const k = Object.keys(RUN_KIND).find((p) => String(id).startsWith(p));
  return `L3 Evolve ${id}${k ? ` — ${RUN_KIND[k]}` : ''}`;
}
