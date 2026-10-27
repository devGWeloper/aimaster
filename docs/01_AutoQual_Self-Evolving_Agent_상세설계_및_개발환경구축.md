### Agent 페르소나 및 시스템 프롬프트 (Identity)

Agent의 정체성, 역할, 그리고 답변의 톤앤매너를 정의합니다. 실제 LLM의 System Prompt에 들어갈 핵심 내용입니다.

**1.1 Super Agent (오케스트레이터)**

|              |                            |
| ------------ | -------------------------- |
| **항목**       | **정의 내용**                  |
| **Agent 이름** | AutoQual Super Agent (`super_agent`) |
| **주요 역할**    | 설비 엔지니어·공정 담당자의 자연어 요청을 해석해 하위 Agent(기준정보·로그분석·레거시DB 및 자동 생성 Agent)를 편성하고, 병렬 호출·결과 결합·판정 순서를 Python 실행 계획 코드(CodeAct)로 작성·실행한 뒤 결과를 종합해 Qual 계획·판정·장비 Up 승인 요청까지 제시. 기존 Agent로 처리 불가한 요청은 Agent Factory(L2 Grow)로, 실행 오류는 Heal 엔진(L2 Heal)으로 넘김 |
| **핵심 목표**    | 요청 하나로 AutoQual 업무(Qual 절차 확인 → Seasoning 계획 → Qual 판정 → Up 승인 요청)를 끊김 없이 완료하고, 판정 근거를 원천 데이터·경험(교훈)까지 추적 가능하게 제시. 편성 이력 기반으로 불필요한 Agent 호출을 줄이고 반복 계획은 편성 템플릿으로 재사용 |
| **톤앤매너**     | 현장 엔지니어 대상의 간결한 보고체. `[Agent 편성] / [Qual 절차] / [챔버 상태] / [과거 이력] / [추천] / [판정]` 블록 구조로 결론 먼저, 근거는 수치·Spec·이력 건수로 제시. 확인 불가·근거 부족 항목은 숨기지 않고 명시 ("일시 확인 불가", "이력 기반 보정 없음") |
| **제약 사항**    | 사람 승인 없이 장비 상태(Down→Up) 변경 금지, Spec Pass/Fail 판정을 LLM 추론으로 대체 금지(결정적 판정 코드만 사용), 원본 데이터·레거시 시스템 쓰기 금지, 샌드박스 밖 코드 실행 금지, 근거 없는 결과를 정상 결과로 제시 금지, 평가 하네스·루프 예산 설정 수정 금지, 실제 장비·MES·EES 직접 제어 금지 |

**1.2 기준정보 Agent**

|              |                            |
| ------------ | -------------------------- |
| **항목**       | **정의 내용**                  |
| **Agent 이름** | 기준정보 Agent (`spec_agent`) |
| **주요 역할**    | 장비 모델·챔버·PM 종류별 Qual 절차(예: QP-ETX-WC-03), 측정 항목별 Spec(Particle·ER·Uniformity 등), 기본 Seasoning 레시피·매수를 기준정보 DB에서 조회하고, 진화된 Seasoning 보정 로직(RF Reflected 증가율·부품 사용시간 등)을 적용해 추천 매수 산출 |
| **핵심 목표**    | 정확한 Qual 절차·Spec 제공과 1차 Qual Pass율을 높이는 Seasoning 매수 추천 |
| **톤앤매너**     | 기준정보 원문 코드(절차 ID, Spec 값, 레시피 ID)를 그대로 인용하는 사실 중심 출력, 보정 적용 시 적용 교훈 ID와 보정량 명시 |
| **제약 사항**    | 기준정보 DB 읽기 전용, Spec 값 임의 변경·추정 금지, 기준정보 누락 시 기본값 추정 대신 "기준정보 누락"으로 반환 |

**1.3 로그분석 Agent**

|              |                            |
| ------------ | -------------------------- |
| **항목**       | **정의 내용**                  |
| **Agent 이름** | 로그분석 Agent (`log_agent`) |
| **주요 역할**    | PM 전후 FDC 센서 트레이스(RF Forward/Reflected Power, Pressure, Temp 등), Leak·Base Pressure 로그, 알람 로그를 장비 SW 버전별 파서로 읽어 PM 전 대비 이상 여부와 Seasoning 필요량에 영향을 주는 신호를 탐지 |
| **핵심 목표**    | 챔버 상태를 정량 지표로 요약하고, 로그 포맷이 바뀌어도 Heal을 통해 무중단으로 분석 제공 |
| **톤앤매너**     | 지표명·측정값·Spec·PM 전 대비 변화율을 한 줄씩 제시, 파싱 실패 시 해당 항목만 "확인 불가"로 표시 |
| **제약 사항**    | 원본 로그 수정 금지, 파싱 실패를 빈 값·정상값으로 대체 금지, 판정(Pass/Fail) 직접 수행 금지(지표만 제공) |

