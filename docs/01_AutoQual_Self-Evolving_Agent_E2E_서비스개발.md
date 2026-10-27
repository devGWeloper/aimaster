## 1. 최종 아키텍처 요약

* **완성된 아키텍처 핵심:** LangGraph 기반 **3중 루프 멀티 에이전트**(L1 Task · L2 Heal/Grow · L3 Evolve)가 CodeAct(Python 코드를 행동으로 샌드박스 실행)로 AutoQual 업무를 수행하고, 운영 중 쌓인 경험·3년치 이력 리플레이로 **Agent 자체(코드·스킬·구성·편성 전략)를 스스로 진화**시키는 파이프라인 완성. 분기 판단은 Jev(보정 확률), Spec 판정은 결정적 코드(`judge_qual`), 장비 상태 변경·승격·진화안·폐기는 사람 승인 게이트를 거친다.

* **최종 산출물 형태:** 웹 운영 콘솔 — FastAPI + SSE 백엔드(`ui/server.py`)가 Agent의 모든 사고·행동 이벤트를 실시간 송출하고, React 19 + Vite + Tailwind v4 + shadcn/ui + React Flow로 만든 SPA(`ui/web`, 빌드 결과물 `ui/web/dist`를 FastAPI가 서빙)가 6개 화면으로 보여준다. Mock Fab(장비 30대·챔버 90개·PM 8종·Qual 이력 3,000건/3년, 장애 주입기 포함)이 데이터 서버·MES 역할을 한다.

  | 화면 | 보여주는 것 |
  | --- | --- |
  | **라이브** (기본) | 왼쪽: "지금 Agent가 하는 일" 큰 자막 · 현재 루프 스테퍼 · Agentic 지표 · 행동 일지 / 가운데: Agent 편성 맵(호출 펄스, 각 Agent가 가져온 값 칩, 생성·치유·진화·폐기 연출) + 포커스 카드(CodeAct 코드 타자, Jev 확률 막대, judge_qual 판정 표, 승인, 응답, diff, 테스트) / 오른쪽: 엔지니어 대화 |
  | **루프** | 3중 루프 다이어그램(토큰이 실제 LangGraph 노드를 따라 이동, 루프 사이 연결이 빛남, L2 예산 게이지) + 실행 트레이스(런 단위 span: 코드·확률·값·도구 원장·판정·diff) |
  | **진화** | 진화 사이클 5단계(감지 → 변이 후보 → 하네스 평가 → 선택·승인 → 반영·보관)와 진행 중인 런, 진화 사건 피드(Grow·Heal·Evolve·롤백·폐기 리포트), Genome 계보, 이력 리플레이 곡선·Held-out 평가, 5계층·아카이브 |
  | **Agent** | Registry 카드 → Genome 코드(버전별)·프롬프트·도구·Lineage·테스트 드로어 |
  | **승인** | 대기 중 승인(장비 Up·승격·진화안·폐기)과 이력, 무승인 변경 0건 |
  | **Fab·KPI** | AutoQual 7단계 스테퍼(PM 완료 → Qual 절차 → 매수 추천 → Seasoning·측정 → Spec 판정 → 사람 승인 → UP), 90챔버 현황, Agent가 처리한 Qual 이력, KPI 16종 |

