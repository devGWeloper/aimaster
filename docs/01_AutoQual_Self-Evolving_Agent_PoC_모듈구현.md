### 핵심 구현 내용

이번 PoC 단계에서 실제 코드로 구현된 핵심 기능들을 **동작 원리**와 **사용 기술** 중심으로 상세히 기술합니다.

> 실행: `pip install -r requirements.txt` → `python -m mock_env.generate` → `python -m ui.server` → http://127.0.0.1:8765 에서 **Autopilot 시작**. 사내 LLM(`config/llm.json`) 미설정 시 오프라인 Playbook으로 결정적으로 재현되며, 아래 수치는 모두 이 모드의 실제 실행 결과다. 코드 위치는 `autoqual/`(에이전트 본체), `eval/`(루프 밖 고정 하네스·KPI), `mock_env/`(목업 Fab), `ui/`(운영 UI).

**1.1 에이전트 워크플로우 (Agent Workflow)**

* **구현 기능:** Super Agent가 요청 한 줄을 받아 기준정보(`spec_agent`)·로그분석(`log_agent`)·레거시DB(`legacy_agent`)와 Grow로 생긴 Agent를 스스로 편성해 AutoQual(추천 → 측정 → 판정 → 승인 → Up)까지 끝내는 **L1 Task Loop**

* **동작 원리:** `parse_request`(엔티티 추출, 장비가 모호하면 추측하지 않고 되묻기) → `retrieve_memory`(교훈·유사 사례·편성 템플릿) → `jev_route`(기존 Agent로 처리 가능한지, 어떤 Agent를 부를지 보정 확률로 판단) → `plan_codeact`(Super Agent가 실행 계획을 Python 코드로 작성, 검증된 편성 템플릿이 있으면 LLM 생략) → `execute_sandbox`(계획 코드가 `parallel()`/`call()`로 하위 Agent 호출) → `observe`(사후 검증) → `synthesize`·`respond` → `await_qual_result`(interrupt로 측정값 대기) → `deterministic_judge`(Pass/Fail은 결정적 코드 `judge_qual`) → `approval_gate`(interrupt, 사람 승인) → `apply_state_change` → `log_experience`. 조건 분기는 세 군데다. 처리 불가 능력이면 `grow_subgraph`(L2 Grow)로 내려가고, 하위 Agent 결과가 검증에 실패하면 해당 항목만 "확인 불가"로 먼저 응답한 뒤 L2 Heal을 깨우고, 외부 장애(타임아웃)면 코드 패치 없이 재계획 1회로 처리한다

* **주요 기술:** LangGraph `StateGraph`(조건부 엣지, 요청 thread별 `InMemorySaver` 체크포인트, `interrupt`/`Command(resume)`로 측정값·승인 대기 후 재개), 역할별 모델(`claude-haiku-5-5` 엔티티 추출, `claude-sonnet-5-5` 계획·종합, `claude-opus-5-5` 코드 생성), Pydantic 출력 검증(`autoqual/schemas.py`), `autoqual/loops/l1.py`

**1.2 도구(Tool) 및 함수 연동**

* **구현 기능:** Agent가 쓰는 데이터 도구 12종(`lookup_equipment`, `query_spec_db`, `get_pm_event`, `read_fdc_trace`, `read_fdc_summary`, `read_alarm_log`, `inspect_legacy_schema`, `query_legacy_db`, `resolve_code_value`, `search_experience`, `unit_factor`, `call_agent`)과 시스템 도구(`execute_code` 샌드박스, `jev_decide`, `run_tests`, `evaluate_candidate`, Registry·아카이브·경험 기록)