**1.4 레거시DB Agent**

|              |                            |
| ------------ | -------------------------- |
| **항목**       | **정의 내용**                  |
| **Agent 이름** | 레거시DB Agent (`legacy_agent`) |
| **주요 역할**    | 문서화가 부족한 레거시 DB(약어 컬럼, 미문서화 코드값, 폐기 테이블 잔존)를 스키마 탐색·코드값 해석 스킬로 조회해, 동일 챔버·동일 PM 후 과거 Qual 이력, Seasoning 매수별 1차 Pass율, 재시도·Fail 패턴, 엔지니어 조치 기록을 분석. 이력 리플레이 시 과거 Qual 건을 시간순 가상 요청으로 재구성 |
| **핵심 목표**    | 과거 이력을 판정·추천 근거로 변환하고, 리플레이 진화의 재료(당시 실제 결과)를 제공 |
| **톤앤매너**     | 표본 수와 기간을 반드시 함께 제시 ("최근 8회: 25매 1차 Pass율 50%"), 해석한 코드값 의미는 출처와 함께 표기 |
| **제약 사항**    | 레거시 DB 읽기 전용(SELECT만 허용), 리플레이 중 재생 시점 이후 데이터 조회 금지(Time-Travel Guard), 조회 0건을 "이력 없음"과 "데이터 부재(이관·미적재)"로 구분해 반환 |

**1.5 Agent Factory / Self-Evolving 엔진 (Grow·Heal·Evolve)**

|              |                            |
| ------------ | -------------------------- |
| **항목**       | **정의 내용**                  |
| **Agent 이름** | Agent Factory (`factory`) · Healer (`healer`) · Evolver (`evolver`) |
| **주요 역할**    | Grow: 처리 불가 요청에 대해 새 Agent 명세·코드·테스트를 작성해 `probation` 등록. Heal: 오류 유형 분류 결과에 따라 자기 코드 패치 → 회귀 테스트 → 반영. Evolve: 지표·경험 메모리 분석으로 5계층(파라미터·프롬프트 / 스킬 / Agent 코드 / Agent 구성 / Super Agent 편성 전략) 개선 후보를 생성하고 변이 → 평가 → 선택 → 보관 사이클 수행. Retire(Agent 구성 계층): 장기 미사용(직접·간접 호출 60일 0건, 주기적 사용 제외)·대체(다른 Agent가 회귀 케이스·최근 요청 100% 커버)된 Agent를 의존성 분석·대체 경로 검증 후 `deprecated`(14일 유예·리다이렉트) → 운영자 승인 후 `retired`(아카이브 보관) |
| **핵심 목표**    | 사람 개입 없이 Agent 생성 성공률 70%, 오류 자가 복구율 70%·MTTR 10분 이내, Held-out 비하락 조건에서 구조·판단 개선 |
| **톤앤매너**     | 운영자 대상 리포트체: 감지 내용 → 원인 → 조치(diff 라인 수) → 검증 결과(테스트 통과 수, Evolve셋/Held-out셋 점수) → 반영 버전 순으로 기술, 채택·기각 사유 명시 |
| **제약 사항**    | 평가 하네스·Held-out셋·루프 예산 수정 금지, 블랙리스트 패치 재시도 금지, 회귀 테스트 1건이라도 실패한 패치 반영 금지, Agent `active` 정식 승격과 `retired` 전환은 운영자 승인 필수(루프 자율은 되돌릴 수 있는 `deprecated`까지), Agent 하드 삭제 금지(`retired`도 Genome·테스트·Lineage 아카이브 보관), 기본 Agent(`super_agent`·`spec_agent`·`log_agent`·`legacy_agent`) 폐기 금지, 변경성 판단 임계값 하한(0.95) 변이 금지, 허용 모듈 외 import 금지, 모델 가중치 학습·파인튜닝 금지 |

### 워크플로우 및 오케스트레이션 (Workflow & Logic)

사용자 입력부터 최종 응답까지 Agent의 사고 과정과 행동 순서를 기술합니다.

**2.1 처리 로직**