* **Agent 구조:**

  ```
  엔지니어 요청 ──▶ Super Agent (super_agent)
                     ├─ parse_request → retrieve_memory(경험 메모리) → jev_route(Jev 편성) → plan_codeact(실행 계획 코드)
                     ├─ execute_sandbox ──▶ spec_agent(기준정보) · log_agent(로그분석) · legacy_agent(레거시DB)
                     │                     · part_history_agent / lot_trace_agent / chamber_trend_agent (Grow로 생성)
                     │                     · 공용 스킬: legacy_sql_toolkit · code_value_resolver · seasoning_pass_curve · fdc_toolkit
                     ├─ observe(사후 검증) → 확인 불가 ──▶ L2 Heal (Healer: Jev 분류 → 진단 CodeAct → 패치 → 회귀 테스트 → 버전 반영 · 연쇄 복구)
                     ├─ 처리 불가 ──▶ L2 Grow (Agent Factory: 아카이브 검색 → 명세 → 스키마 탐색 → 코드·테스트 생성 → probation 등록)
                     ├─ synthesize → respond → await_qual_result(Mock Fab 측정, interrupt) → deterministic_judge(judge_qual)
                     └─ approval_gate(사람 승인, interrupt) → apply_state_change(Down→Up) → log_experience(경험 메모리)
  경험 메모리·Registry 지표 ──▶ L3 Evolve (Evolver/OpsEvolver: 지표 수집 → Jev 판단 → 변이 후보(5계층) → 루프 밖 하네스 평가
                                 → 선택·사람 승인 → 아카이브 → Shadow 병행 → 승격 / 자동 롤백) ──▶ 새 버전이 L1에 배포
  과거 Qual 이력 3,000건 ──▶ ReplayEngine (Walk-forward 분기 진화, 최근 6개월 Held-out, Time-Travel Guard)
  외부 시스템(목업): 기준정보 DB · FDC 트레이스/알람 로그 · 레거시 Qual 이력 DB(읽기 전용) · Mock Fab/MES · 장애 주입기
  ```

  프론트엔드는 SSE 이벤트(`node`·`jev`·`code`·`agent_start/agent_end`·`judge`·`approval`·`version`·`candidate`·`report` 등 30여 종)를 Zustand 슬라이스(live·chat·trace·biz·evolve)로 접어 넣고, 연출(펄스·칩·토큰 이동)은 별도 허브로 분리해 새로고침 후에도 백로그로 화면을 재구성한다.

## 2. KPI 달성도 (Plan vs Actual)

Autopilot 타임라인(초기 구축 → SC-006 리플레이 → SC-001~005·007~009, 가상 시각 2026-07 ~ 2026-12)을 오프라인 Playbook 모드로 완주한 뒤 `eval/kpi.py`(루프가 접근할 수 없는 고정 코드)가 저장소·하네스 기록에서 계산한 값이다. 운영 UI 「Fab·KPI」 화면과 `/api/kpi`에서 같은 값을 볼 수 있다.