* **동작 원리:** 함수 호출 JSON 대신 **Agent가 작성한 Python 코드 안에서 `tools.xxx()`를 호출**한다(CodeAct). 권한 프록시(`ToolProxy`)는 Agent Genome에 선언된 도구만 통과시키고 모든 호출을 감사 로그에 남긴다. 레거시 DB는 읽기 전용(`mode=ro` 연결 + 쓰기 SQL 차단)이고, 리플레이 중에는 `event_ts ≤ replay_clock` 뷰만 보인다(Time-Travel Guard). 이번에 `read_fdc_trace`에 `slice={mode: header | around | sample, at, n}` 파라미터를 추가해, 원본 해상도 로그(60Hz)를 통째로 읽지 않고 필요한 구간만 반환하도록 했다(SC-003 대용량 로그 진단)

* **주요 기술:** `autoqual/tools.py`(가상 I/O 비용 모델 포함), `autoqual/sandbox.py`(`ToolProxy`), `mock_env/world.py`(데이터 서버·장애 주입·`fdc_slice`), 사내 LLM 어댑터 `autoqual/llm.py`(OpenAI·Anthropic 호환 형식, 키는 환경변수)

**1.3 데이터 및 메모리 (RAG & Context)**

* **구현 기능:** RAG를 쓰지 않는 **구조화 경험 메모리**(case·lesson·skill)와 Agent Registry(Genome·Lineage)·진화 아카이브를 단일 저장소로 운영

* **동작 원리:** `log_experience`가 실행 기록·엔지니어 Override와 사유·실제 Qual 결과를 case로 쌓으면, L3 Evolve가 case를 분석해 교훈(lesson: 장비 모델·PM 종류·적용 조건·보정량·원천 건수)을 만들고 만료시킨다. `retrieve_memory`는 장비 모델·PM 종류로 거르고 `before_ts`(리플레이 시각) 조건을 붙여 조회하며, 추천 근거에 `[교훈 L-0029 … 원천 이력 32건]`처럼 출처를 인용한다. 임베딩 유사도 검색 대신 결정적 필터를 쓴 이유는 근거 추적성, 재현성, Time-Travel Guard와의 일관성이다

* **주요 기술:** SQLite(WAL) — 운영 시 같은 스키마로 PostgreSQL. 목업 데이터는 장비 30·챔버 90·PM 8종, Qual 이력 3,000건/3년이고 시드가 고정되어 있다(`mock_env/generate.py`). 약어 컬럼, 미문서화 코드값(PRT_CD 23종 중 8종 미등재), 폐기 테이블, 결측일, 소프트 삭제 중복, SW 버전별 로그 포맷(v3.8 / v4.x / v5.2)을 일부러 넣었다

**1.4 CodeAct 런타임 · 샌드박스**

* **구현 기능:** Super Agent의 실행 계획, Healer의 진단·패치, Agent Factory의 스키마 탐색·Agent 생성, 그리고 각 Agent의 Genome까지 모두 **Python 코드로 작성하고 샌드박스에서 실행**한다

* **동작 원리:** 실행 전에 AST 정적 검사를 거친다. import 화이트리스트, `eval/exec/open/getattr` 등 금지 이름, dunder·`format` 같은 탈출 경로 속성을 막는다. 제한된 globals로 실행하고, 타임아웃과 감사 로그(`audit_id`)를 남긴다. 평가 하네스(`eval/`)는 샌드박스에서 import할 수 없으므로 루프가 자기 채점기를 고칠 수 없다. 실패한 패치는 식별자를 정규화한 **AST 해시**로 블랙리스트에 올려, 변수명만 바꾼 같은 패치의 재시도를 막는다

* **주요 기술:** Python `ast`, 정규화 AST 해시(`canonical_hash`), 스레드 타임아웃, `autoqual/sandbox.py`, `autoqual/runtime.py`(Agent 실행·간접 호출·Shadow 병행·리다이렉트)

**1.5 Loop Engineering (L1 Task / L2 Heal·Grow / L3 Evolve)**