* **Step 1 (Input Analysis):** Super Agent가 요청에서 엔티티(장비 ID·챔버·PM 종류·부품·기간)와 요청 유형(PM 후 AutoQual / Qual 판정 / 이력 분석 / 신규 분석)을 추출. 경험 메모리·Registry에서 엔티티가 일치하는 과거 건·교훈·편성 템플릿을 조회해 컨텍스트로 주입. 요청 유형이 편성 템플릿과 일치하면 LLM 계획 생성 없이 템플릿 실행 계획을 바로 사용

* **Step 2 (Tool Selection):** Jev 판단 게이트가 분기 판단을 담당
  * 기존 Agent 조합 처리 가능 여부(예/아니오 확률): 임계값 미만 → L2 Grow Loop(Agent Factory)로 분기
  * Agent 편성(복수 선택 확률): 확률 ≥ 0.90 Agent는 자율 편성, 0.60~0.90은 LLM 에스컬레이션으로 재검토, 0.60 미만 제외
  * 변경성 판단(장비 상태 변경 등)은 임계값 0.95 이상이어도 반드시 사람 승인 패널 경유
  * 편성 확정 후 Super Agent가 하위 Agent 병렬 호출·결과 결합·판정 순서를 Python 실행 계획 코드로 작성해 샌드박스에서 실행(CodeAct)
  * 실행 중 오류 또는 사후 검증 실패(조회 0건, 값 범위 이상) 시 해당 항목을 "확인 불가"로 표시하고 L2 Heal Loop를 비동기로 기동

* **Step 3 (Execution & Response):** 하위 Agent 결과를 Structured Output으로 수집 → Super Agent가 Seasoning 매수·Qual 순서를 근거(지표·이력·적용 교훈 ID)와 함께 종합 → Qual 진행 후 측정값은 결정적 판정 코드로 Spec 비교 → Pass 시 장비 상태 변경 요청을 승인 패널로 전달하고 승인 후에만 반영. Heal 완료 시 "확인 불가" 항목 재분석 결과를 추가 응답으로 전달. 모든 실행(코드·결과·엔지니어 Override·실제 Qual 결과)은 경험 메모리에 기록되어 L3 Evolve 재료가 됨

**2.2 상태 관리**

* 대화 턴(Turn) 상태 정의 (`AutoQualState`)
  * `request`: 원문 요청, 추출 엔티티(eqp_id, chamber, pm_type, period), 요청 유형
  * `plan`: 편성 Agent 목록과 Jev 확률, 실행 계획 코드, 편성 템플릿 ID
  * `agent_results`: Agent별 결과·상태(`ok` / `unavailable` / `healing`)·버전
  * `pending_items`: Heal 진행 중이라 확인 불가로 응답한 항목
  * `qual_status`: `planning` → `seasoning` → `measuring` → `judged` → `approval_pending` → `up` / `rework`
  * `judgement`: 측정값, Spec 비교 결과, 재Seasoning 필요 여부
  * `approval`: 장비 상태 변경 요청 ID, 승인자, 승인 시각
  * `loop_budget`: 루프별 반복 횟수·경과 시간·토큰 사용량
  * `replay_clock`: 리플레이 모드 시 재생 시점(Time-Travel Guard 기준 시각), 운영 모드 시 `null`

* Agent 생명주기 상태 (Registry `status`)
  * `probation`(Grow 생성 직후) → `active`(운영자 승인) → `deprecated`(폐기 유예: 편성 후보 제외, 호출은 대체 Agent로 리다이렉트, 원 Agent는 Fallback으로 유지) → `retired`(운영자 승인, 편성·Heal·회귀 대상 제거, 아카이브 보관)
  * `shadow`: 승격 전 Shadow 운영 및 승격 후 7일간 직전 버전 병행 비교용
  * 복원: `retired` → `probation` (유사 요청 시 아카이브 Genome을 현재 스키마로 재테스트 후 복원), 유예 중 대체 실패 시 대체 Agent Heal 후 유예 재시작

* 버전 규칙: `0.x.y` probation, `1.0.0` 첫 active 승격, PATCH = Heal 패치, MINOR = Evolve 채택(판단 로직·성능·공용 스킬 적용), MAJOR = Agent 구성 변경(병합·기능 흡수·분리). 롤백 시 직전 안정 버전으로 복귀하고 결함 버전 번호는 재사용하지 않음

