# AI Master 프로젝트 — AutoQual Self-Evolving Agent

이 레포는 AI Master 프로젝트의 **전 과정 기록 저장소**다. 아이디에이션 → 기획 → 설계 → 구현 → 평가까지 모든 산출물을 이 레포에 남긴다. 새 작업을 할 때도 결과물(문서·코드·데이터·실험 기록)은 반드시 이 레포 안에 단계별로 정리한다.

## 확정 주제 (01 AutoQual)

**AutoQual Self-Evolving Agent: CodeAct와 Loop Engineering으로 스스로 생성·복구·진화하는 AutoQual 멀티 에이전트**

- 도메인: 반도체 장비가 PM·부품 교체·알람으로 Down된 뒤 Seasoning·Qual 판정을 거쳐 Up되는 AutoQual 업무
- 핵심 구조: Super Agent가 기준정보(`spec_agent`)·로그분석(`log_agent`)·레거시DB(`legacy_agent`) Agent를 편성하고, 모든 Agent는 CodeAct(Python 코드를 행동으로 실행)로 동작
- Self-Evolving: Grow(새 Agent 생성) / Heal(오류 자가 복구) / Evolve(5계층 개선: 파라미터·프롬프트 → 스킬 → Agent 코드 → Agent 구성(생성·병합·폐기) → Super Agent 편성 전략), 변이 → 평가 → 선택 → 보관 사이클. 불필요 Agent는 Retire 절차(의존성 분석 → 대체 검증 → `deprecated` 유예 → 사람 승인 → `retired` 아카이브 보관)로 정리
- Loop Engineering: L1 Task / L2 Heal·Grow(최대 5회·15분) / L3 Evolve 3중 루프, 예산·종료 조건·검증 게이트
- 이력 리플레이 진화: 3년치 과거 Qual 이력을 시간순 재생(Walk-forward, 최근 6개월 Held-out), Time-Travel Guard로 미래 정보 누출 차단
- Jev 판단 게이트: 루프 내 반복 분기 판단은 Jev(보정 확률), 코드 작성·계획은 LLM, Spec 판정·권한은 결정적 코드

다른 후보(eWorks Self-Healing, Persona Swarm, Talk-to-Fab)는 `docs/00_ideation/`에 기록으로만 보존하며, 이후 작업은 모두 AutoQual 기준으로 진행한다.

## 레포 구조

```
aimaster/
├─ CLAUDE.md
├─ docs/                                   # 제출 산출물은 하위 폴더 없이 여기에 모은다
│  ├─ 00_ideation/                         # 주제 선정 전 후보 기록 (보존만, 수정하지 않음)
│  │  ├─ 01_eWorks_Self-Healing_Hybrid_Agent/   # AutoQual의 전신 (v1 → v2 → 기획서)
│  │  ├─ 02_Persona_Swarm/
│  │  └─ 03_Talk-to-Fab/                   # 초안·시나리오 + demo/ (디지털트윈 웹 데모)
│  ├─ 01_AutoQual_Self-Evolving_Agent_*.md # 산출물 (아래 문서 맵)
│  └─ format.md                            # 설계서 양식
│
├─ mock_env/      # 목업 Fab: config·simulator(Qual 물리)·generate(DB 생성, 시드 고정)·formats(SW 버전별 로그)·world(데이터 서버·장애 주입·MES)
│                 #   data/*.db 는 생성물 (python -m mock_env.generate 로 재생성, git 제외)
├─ autoqual/      # 에이전트 본체: system·store·sandbox(CodeAct)·tools·jev·llm(사내 API 어댑터)·registry·runtime·super_agent·judge·memory
│  ├─ genomes/    #   Agent·스킬 Genome 소스 빌더 + 오프라인 Playbook (기능 플래그 → 실제 코드)
│  ├─ loops/      #   l1(LangGraph L1), l2_heal, l2_grow(Agent Factory), l3_evolve(리플레이 분기 진화), l3_ops(운영 진화·롤백·폐기), replay
│  ├─ ops.py      #   요청 실행기 + 배경 운영 시뮬레이터(가상 엔지니어)
│  └─ story.py    #   Autopilot 타임라인 (SC-006 → SC-009, 챕터 체크포인트)
├─ eval/          # 루프 밖 고정: policy.json(예산·임계값), harness(테스트·후보 평가), testcases(오라클), kpi
├─ ui/            # 운영 UI: FastAPI + SSE 서버, static/ (빌드 없는 ES 모듈, 오프라인 폰트) — 기본 화면 「무대」(board.js = stage 루프 트랙 + graph 편성 + evolve 진화 사건), 「대화」(live.js = 채팅 + graph + trace), 「Fab·업무」(biz.js)
├─ config/        # llm.example.json(사내 LLM API), jev.example.json — 실제 llm.json·jev.json 은 git 제외
├─ runtime/       # 실행 상태(agentstore.db·legacy_live.db·checkpoints) — git 제외
└─ tests/         # python -m unittest discover tests
```