* **구현 기능:** 3중 루프마다 트리거, 종료 조건, 예산, 검증 게이트를 둔다. 예산과 임계값은 루프가 수정할 수 없는 `eval/policy.json`에 고정한다(L2: 최대 5회·15분·토큰 120k, Jev 자율 ≥0.90 / 재검토 ≥0.60, 상태 변경 하한 0.95)

* **동작 원리:**
  * **L2 Heal**: `jev_classify_error`(확신도 0.70 미만이면 진단 코드를 먼저 실행하고 재분류) → `diagnose_codeact` → `write_patch` → `check_blacklist` → `run_regression`(기존 회귀 + 신규 포맷, 하나라도 실패하면 반영 안 함) → `register_version` → `cascade`(같은 오류 시그니처를 가진 다른 Agent에 패치 재사용) → `reanswer_pending`. 복구 불가이거나 예산이 소진되면 `escalate_operator`로 넘긴다
    * 이번 변경: 진단 CodeAct가 **로그 슬라이싱**으로 동작한다. Run별 헤더 → 포맷이 바뀐 경계 전후 10행 → Run별 샘플 5행만 관찰하고, 원문 전체를 LLM 컨텍스트에 넣지 않는다
  * **L2 Grow**: `search_archive`(기각·폐기 Genome이 있으면 복원 우선) → `write_spec` → `explore_schema` → `generate_code_and_tests` → `run_tests` → `register_probation` → L1 복귀. 실패하면 재생성하고, 예산을 소진하면 `abort_with_reason`으로 끝낸다
    * 이번 변경: 스키마 탐색 CodeAct가 코드값 분포·결측·경계일에서 **엣지 케이스 6종을 도출**하고, 정상 8건 + 엣지 6건 + 하네스 불변식으로 검증한다
  * **L3 Evolve**: `collect_metrics` → `jev_need_evolve` → `mutate`(최대 3후보, 아카이브에서 출발점 선택) → `evaluate_harness`(Evolve셋 개선 & Held-out 비하락) → `select`(사람 승인) → `archive`(채택·기각 모두 보관) → `shadow_run` → `promote` 또는 `auto_rollback`(결함 공용 스킬에 의존하는 Agent 전체를 Lineage 기준으로 원자적 롤백). Retire 분기는 의존성 분석 → 대체 검증 → `deprecated` 유예 → 사람 승인 → `retired` 아카이브 순서로 진행한다

* **주요 기술:** LangGraph 서브그래프(`loops/l2_heal.py`, `loops/l2_grow.py`, `loops/l3_evolve.py`, `loops/l3_ops.py`), 예산 이벤트(`budget`), 루프 밖 하네스(`eval/harness.py`, `eval/testcases.py`)

**1.6 Self-Evolving (Grow · Heal · Evolve · Retire)과 이력 리플레이**

* **구현 기능:** 5계층 개선 — ① 파라미터·프롬프트(교훈) ② 스킬(공용 스킬 추출) ③ Agent 코드 ④ Agent 구성(생성·병합·폐기) ⑤ Super Agent 편성 전략(불필요 호출 제거·템플릿 승격·임계값 재조정)

* **동작 원리:** 3년치 Qual 이력 3,000건을 시간순으로 재생하면서 분기마다 Walk-forward로 진화하고, 최근 6개월은 Held-out으로 진화 없이 평가만 한다(SC-006). 운영 중에는 야간 L3가 실제 결과와 Override를 학습한다(SC-007·004·005·008·009). Genome 버전 규칙은 다음과 같다. Heal은 PATCH, Evolve는 MINOR, 구성 변경은 MAJOR이고, Grow는 `0.x` probation에서 출발해 사람 승인 후 `1.0.0`으로 승격된다. 결함 판정된 버전 번호는 재사용하지 않는다

* **주요 기술:** Genome(코드·프롬프트·툴·테스트·지표·버전) Registry와 Lineage(`autoqual/registry.py`), 진화 아카이브(기각안을 보존했다가 SC-009에서 재출발), Shadow 비교, 리플레이 엔진(`loops/replay.py`), 시나리오 타임라인(`autoqual/story.py`, 챕터별 체크포인트)