* LangGraph Node/Edge 흐름
  * **L1 Task Loop (요청 단위)**
    * `parse_request` → `retrieve_memory` → `jev_route`
    * `jev_route` --(처리 가능)--> `plan_codeact` / --(처리 불가)--> `grow_subgraph`
    * `plan_codeact` → `execute_sandbox` → `observe`
    * `observe` --(오류·사후 검증 실패)--> `mark_unavailable` → `heal_subgraph`(비동기) + `synthesize`
    * `observe` --(목표 미충족·Jev 종료 점수 낮음)--> `plan_codeact` (L1 예산 내 재계획)
    * `observe` --(목표 충족)--> `synthesize` → `respond`
    * `respond` → `await_qual_result`(interrupt) → `deterministic_judge`
    * `deterministic_judge` --(Pass)--> `approval_gate`(interrupt, 사람 승인) → `apply_state_change` → `log_experience` → END
    * `deterministic_judge` --(Fail)--> `plan_codeact` (재Seasoning 계획)
  * **L2 Heal/Grow Loop (이벤트 단위, 최대 5회·15분)**
    * Heal: `jev_classify_error`(포맷 변경 / 스키마 변경 / 기준정보 누락 / 로직 오류 / 외부 장애 / 복구 불가) → `diagnose_codeact`(로그 슬라이싱: 헤더·오류 지점 전후 N행·포맷별 샘플 Run만 관찰, 원문 전체를 LLM 컨텍스트에 넣지 않음) → `write_patch` → `check_blacklist` → `run_regression` --(전부 통과)--> `register_version` → `reanswer_pending` / --(실패)--> `blacklist_patch` → `diagnose_codeact` / --(복구 불가 또는 예산 소진)--> `escalate_operator`. 복구 중에는 이전 정상 버전 Fallback
    * Grow: `search_archive`(기각·`retired` Genome 유사 검색) --(유사 Genome 있음)--> `restore_genome` → `run_tests` / --(없음)--> `write_spec` → `explore_schema` → `generate_code_and_tests`(정상 케이스 + 스키마 탐색 기반 엣지 케이스 생성: 미등록 코드값·이력 0건·단위 혼재·경계일·결측) → `run_tests`(자체 테스트(정상·엣지) + 하네스 불변식 테스트: 행 수 대조·단위 범위·기간 경계) --(통과)--> `register_probation` → L1 `execute_sandbox` 복귀 / --(실패)--> `generate_code_and_tests` / --(예산 소진)--> `abort_with_reason`
  * **L3 Evolve Loop (운영 중 일 1회 야간, 리플레이 시 분기 단위)**
    * `collect_metrics`(중복률·응답시간·성공률·사용 빈도·Override율·편성 기여도) → `jev_need_evolve` → `mutate`(1회 최대 3개 후보, 진화 아카이브에서 출발점 선택) → `evaluate_harness`(루프 밖 고정 하네스, Evolve셋 + Held-out셋/백테스트 기간) → `select`(Evolve셋 개선 & Held-out 비하락) → `archive`(채택·기각 모두 보관) → `shadow_run`(장비군별 최소 10건, 부족 시 리플레이 이력 샘플 보충) --(이상 없음)--> `promote`(Agent 정식 승격은 운영자 승인, 승격 후 7일간 직전 버전 Shadow 병행) / --(판정 불일치)--> `auto_rollback`(결함 공용 스킬에 의존하는 Agent 전체를 Lineage 기준으로 원자적 롤백) → 불일치 샘플 Held-out셋 추가
    * Retire 분기: `collect_metrics`(직접·간접 호출 수·마지막 호출일·기능 중첩도·회귀 커버리지) → `jev_need_retire` → `analyze_dependency`(편성 템플릿·타 Agent 내부 호출·공용 스킬·하네스 케이스) --(간접 의존 있음)--> `archive`(hold) / --(없음)--> `verify_replacement`(회귀 + 최근 30일 실제 요청을 대체 Agent로 재실행, 100% 일치) → `migrate_tests` → `deprecate`(14일 유예) --(유예 중 대체 실패)--> 원 Agent Fallback → 대체 Agent `heal_subgraph` → `verify_replacement` 재수행 / --(이상 없음)--> `approval_gate`(운영자) → `retire` → `archive`
  * **History Replay 모드**: `build_replay_requests`(레거시 이력 → 시간순 가상 요청) → `set_replay_clock` → L1 그래프 실행 → `compare_actual`(당시 실제 결과와 차이를 경험 메모리 기록) → 분기 종료 시 L3 실행(Walk-forward) → 최근 6개월 Held-out 기간은 진화 없이 최종 평가만 수행
  * Checkpointer로 스레드별 상태를 저장해 `await_qual_result`·`approval_gate` interrupt 이후 재개