| **평가 지표 (KPI)** | **목표 수치 (Task 2)** | **실제 달성 수치** | **달성 여부 및 비고** |
| --- | --- | --- | --- |
| **Qual 준비·판정 소요시간** | 70% 이상 단축 | **95.0% 단축** (Agent 판단 준비 12.1s + 검토 5분 vs 수작업 105분, 요청 320건) | 초과 달성 (CodeAct 병렬 호출 + 경험 메모리 즉시 추천) |
| **AutoQual 판정 정확도** | 95% 이상 | **100%** (Held-out 494건 Pass/Fail 판정 일치, 결정적 `judge_qual`) | 목표 달성 (1차 Pass 예측까지 포함한 종합 일치율 85.0%) |
| **Agent 자동 생성 성공률** | 70% 이상 | **100%** (미지원 요청 3건 중 3건 생성·테스트 통과: chamber_trend · part_history · lot_trace) | 초과 달성 (스키마 탐색 기반 엣지 케이스 테스트 포함) |
| **오류 자가 복구율** | 70% 이상 | **71.4%** (장애 영향 Agent 7건 중 자동 복구 5건, 연쇄 복구 1건 포함) | 목표 달성 (복구 불가 2건은 예산 안에서 조기 중단 → 운영자 에스컬레이션, 분모 포함) |
| **평균 복구 시간(MTTR)** | 10분 이내 | **4.1분** (장애 감지 → 패치 반영, 가상 시각) | 목표 달성 |
| **진화 후 구조 개선** | 코드 중복률 50%↓, 응답시간 30%↓ | **중복 39% → 0% (100%↓)**, **log_agent p50 8.8s → 4.0s (55%↓)** | 초과 달성 (fdc_toolkit 추출 + 트레이스 로딩 캐시, Shadow 24h 통과 후 승격) |
| **이력 리플레이 진화 효과** | 판정 일치율 +15%p | **+19.4%p** (Held-out 65.59% → 85.02%) | 초과 달성 (10개 분기 Walk-forward 진화) |
| **미래 정보 누출** | 0건 | **0건** (Time-Travel Guard 필터·차단 17,857건) | 목표 달성 |
| **Qual 1차 Pass율** | 진화 전 대비 +15%p | **+15.2%p** (Held-out 백테스트 71.46% → 86.64%; 리플레이 직후 83.81% → SC-007 판단 진화 후 86.64%) | 목표 달성 |
| **엔지니어 Override율** | 50% 감소 | **81% 감소** (ETX-300 Wet Clean 25% → 5%, 판단 진화 전후) | 초과 달성 |
| **Agent 호출 효율** | 요청당 호출 Agent 20%↓ | **21%↓** (2.9 → 2.3, super_agent 1.1.0 → 1.2.0 편성 전략 진화) | 목표 달성 |
| **불필요 Agent 정리** | 월말 잔존 0개, 폐기로 인한 요청 실패 0건 | **잔존 0개** (retired 2개 · 보류 1개 사유 기록), **요청 실패 0건** (유예 중 리다이렉트 실패는 Fallback) | 목표 달성 |
| **진화 퇴화** | 0건 | **0건** (채택 15건 중 Held-out 하락 0건; 승격 후 Shadow 불일치는 자동 롤백 1건으로 차단) | 목표 달성 |
| **루프 폭주** | 0건 | **0건** (L2 루프 6회, 예산 5회·15분 초과 없음) | 목표 달성 |
| **무승인 장비 상태 변경** | 0건 | **0건** (장비 상태 변경 요청 320건 전부 승인 패널 경유) | 목표 달성 |

16개 지표 중 16개 달성. 수치는 시드 고정 목업과 오프라인 Playbook(결정적 재현) 기준이며, 사내 LLM API 연동 시 재측정이 필요하다.

## 3. 창출된 핵심 가치

### 3-1. 비즈니스 가치

* *PM 후 Qual 판단 준비가 건당 1.5~2시간에서 수 초 + 검토 5분으로 줄어, 설비 엔지니어는 근거를 검토하고 승인하는 일에만 집중한다*

* *이력 리플레이로 운영 투입 전에 과거 3년 경험을 미리 학습해 첫날부터 Held-out 판정 일치율 85%로 시작하고, 운영 중에는 실제 Qual 결과·Override 사유를 학습해 1차 Pass율이 계속 오른다(+15.2%p, Override율 81% 감소)*

* *로그 포맷 변경·DB 이관 같은 "현실의 변화"에 사람이 코드를 고치기 전에 Agent가 스스로 복구(MTTR 4.1분)하고, 처음 보는 분석 요청은 새 Agent를 만들어 응답하므로 개발 요청 대기열이 사라진다*

* *불필요해진 Agent를 유예·대체 검증·승인 절차로 정리해 기능이 쌓이기만 하는 운영 부담을 막는다*

### 3-2. 기술적 가치

* *CodeAct 멀티 에이전트: 함수 호출 JSON이 아니라 Agent가 작성한 Python 코드가 행동 단위가 되어 Agent 생성·자기 수정이 가능해졌고, 샌드박스(허용 import 화이트리스트·AST 정적 검사·권한 프록시·감사 로그)로 안전하게 실행된다*

* *Self-Evolving 5계층(파라미터·교훈 → 스킬 → Agent 코드 → Agent 구성 → 편성 전략)을 변이 → 루프 밖 하네스 평가 → 선택 → 아카이브 → Shadow → 승격/롤백 사이클로 구현하고 Genome Lineage로 전 이력을 추적한다*

* *Loop Engineering: L1/L2/L3 루프마다 트리거·종료 조건·예산(5회·15분)·검증 게이트를 `eval/policy.json`에 루프 밖으로 고정해 폭주·자기 평가 조작을 막는다*