**1.7 Jev 판단 게이트**

* **구현 기능:** 루프 안의 반복 분기(처리 가능? / 편성 / 오류 유형 / 복구 불가? / 진화 필요? / 병합? / 폐기?)를 LLM 대신 **보정 확률**로 판단한다

* **동작 원리:** 판단 유형별 특징 → 로지스틱 헤드 → 온도 스케일링으로 보정된 확률을 낸다. 자율 임계값(0.90) 이상이면 바로 진행하고, 재검토 구간(0.60~0.90)은 LLM 재검토에 맡기고, 그 아래는 제외하거나 에스컬레이션한다. 역할은 셋으로 나뉜다. 코드 작성·계획은 LLM, Spec 판정은 결정적 코드 `judge_qual`, 장비 상태 변경은 Jev 확신도와 무관하게 사람 승인이다

* **주요 기술:** `autoqual/jev.py`(로컬 보정 로지스틱 헤드, `config/jev.json` mode=http면 같은 시그니처로 사내 엔드포인트 호출), `autoqual/judge.py`

**1.8 운영 UI — 흐름 화면 (Agent가 도는 과정을 한 화면에)**

* **구현 기능:** 기본 화면인 **「흐름」**에서 질문 하나가 Loop Engineering → CodeAct → Self-Evolving을 거치는 과정을 실시간으로 보여준다. 기존 관제·루프 트레이스·리플레이·리포트·Registry·아카이브·승인·Fab·KPI 화면은 그대로 유지했다

* **동작 원리:**
  * **자막 바**: 시나리오 · 질문 · "지금 Agent가 하는 일" 한 문장 · 지나온 단계 경로
  * **LOOP ENGINEERING**: L3/L1/L2(Grow·Heal)를 트랙(윗변 = 진행, 아랫변 = 되돌아가는 길)으로 그린다. 이벤트가 오면 토큰이 실제 노드를 따라 움직이고, 재시도나 다음 주기는 트랙을 한 바퀴 돌아 표시된다. 루프 사이 연결(확인 불가 → Heal, 처리 불가 → Grow, 경험 → L3, 새 버전 배포 → L1)이 빛나고, 예산 상태(`시도 n/5 · m/15분`)가 표시된다
  * **CODEACT**: Agent가 작성한 코드가 타이핑되듯 나타나고, `LLM 작성 → AST 검사 → import 검사 → 샌드박스 실행 → 사후 검증` 단계와 하위 Agent 호출 결과가 표시된다. Heal 패치와 Evolve 진화는 diff로 보여준다
  * **JEV 판단**: 확률 막대를 표시한다
  * **SELF-EVOLVING**: Agent × 사건 계보(Grow·Heal·Evolve·롤백·폐기 색 구분)를 그리고, 새 버전이 생기면 바로 반짝인다

* **주요 기술:** FastAPI + SSE(EventBus가 모든 node·jev·code·version 이벤트 송출), 빌드 없는 ES 모듈(`ui/static/js/flow.js`), SVG 경로 애니메이션(`getPointAtLength`), 접속 시 이벤트 백로그를 재생해 상태 복원. `version` 이벤트에 진화·롤백 diff를 실어 L3 코드 변경도 CodeAct 패널에 표시

### 주요 문제 해결 및 기술 리서치

구현 과정에서 마주친 기술적 문제와 이를 해결하기 위해 **찾아본 자료(리서치)** 및 **적용한 방법**을 기록합니다.