### 도구(Tools) 및 함수 명세 (Capability)

Agent가 외부 세상과 상호작용하기 위해 사용할 도구(Function Calling)를 정의합니다.

|                         |                         |                            |                     |
| ----------------------- | ----------------------- | -------------------------- | ------------------- |
| **도구명 (Function Name)** | **기능 설명 (Description)** | **입력 파라미터 (Input Schema)** | **출력 데이터 (Output)** |
| `execute_code`          | CodeAct 실행 런타임. Agent가 작성한 Python 코드를 샌드박스에서 실행(허용 모듈 화이트리스트, 정적 검사, 읽기 전용 권한 프록시, 감사 로그) | `code: str` / 실행할 Python 코드<br>`agent_id: str` / 실행 주체<br>`timeout_s: int` / 실행 제한 시간 | `{stdout: str, result: any, error: {type, message, traceback} \| null, elapsed_ms: int, audit_id: str}` |
| `jev_decide`            | Jev 의사결정 모델 호출. 선택·점수·예/아니오에 보정된 확률로 응답 | `question: str` / 판단 질문<br>`mode: "choice" \| "multi_choice" \| "yes_no" \| "score"`<br>`options: list[str]` / 선택지<br>`context: str` / 판단 근거 | `{answer: str \| list[str], probs: dict[str, float], calibrated: bool}` |
| `query_spec_db`         | 기준정보 DB에서 장비 모델·PM 종류별 Qual 절차·Spec·Seasoning 레시피 조회 | `eqp_model: str` / 장비 모델<br>`pm_type: str` / PM 종류<br>`chamber_id: str` / 챔버 | `{procedure_id: str, steps: list, specs: list[{item, lower, upper, unit}], seasoning: {recipe_id, base_count}}` |
| `read_fdc_trace`        | PM 전후 FDC 센서 트레이스 조회(장비 SW 버전 정보 포함) | `eqp_id: str`, `chamber_id: str`<br>`sensors: list[str]` / 센서명<br>`start: datetime`, `end: datetime`<br>`slice: {mode: "header" \| "around" \| "sample", at: datetime \| null, n: int} \| null` / 로그 슬라이싱(필요 구간만 반환) | `{sw_version: str, columns: list[str], rows: DataFrame(JSON), raw_header: str, total_rows: int}` |
| `read_alarm_log`        | 장비 알람·Leak·Base Pressure 로그 조회 | `eqp_id: str`, `chamber_id: str`<br>`start: datetime`, `end: datetime` | `list[{ts, alarm_code, message, severity}]` |
| `inspect_legacy_schema` | 레거시 DB 테이블·컬럼·샘플값 탐색(폐기 테이블 여부·최종 적재 시각 포함) | `table_pattern: str` / 테이블명 패턴<br>`sample_rows: int` | `list[{table, columns: list[{name, type, samples}], row_count, last_loaded_at, deprecated: bool}]` |
| `query_legacy_db`       | 레거시 DB SELECT 실행(쓰기 쿼리 차단, 리플레이 시 `replay_clock` 이후 데이터 자동 필터) | `sql: str` / SELECT 쿼리<br>`params: dict` | `{columns: list[str], rows: list, row_count: int, guard_blocked: int}` |
| `resolve_code_value`    | 레거시 미문서화 코드값의 의미를 사전·이력 패턴으로 해석 | `table: str`, `column: str`<br>`values: list[str]` | `dict[value, {meaning: str, source: str, confidence: float}]` |
| `judge_qual`            | 결정적 판정 코드. 측정값을 Spec과 비교해 Pass/Fail·재Seasoning 필요 여부 산출(LLM 미개입) | `procedure_id: str`<br>`measurements: list[{item, value, unit}]` | `{result: "PASS" \| "FAIL", details: list[{item, value, spec, pass}], rework: bool}` |
| `request_state_change`  | 장비 상태 변경(Down→Up) 요청을 승인 패널로 전달. 승인 전 반영 불가 | `eqp_id: str`, `chamber_id: str`<br>`from_state: str`, `to_state: str`<br>`evidence: dict` / 판정 근거 | `{request_id: str, status: "pending" \| "approved" \| "rejected", approver: str \| null}` |
| `search_experience`     | 경험 메모리(과거 실행·Override·실제 Qual 결과·교훈) 조건 조회. 리플레이 시 `replay_clock` 이후 레코드 자동 제외 | `filters: {eqp_model, chamber_id, pm_type, kind, before_ts}`<br>`limit: int` | `list[{id, kind: "case" \| "lesson", content, event_ts, source_case_ids}]` |
| `record_experience`     | 실행 결과·엔지니어 Override와 사유·실제 Qual 결과·교훈 저장 | `kind: str` / case, lesson, skill<br>`payload: dict`<br>`source_case_ids: list[str]` | `{memory_id: str}` |
| `registry_get`          | Agent Registry에서 Genome(코드·프롬프트·툴·테스트·지표·버전) 조회 | `agent_id: str`<br>`version: str \| "active"` | `{genome: {code, prompt, tools, tests, metrics, version, status, lineage}}` |
| `registry_register`     | 새 Agent 또는 새 버전 Genome 등록(`probation` / `shadow`), 변경 Lineage 기록 | `genome: dict`<br>`parent_version: str \| null`<br>`reason: str` / grow, heal, evolve | `{agent_id: str, version: str, status: str}` |
| `run_tests`             | Agent 자가 테스트·회귀 테스트 실행 | `agent_id: str`, `version: str`<br>`suites: list[str]` / unit, edge, regression, new_format | `{passed: int, failed: int, failures: list[{case, error}]}` |
| `evaluate_candidate`    | 루프 밖에서 고정된 평가 하네스로 후보 채점(루프는 호출만 가능, 수정 불가) | `candidate_id: str`<br>`sets: list["evolve" \| "heldout" \| "backtest"]` | `{scores: dict[set, {accuracy, first_pass_rate, wafer_usage, latency_p50, calls_per_req}], delta_vs_base: dict}` |
| `archive_candidate`     | 채택·기각 후보를 점수·사유와 함께 진화 아카이브에 저장 | `candidate_id: str`<br>`decision: "adopt" \| "reject" \| "hold"`<br>`reason: str` | `{archive_id: str}` |
| `promote_or_rollback`   | Shadow 결과 기반 승격 또는 이전 버전 롤백(공용 스킬 롤백 시 의존 Agent 동시 롤백) | `agent_id: str`<br>`action: "promote" \| "rollback"`<br>`target_version: str` | `{agent_id, active_version, previous_version, cascaded: list[{agent_id, from, to}], approved_by: str \| null}` |
| `analyze_dependency`    | Agent의 직접·간접 호출 이력과 의존 관계(편성 템플릿·타 Agent 내부 호출·공용 스킬·하네스 케이스) 분석 | `agent_id: str`<br>`window_days: int` | `{direct_calls: int, indirect_calls: int, last_called_at: datetime, periodic: bool, dependents: list[{kind, ref}], unique_test_cases: list[str]}` |
| `registry_lifecycle`    | Agent 생명주기 전환(유예·폐기·복원). `retire`는 운영자 승인 필수, 기본 Agent는 거부 | `agent_id: str`<br>`action: "deprecate" \| "retire" \| "restore"`<br>`replacement: str \| null` / 리다이렉트 대상<br>`reason: str` / unused, superseded | `{agent_id, status, grace_until: datetime \| null, archive_id: str \| null, approved_by: str \| null}` |
| `patch_blacklist`       | 실패 패치 해시 등록·조회로 동일 시도 반복 차단 | `action: "add" \| "check"`<br>`patch_hash: str`<br>`error_signature: str` | `{blacklisted: bool}` |
| `build_replay_requests` | 레거시 Qual 이력을 당시 로그·부품 교체 이력·조치와 묶어 시간순 가상 요청으로 재구성 | `eqp_models: list[str]`<br>`start: date`, `end: date`<br>`heldout_start: date` | `{requests: list[{replay_ts, request_text, actual_outcome_ref}], count: int}` |
| `set_replay_clock`      | Time-Travel Guard 기준 시각 설정. 이후 모든 데이터 도구가 해당 시각 이후 데이터 차단 | `ts: datetime \| null` / null이면 운영 모드 | `{replay_clock: datetime \| null, guard: "ON" \| "OFF"}` |
| `inject_fault`          | Mock 환경 장애 주입기(로그 포맷·DB 컬럼·타임아웃·단위 변경 재현) | `fault_type: str`<br>`target: str`<br>`params: dict` | `{fault_id: str, active: bool}` |