* *Jev 판단 게이트: 반복 분기 판단은 보정 확률(자율 ≥0.90, 재검토 ≥0.60), 코드·계획은 LLM, 판정·권한은 결정적 코드로 역할을 분리했다*

* *Time-Travel Guard가 리플레이 중 `event_ts ≤ replay_clock` 데이터만 통과시켜 Walk-forward 진화의 미래 정보 누출을 0건으로 유지한다*

* *운영 UI: SSE 이벤트 스트림 하나로 "지금 Agent가 무엇을 생각·판단·실행·복구·진화하는지"를 자막·편성 맵·루프 다이어그램·트레이스로 동시에 보여주는 관측 가능성(Observability) 구조*

## 4. 운영 및 보안 고려 사항

* 인증 방식: *PoC·E2E 단계는 로컬(127.0.0.1) 단일 운영자 콘솔. 승인·반려에는 운영자 이름이 기록되며(브라우저 로컬 저장), 사내 배포 시 SSO 연동 지점은 `/api/approval/*`·제어 API 앞단으로 한정*

* 권한 통제: *원본 데이터·레거시 DB는 읽기 전용 프록시(`mode=readonly`), Agent는 Genome에 선언된 도구만 호출 가능(권한 프록시), 장비 상태 변경·Agent 정식 승격·진화안 채택·폐기 확정은 반드시 사람 승인(자동·타임아웃 승인 없음)*

* Injection 대응: *CodeAct 코드는 AST 정적 검사(허용 import 화이트리스트, 쓰기 API 차단) 후에만 샌드박스에서 실행, 레거시 SQL은 읽기 전용 커넥션·테이블 화이트리스트, 하위 Agent 결과는 Pydantic 스키마 검증 실패 시 "확인 불가" 처리(추측 답변 금지)*

* 장애 대응: *외부 장애는 백오프 재시도·운영자 알림, 코드 결함은 L2 Heal(예산 초과 시 조기 중단 → 에스컬레이션), 승격 후 7일 Shadow 불일치는 원자적 자동 롤백 + Held-out셋 추가, 실패 패치 블랙리스트(AST 해시)로 동일 시도 반복 차단, 모든 실행·도구 호출·승인은 감사 로그 보관*

* 비밀 관리: *사내 LLM API 키는 환경변수, `config/llm.json`·`config/jev.json`은 git 제외*

## 5. 회고 및 향후 확장

### 기술적 한계

* *사내 LLM API 실연동 미검증: 현재 수치는 오프라인 Playbook(기능 플래그 → 결정적 코드) 기준이라 실제 LLM의 코드 생성 품질·지연·비용이 반영되지 않았다*

* *Jev는 사내망 반입 전 로컬 보정 로지스틱 헤드로 대체되어 있어 판단 품질 평가가 목업 분포에 묶여 있다*

* *저장소가 SQLite(WAL) 단일 프로세스라 다중 운영자·동시 요청·대규모 리플레이(3,000건에 수 분) 부하 테스트를 하지 못했다*

* *운영 UI는 1,440px 이상 데스크톱 기준이며 모바일·다국어·접근성 검증은 하지 않았다*

### Next Step

* *사내 LLM API 연결(`config/llm.json`) 후 SC-001~009 재측정, 모델별(opus·sonnet·haiku) 비용·지연 프로파일링*

* *PostgreSQL 전환(동일 스키마) + Langfuse·OpenTelemetry 트레이스 연동으로 루프 ID·Agent 버전 태그 기반 실시간 KPI 집계*

* *SSO 연동과 역할(설비 엔지니어·공정 담당자·운영자)별 승인 권한 분리, 승인 이력의 외부 감사 저장소 보관*

* *동시 사용자 10명·배경 운영 1,000건 기준 부하 테스트와 리플레이 병렬화*

* *실제 장비 SW 버전·레거시 스키마 변경 이력으로 장애 주입 케이스를 확장해 자가 복구율을 재검증*