|           |                                      |                                                                                           |
| --------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| **이슈 구분** | **문제 상황 및 원인**                       | **리서치 및 해결 과정 (Reference & Solution)**                                                    |
| **CodeAct 안전성** | *LLM이 작성한 코드를 그대로 실행하면 파일·네트워크 접근, 평가 하네스 수정, 문자열 `format`을 통한 객체 탈출이 가능* | • **리서치:** CodeAct(Wang et al., *Executable Code Actions Elicit Better LLM Agents*, ICML 2024)의 실행 환경 구성, Python `ast` 모듈, RestrictedPython의 정적 제한 방식 검토 • **적용:** AST 정적 검사(import 화이트리스트·금지 이름·dunder/`format` 속성 차단) + 권한 프록시 + 타임아웃 + 감사 로그. 하네스 import 차단·포맷 탈출 차단은 단위 테스트로 고정(`tests/test_core.py`) |
| **데이터 누출 (리플레이)** | *과거 이력을 재생하며 진화할 때 그 시점 이후에 적재된 이력·교훈을 보면 성능이 부풀려진다(look-ahead bias)* | • **리서치:** 시계열 백테스트의 look-ahead bias와 Walk-forward 검증(López de Prado, *Advances in Financial Machine Learning*, 2018) • **적용:** Time-Travel Guard — 레거시 조회를 `EVT_TS ≤ replay_clock` 뷰로 제한, 이벤트 시각이 없는 테이블은 차단, 메모리 조회에 `before_ts`, 최근 6개월 Held-out 분리. 결과: 리플레이 3,000건 동안 미래 정보 누출 0건(Guard 필터·차단 17,857건) |
| **자기 테스트의 함정 (Grow)** | *생성 Agent가 정상 케이스는 모두 통과했지만, 미등록 부품 코드(FR03)에서 `KeyError`, 분 단위 컬럼(`RMV_USE_MIN`)을 시간으로 보고 사용시간을 60배 과대 계산 — 에러 없는 오답* | • **리서치:** Property-based testing(QuickCheck, Hypothesis)의 경계값·생성 입력 전략, 테스트 오라클을 생성자와 분리하는 원칙 • **적용:** 스키마 탐색 CodeAct가 코드값 분포·결측·경계일에서 엣지 6종(미등록 코드·이력 0건·분/시간 단위 혼재·분기 경계일·소프트 삭제 중복·사용시간 결측)을 도출하고, 기대값은 루프 밖 하네스가 원본 DB로 계산. 1회차 정상 8/8·엣지 4/6 → 2회차 14/14 통과 후에만 등록 |
| **대용량 로그 (Heal)** | *진단 대상 FDC 트레이스(3 Run 약 17,103행, 장기 Run이면 수십만 행)를 원문 그대로 읽으면 LLM 컨텍스트·샌드박스 메모리 초과* | • **리서치:** 로그 분석에서 헤더·이상 지점 주변·층화 샘플만 보는 요약 방식, "코드로 관찰 범위를 줄인 뒤 결과만 LLM에 넘긴다"는 CodeAct 패턴 • **적용:** `read_fdc_trace(slice=header/around/sample)` — 원본 해상도 행은 요청 구간만 그 자리에서 생성. 관찰 37행(원문의 0.22%)으로 포맷 변경 원인 진단 성공 |
| **반복 실패 패치** | *Heal이 기각된 패치를 변수명만 바꿔 다시 시도해 예산 낭비* | • **리서치:** AST 정규화 기반 코드 클론 탐지 • **적용:** 식별자를 정규화한 AST 해시 블랙리스트. HEAL-003 1회차(타임존 미지정 로그를 UTC로 가정 → 구 포맷 정렬 회귀 2건 실패) 기각 후 2회차 44/44 통과 |
| **결함 공용 스킬 전파** | *공용 스킬 `fdc_toolkit` 추출 후 PVD 장비군에서만 판정 불일치 — 의존 Agent 여럿이 동시에 영향* | • **리서치:** 카나리·Shadow 배포(Google, *The Site Reliability Workbook* — Canarying Releases) • **적용:** 승격 후 직전 버전 Shadow 병행, 불일치율 5% 초과 시 Lineage 기준 원자적 롤백(RB-01: `log_agent`·`chamber_trend_agent` 동시), 결함 버전 번호 재사용 금지 |
| **분기 판단 비용·비결정성** | *루프 분기마다 LLM을 부르면 지연·비용이 크고 같은 입력에 판단이 흔들림* | • **리서치:** 확률 보정(Platt scaling, Guo et al., *On Calibration of Modern Neural Networks*, ICML 2017의 temperature scaling) • **적용:** Jev 보정 로지스틱 헤드 + 임계값 게이트(자율/재검토/제외), 고위험 행위는 확률과 무관하게 사람 승인·결정적 코드 |
| **재현성** | *사내 LLM이 아직 연결되지 않은 환경에서 데모·평가 결과가 실행마다 달라지면 KPI를 검증할 수 없음* | • **적용:** 오프라인 Playbook(실제로 실행되는 코드 후보, 일부는 의도적 결함 포함 — 루프가 테스트로 걸러내야 통과) + 시드 고정 목업 + 챕터별 체크포인트. `config/llm.json` 설정 시 같은 인터페이스로 사내 API 사용 |
| **UI 가시성** | *기존 관제 화면은 대화·편성 맵·사고 흐름이 세 칼럼에 흩어져, "질문 → 루프 → 코드 → 진화" 흐름을 한눈에 보기 어려움* | • **리서치:** LangGraph Studio처럼 그래프 위에 실행 위치를 표시하는 방식, 트레이스 뷰(Langfuse)의 단계 나열 방식 • **적용:** 흐름 화면 — 루프를 트랙으로 그리고 토큰이 실제 노드를 따라 이동, 과제 키워드(LOOP ENGINEERING / CODEACT / SELF-EVOLVING)별 영역 분리, 노드마다 한 문장 자막 |