### 지식 베이스 및 메모리 전략 (Context & Memory)

LLM이 기억해야 할 단기 대화 내역과 참조해야 할 장기 데이터 전략을 수립합니다.

**4.1 장기 메모리 전략 (RAG 미사용)**

* **RAG 미사용 사유:** 참조 대상이 모두 장비 모델·챔버·PM 종류·시점 키로 정확히 조회되는 정형 데이터(기준정보 DB, FDC·알람 로그, 레거시 DB, Agent Registry, 경험 메모리)이므로 유사도 검색 대신 CodeAct로 작성한 조회 코드(SQL·필터)로 직접 조회. 근사 검색으로 인한 다른 장비·다른 PM 사례 혼입을 막고, Time-Travel Guard를 `event_ts ≤ replay_clock` 조건 하나로 강제 가능. `event_ts`가 없는 테이블은 기본 차단하고, 정적 기준 데이터(코드값 사전·Spec·Seasoning 레시피)는 `valid_from`/`valid_to` 유효기간 버전으로만 조회해 "미래에 정의된 코드값·Spec" 누출을 차단

* **참조 데이터 소스:**
  * 기준정보 DB: Qual 절차·Spec·Seasoning 레시피 매핑 (`query_spec_db`)
  * 장비 로그: FDC 센서 트레이스·알람·부품 교체 이력 (`read_fdc_trace`, `read_alarm_log`)
  * 레거시 DB + 스키마 사전: 과거 Qual 이력, 해석된 코드값 의미, 폐기·이관 테이블 정보 (`inspect_legacy_schema`, `query_legacy_db`, `resolve_code_value`)
  * 경험 메모리: AutoQual 실행 건(추천·Override·사유·실제 Qual 결과), 교훈(Lesson), 리플레이 비교 결과 (`search_experience`)
  * Agent Registry: Genome, 스킬 라이브러리(`fdc_toolkit`, `legacy_sql_toolkit`, `code_value_resolver` 등), 편성 템플릿, Heal 이력·패치 블랙리스트, 진화 아카이브