실행: `pip install -r requirements.txt` → `python -m mock_env.generate` → `python -m ui.server` (http://127.0.0.1:8765) → UI에서 Autopilot 시작. LLM은 사내 제공 API만 사용한다(`config/llm.json`, 키는 환경변수). 미설정 시 오프라인 Playbook으로 결정적 재현.

## 문서 맵

| 단계 | 파일 | 내용 |
| --- | --- | --- |
| 아이디에이션 | `docs/00_ideation/*/` | 후보 주제 3종과 시나리오, Talk-to-Fab 데모 |
| 기획 (확정) | `docs/01_AutoQual_Self-Evolving_Agent_기획서.md` | 배경·목표·KPI·핵심 기능 10개·범위 |
| 시나리오 | `docs/01_AutoQual_Self-Evolving_Agent_시나리오.md` | 사용자·운영 시나리오 |
| 설계 양식 | `docs/format.md` | 설계서 템플릿 |
| 상세 설계 및 개발 환경 구축 | `docs/01_AutoQual_Self-Evolving_Agent_상세설계_및_개발환경구축.md` | Agent 페르소나, LangGraph 워크플로우·상태, 도구 명세, 메모리 전략, 기술 스택 (구 설계서) |
| PoC 모듈 구현 | `docs/01_AutoQual_Self-Evolving_Agent_PoC_모듈구현.md` | 핵심 구현(워크플로우·도구·메모리·CodeAct·3중 루프·Self-Evolving·Jev·무대 UI), 문제 해결·리서치, 동작 검증(SC-001~003 실행 결과)·KPI 실측 |
| 테스트 및 고도화 | `docs/01_AutoQual_Self-Evolving_Agent_테스트_및_고도화.md` | 작성 예정 (양식은 사용자 제공) |
| E2E 서비스 개발 | `docs/01_AutoQual_Self-Evolving_Agent_E2E_서비스개발.md` | 작성 예정 (양식은 사용자 제공) |

기능·KPI·도구 시그니처의 **기준(Source of Truth)은 위 기획서와 상세 설계서**다. 구현이 설계와 달라지면 상세 설계서도 함께 갱신한다.

## 데이터 정책 — 전부 목업

사내 실데이터는 사용할 수 없다. **기준정보 DB, FDC 센서 트레이스, 알람 로그, 부품 교체 이력, 레거시 Qual 이력 DB 등 모든 데이터·로그는 Claude가 목업으로 생성한다.** 목업은 데모용 장난감이 아니라 Agent의 Heal·Grow·Evolve가 실제로 일어날 만큼 현실적이어야 한다.

- 규모 (기획서 기준): 장비 30대 · 챔버 90개 · PM 종류 8개, Qual 이력 3,000건 / 3년치 (엔지니어 조치 기록 포함)
- 현실감 요소를 의도적으로 넣는다
  - 레거시 DB: 약어 컬럼, 문서화 안 된 코드값, 폐기 테이블 잔존, 이관·미적재 구간
  - 장비 SW 버전별로 다른 로그 포맷 (기간에 따라 파서가 깨지도록)
  - Seasoning 매수 ↔ 1차 Pass율 관계, 장비 모델·PM 종류별 편향 등 진화로 학습할 수 있는 숨은 패턴
  - 센서 노이즈, 결측, 단위 혼재 같은 실무형 지저분함
- 장애 주입기: 로그 포맷 변경, DB 컬럼 변경, 타임아웃, 단위 변경을 재현할 수 있게 만든다
- 생성 스크립트는 **시드 고정으로 재현 가능**하게 하고, 데이터에 심은 패턴·정답(ground truth)은 별도로 문서화해 KPI 평가에 쓴다
- 실제 회사명·실제 장비 레시피·실제 사내 코드 체계를 쓰지 않는다. 용어와 구조만 실무 경험에 맞추고 ID·값은 가상으로 만든다

## 설계상 불변 규칙 (구현 시 지킬 것)

- 장비 상태 변경(Down→Up)은 반드시 사람 승인을 거친다 (무승인 변경 0건)
- Spec Pass/Fail 판정은 LLM이 아니라 결정적 코드(`judge_qual`)가 한다
- 생성·수정 코드는 샌드박스에서만 실행 (허용 import 화이트리스트, AST 정적 검사, 읽기 전용 권한 프록시, 감사 로그)
- 평가 하네스·Held-out셋·루프 예산은 루프가 수정할 수 없는 곳에 고정한다
- 리플레이 중에는 `event_ts ≤ replay_clock` 데이터만 조회 (Time-Travel Guard)
- 원본 데이터·레거시 시스템은 읽기 전용, 모델 파인튜닝은 범위 밖

## 기술 스택 (설계서 기준)

- LLM: **사내 제공 API만 사용** (`autoqual/llm.py` 어댑터, OpenAI·Anthropic 호환 형식). 역할별 모델 `claude-opus-5-5`(Factory·Heal·Evolve 코드 생성), `claude-sonnet-5-5`(Super Agent 계획·종합), `claude-haiku-5-5`(요약·엔티티 추출). Jev(분기 판단) — 사내망 반입 전에는 로컬 보정 로지스틱 헤드
- Agent Framework: LangGraph (StateGraph + Subgraph + Checkpointer + interrupt)
- 저장소: PostgreSQL 단일 DB (Registry·경험 메모리·진화 아카이브·Lineage), RAG 미사용 — PoC 구현은 동일 스키마를 SQLite(WAL)로 사용
- Output: Pydantic Structured Output
- Monitoring: Langfuse(셀프호스팅) + OpenTelemetry
- 운영 UI: 채팅, Agent 편성 그래프, 루프 트레이스, 승인 패널, 진화 리포트·아카이브, Lineage 뷰

## 진행 현황

- [x] 아이디에이션 (후보 4종 비교)
- [x] 주제 확정: 01 AutoQual Self-Evolving Agent
- [x] 기획서·시나리오·설계서 작성
- [x] Mock AutoQual 환경 (목업 데이터 생성기 + 장애 주입기) — `mock_env/`
- [x] CodeAct 런타임·샌드박스 / Agent Registry
- [x] Super Agent + 메인 Agent 3종 (L1 Task Loop, LangGraph)
- [x] Heal·Grow (L2) → Evolve·이력 리플레이 (L3), 운영 진화(판단·구조·편성)·롤백·폐기
- [x] 운영 UI (Autopilot 타임라인 SC-006 → SC-009) + 무대(루프 트랙 · 편성 그래프 · Self-Evolving 사건) · 대화(채팅 · 동적 편성 맵 · 트레이스) · Fab·업무(AutoQual 단계)
- [x] 시나리오 개정 반영: SC-002 스키마 탐색 기반 엣지 케이스 테스트, SC-003 로그 슬라이싱 진단
- [x] PoC 모듈 구현 문서
- [x] KPI 측정 — `eval/kpi.py`, 운영 UI KPI 화면
- [ ] 사내 LLM API 실연동 검증 (`config/llm.json` 설정 후 온라인 모드 실행)

## 작업 규칙

- 사용자와의 대화와 문서는 한국어로 작성한다
- 산출물 문서는 하위 폴더 없이 `docs/` 바로 아래에 `01_AutoQual_Self-Evolving_Agent_종류.md` 형식으로 둔다. 새 md 문서는 사용자가 요청하거나 양식을 준 경우에만 만든다
- 파일 이동·이름 변경은 `git mv`로 해서 이력을 유지한다
- 단계가 끝나면 위 진행 현황 체크리스트를 갱신한다