### 핵심 동작 검증

위에서 구현한 기능이 의도대로 동작하는지 보여주는 **대표적인 실행 결과**를 첨부합니다. (오프라인 Playbook 모드, Autopilot 실제 실행 로그에서 발췌)

**[검증 시나리오 1:&#x20;**`SC-001 PM 후 AutoQual — 편성 · CodeAct · 결정적 판정 · 사람 승인`**]**

* **입력:** "ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘" (2026-09-03 09:52)

* **에이전트 동작:**

  1. `parse_request` 엔티티 추출(claude-haiku-5-5) → `retrieve_memory` 교훈 1건·과거 건 10건

  2. Jev 판단: 기존 Agent로 처리 가능? → yes 0.91 / 편성 → spec_agent 0.98 · log_agent 0.95 · legacy_agent 0.91 선택, chamber_trend_agent 0.41 제외

  3. Super Agent가 실행 계획을 코드로 작성(CodeAct) → 샌드박스 실행

     ```python
     spec, log, hist = parallel(("spec_agent", "lookup", req), ("log_agent", "analyze", req), ("legacy_agent", "history", req))
     signals = dict(log.get("signals", {}))
     rec = call("spec_agent", "recommend", dict(req, eqp_model=spec["eqp_model"], seasoning=spec["seasoning"], signals=signals))
     ```

  4. 사후 검증 목표 충족 → 종합: 기본 25매에 교훈 L-0029(ETX-300 Wet Clean 후 RF Reflected 10% 이상 → +10매, 원천 이력 32건) 보정

  5. Qual 측정 → `judge_qual`(결정적 코드) PASS → 승인 게이트(interrupt) → 운영자 승인 후 Up 반영 → 경험 기록

* **최종 결과:**

[실제 에이전트 답변: "Seasoning 35매 → Particle → ER Monitor / 보정: 기본 25매 +10매 [교훈 L-0029 … 원천 이력 32건]" → "Leak 0.8 mTorr/min / Particle 9 ea / ER 1,872 Å/min / Unif 2.1% → Qual PASS / 승인 요청: ETCH-07-B DOWN → UP 전환" → "ETCH-07-B DOWN → UP 반영 완료 (승인자 운영자)"]

**[검증 시나리오 2:&#x20;**`SC-002 처음 보는 요청 → Grow (스키마 탐색 기반 엣지 케이스 테스트)`**]**

* **입력:** "지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘" (2026-09-10 10:30)

* **에이전트 동작:**

  1. Jev: 기존 Agent로 처리 가능? → no (part_usage 능력 없음) → L2 Grow 진입, 아카이브 유사 Genome 없음 → 신규 명세 작성

  2. 스키마 탐색 CodeAct: PRT_CHG_HIS 3,830행 · 부품 코드 PRT_CD 23종(사전 15종 + 패턴 추론 8종) → **엣지 후보 6종 도출**(미등록 부품 코드 FR03, 교체 이력 0건 CVD-01-A, `RMV_USE_MIN`·`RF_ON_MIN` 분 단위 컬럼, 분기 경계일 2026-03-31 교체, 소프트 삭제 중복 3행, 결측 3일 챔버)

  3. 1회차 코드·테스트 생성 → **12/14 통과 — 정상 8/8 · 엣지 4/6**. 실패 내용: 미등록 부품 코드에서 `KeyError: 'FR03'`, 분/시간 단위 혼재에서 제거 부품 사용시간 32,672h(기대 545h, 60배 과대)

  4. 2회차: 분→시간 환산, 미등록 코드 '미해석' 표기로 수정 → **14/14 통과**(행 수 대조: 분석 대상 1차 Fail 21건 = legacy_agent 집계 21건) → `part_history_agent 0.1.0` probation 등록 → L1 복귀

* **최종 결과:**

[실제 에이전트 답변: "2026 Q2 ETCH Qual 125건 (1차 Fail 21건) / Focus Ring 사용시간별 1차 Fail율: 0~300h 11% (7/64) / 300~600h 22% (8/37) / 600~ 25% (6/24) / 600h 초과 상태 PM 시 1차 Fail 위험 2.3배 / 제안: 600h 초과 챔버는 PM 시 Focus Ring 동시 교체 또는 Seasoning 보정 검토" + "신규 생성 Agent 처리 — 자가 테스트: 정상 케이스 8건 + 생성 엣지 케이스 6건, 소요시간 3분 49초"]

**[검증 시나리오 3:&#x20;**`SC-003 로그 포맷 변경 → Heal (로그 슬라이싱 진단 · 블랙리스트 · 연쇄 복구)`**]**

* **입력:** "CVD-12 A챔버 RF Generator 교체했어. AutoQual 해줘" (장비 SW v5.2 업데이트로 FDC 로그 포맷 변경 — 장애 주입기)

* **에이전트 동작:**

  1. `log_agent 1.1.0` 실행 오류(`KeyError: RF_FWD_PWR`) → 해당 항목만 "확인 불가"로 먼저 응답, L2 Heal 진입

  2. Jev 오류 분류 확신도 0.64 < 0.70 → 진단 코드 먼저 실행 후 재분류 → 포맷 변경(Jev 0.90)

  3. 진단 CodeAct(로그 슬라이싱): **PM 전후 FDC 트레이스 3 Run 약 17,103행 중 헤더 2종 + 오류 지점 전후 각 10행 + Run별 샘플 5행만 추출 → LLM 관찰값 37행(원문의 0.22%)** → 원인: 헤더 `ts,recipe.step,rf.forward.w,…`, 시간 표기 ISO8601·타임존 없음

  4. 패치 1회차(타임존 미지정 로그를 UTC로 가정) → 회귀 42/44, 구 포맷 정렬 2건 실패 → 블랙리스트 등록 / 패치 2회차(장비 로컬시각 기준) → 회귀 44/44 통과 → `log_agent 1.1.0 → 1.1.1`

  5. 같은 오류 시그니처를 가진 `chamber_trend_agent 1.0.0 → 1.0.1` 연쇄 복구(회귀 22/22) → "확인 불가" 항목 재응답

* **최종 결과:**

[실제 에이전트 답변: "추가 응답 — HEAL-003 복구 후 재분석 · log_agent 1.1.1: Leak Rate 0.82 mTorr/min / RF Reflected Power 초기값 PM 전 대비 -0.2% / RF Forward 변동 0.21% (안정) / Base Pressure 안정화 12분 → Seasoning 기본 매수 유지 권장 (15매)" → "Qual PASS → CVD-12-A DOWN → UP 반영 완료 (승인자 운영자)"]

**[자동 검증]**

* 단위 테스트 `python -m unittest discover tests` — 22건 통과: 샌드박스 보안 6건, `judge_qual` 엣지 6건, Time-Travel Guard·읽기 전용, 엔티티 모호성, 버전 규칙, SC-001 편성, Grow 필요 판단, 기준 회귀, 그리고 이번에 추가한 **로그 슬라이싱 관찰 비율**(`test_heal_diagnosis_slices_log`), **엣지 케이스가 1회차 결함을 잡는지**(`test_grow_edge_cases_catch_naive_agent`)

**[KPI 측정 결과]** — Autopilot 전체 타임라인(ch00 초기 구축 → ch11 SC-009) 1회 실행 후 `eval/kpi.py`(루프가 수정할 수 없는 고정 코드)로 계산. 16개 지표 모두 목표 달성

| 지표 | 목표 | 측정값 | 근거 |
| --- | --- | --- | --- |
| Qual 준비·판정 소요시간 | 70% 단축 | **95.0% 단축** | Agent 판단 준비 12.1s + 검토 5분 vs 수작업 105분 (요청 320건) |
| AutoQual 판정 정확도 | 95% | **100%** | Held-out 494건 Pass/Fail 판정 일치 (결정적 `judge_qual`) |
| 이력 리플레이 진화 효과 | +15%p | **+19.4%p** | Held-out 종합 판정 일치율 65.59% → 85.02% |
| 미래 정보 누출 | 0건 | **0건** | Time-Travel Guard 필터·차단 17,857건 |
| Qual 1차 Pass율 | +15%p | **+15.2%p** | Held-out 백테스트 71.46% → 86.64% (SC-007 판단 진화 포함) |
| Agent 자동 생성 성공률 | 70% | **100%** | 미지원 요청 3건 → chamber_trend · part_history · lot_trace 생성·테스트 통과 |
| 오류 자가 복구율 | 70% | **71.4%** | 장애 영향 Agent 7건 중 5건 자동 복구 (복구 불가 조기 중단 2건은 분모 포함) |
| 평균 복구 시간(MTTR) | 10분 이내 | **4.1분** | 장애 감지 → 패치 반영 (가상 시각) |
| 루프 폭주 | 0건 | **0건** | L2 루프 6회 — 예산(5회·15분) 초과 0건 |
| 진화 후 구조 개선(코드 중복) | 50% 감소 | **100% 감소** | 코드 중복률 39% → 0% (공용 스킬 fdc_toolkit 추출) |
| 진화 후 응답시간 | 30% 단축 | **56% 단축** | log_agent p50 9.0s → 4.0s |
| 엔지니어 Override율 | 50% 감소 | **81% 감소** | ETX-300 Wet Clean 25% → 5% (판단 진화 후) |
| Agent 호출 효율 | 20% 감소 | **21% 감소** | 요청당 호출 Agent 2.9 → 2.3 (편성 전략 진화) |
| 불필요 Agent 정리 | 잔존 0개 | **0개** | retired 2개 · 보류(사유 기록) 1개 · 폐기로 인한 요청 실패 0건 |
| 진화 퇴화 | 0건 | **0건** | 채택 15건 중 Held-out 하락 채택 0건 · Shadow 불일치 자동 롤백 1건 |
| 무승인 장비 상태 변경 | 0건 | **0건** | 상태 변경 요청 320건 전부 승인 패널 경유 |