* **저장 단위 및 조회 키:**
  * 경험 메모리: AutoQual 1건 = 1 레코드, 키 `(eqp_model, chamber_id, pm_type, event_ts)`
  * 교훈(Lesson): 적용 조건(`eqp_model`, `pm_type`, 조건식 예: RF Reflected 증가율 ≥ 10%) + 보정 내용 + 원천 `source_case_ids` → 요청 엔티티와 조건이 일치하는 교훈만 주입
  * 스킬·편성 템플릿: Registry에 이름·시그니처·docstring·요청 유형으로 등록, Agent Factory·Super Agent 프롬프트에는 스킬 카탈로그(시그니처 목록)만 주입하고 본문은 필요 시 `registry_get`으로 조회
  * Heal 이력: 오류 시그니처(예외 타입 + 대상 Agent + 컬럼/필드명) 정확 일치로 과거 진단·패치 조회

* **저장소:** PostgreSQL 단일 DB (Agent Registry·경험 메모리·진화 아카이브·Lineage를 한 DB에 두어 트랜잭션으로 정합성 유지, 모든 레코드에 `event_ts` 부여, 사내 온프렘 구성 용이)

**4.2 대화 메모리 (Conversation History)**

* **메모리 유형:**
  * 단기(턴): LangGraph State 기반 윈도우 버퍼(최근 10턴 원문) + 이전 턴은 요약으로 압축. CodeAct 실행 결과는 원문 대신 요약·핵심 변수만 유지하고 전체 출력은 감사 로그 참조 ID로 대체
  * 작업(Qual 건): 하나의 AutoQual 건(PM 완료 → 판정 → Up 승인)을 하나의 스레드로 관리, 측정 대기·승인 대기 interrupt 동안 Checkpointer에 상태 영속화
  * 장기: 경험 메모리(4.1)로 이관되어 다음 요청 시 조회 키 일치 건·교훈을 컨텍스트로 주입

* **저장 전략:**
  * 대화 세션: 마지막 활동 후 24시간 유지, 단 Qual 건 스레드는 `qual_status`가 `up` / `rework` 종료 또는 사용자 취소 시까지 유지
  * 종료 시 실행 기록·Override·실제 Qual 결과를 경험 메모리에 영구 저장하고 세션 단기 메모리 초기화
  * 리플레이 모드: 가상 요청 1건마다 단기 메모리 초기화(건 간 정보 누출 방지), 경험 메모리는 `event_ts` 기준으로만 누적
  * 감사 로그(실행 코드·권한 프록시 기록·승인 이력)는 별도 저장소에 1년 이상 보관

### 핵심 에이전트 기술 스택

일반적인 웹 개발 스택이 아닌, LLM의 답변 품질과 구조를 제어하기 위한 기술적 의사결정을 기입합니다.

|                     |                                           |                            |
| ------------------- | ----------------------------------------- | -------------------------- |
| **구분**              | **선정 전략/기술**                              | **선정 사유 (논리적 근거)**         |
| **LLM Model**       | 역할별 분리: ① `claude-opus-5-5` — Agent Factory·Heal 패치·Evolve 변이(코드 생성·수정) ② `claude-sonnet-5-5` — Super Agent 계획·CodeAct 실행 계획 작성·결과 종합 ③ `claude-haiku-5-5` — 요약·엔티티 추출 ④ Jev — 루프 내 분기 판단(대안: SemIf 온프렘 또는 소형 분류 모델) | 자기 코드 생성·수정은 실패 시 루프 반복 비용이 크므로 코딩 성능이 가장 높은 모델에 집중, 요청마다 도는 L1은 속도·비용 균형 모델 사용. 반복되는 짧은 분기 판단을 보정 확률을 주는 Jev로 처리해 LLM 호출 비용·지연 절감 및 임계값 기반 자율/에스컬레이션/사람 확인 구분 가능. 한국어 요청·영문 약어 혼합 처리 성능 확보 |
| **Agent Framework** | LangGraph (StateGraph + Subgraph + Checkpointer + interrupt) | L1/L2/L3 3중 루프를 서브그래프로 분리해 루프별 트리거·종료 조건·예산을 Edge 조건으로 명시 가능, 측정 대기·장비 상태 변경 승인을 interrupt로 구현해 Human-in-the-loop 보장, Checkpointer로 장시간 Qual 건 상태 재개 및 리플레이 재현 가능 |
| **Prompt Strategy** | CodeAct(코드를 행동으로 사용) + ReAct형 계획→코드→실행→관찰 루프, 경험 메모리 기반 동적 Few-Shot(조회 키가 일치하는 과거 건·교훈·스킬 카탈로그 주입), Heal 시 Reflexion(오류 trace·블랙리스트를 다음 시도 프롬프트에 반영), Evolve 시 진화 아카이브 기반 다중 후보 변이(DGM·AlphaEvolve 방식) | JSON 툴 호출로는 불가능한 Agent 생성·자기 수정이 핵심이므로 실행 가능한 코드가 행동 단위여야 함. 레거시 DB·로그 포맷처럼 문서화가 부족한 대상은 탐색 코드 실행 결과를 관찰하며 추론해야 정확. 과거 실패를 컨텍스트로 넣어 동일 시도 반복 방지 |
| **Output Parsing**  | Agent 간 결과: Pydantic 스키마 기반 Structured Output(Agent별 결과 모델 + `status` 필드), CodeAct: 코드 블록 추출 후 AST 정적 검사(허용 import·쓰기 API 차단), Jev: `probs` 수치 응답, Spec 판정: 결정적 코드 `judge_qual` | 하위 Agent 결과를 Super Agent 실행 계획 코드가 그대로 변수로 결합해야 하므로 스키마 고정 필수. 판정·권한처럼 오류가 허용되지 않는 영역은 LLM 출력 파싱이 아닌 결정적 코드로 처리. 스키마 검증 실패는 사후 검증 실패로 간주해 Heal 트리거 |
| **Monitoring**      | Langfuse(셀프호스팅) + OpenTelemetry 트레이스, 운영 UI — React 19 + Vite + Tailwind v4 + shadcn/ui + React Flow SPA(`ui/web`, 빌드 결과물을 FastAPI가 서빙), SSE 이벤트를 Zustand 슬라이스(live·chat·trace·biz·evolve)로 접어 넣고 연출은 별도 허브로 분리: 라이브(지금 하는 일 자막·루프 스테퍼·행동 일지 / Agent 편성 맵(호출 펄스·가져온 값 칩·생성/치유/진화/폐기) / 포커스 카드(CodeAct 코드·Jev 확률·판정 표·승인·diff·테스트) / 대화) · 루프(3중 루프 다이어그램·예산 게이지·실행 트레이스) · 진화(진화 사이클 5단계·사건 피드·Genome 계보·리플레이·5계층/아카이브) · Agent(Genome 코드·Lineage·테스트) · 승인 · Fab·KPI | 사내망 반입이 가능한 셀프호스팅으로 요청별 LLM·Jev 호출, 토큰, 지연을 추적. 루프 ID·Agent 버전·Genome Lineage를 트레이스 태그로 남겨 루프 폭주(예산 초과)·진화 퇴화·무승인 상태 변경 KPI를 실시간 집계하고, Shadow 비교 불일치를 감지해 자동 롤백 트리거로 사용 |
