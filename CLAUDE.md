# AI Master 프로젝트 — AutoQual Self-Evolving Agent

이 레포는 AI Master 프로젝트의 **전 과정 기록 저장소**다. 아이디에이션 → 기획 → 설계 → 구현 → 평가까지 모든 산출물을 이 레포에 남긴다. 새 작업을 할 때도 결과물(문서·코드·데이터·실험 기록)은 반드시 이 레포 안에 단계별로 정리한다.

## 확정 주제 (01 AutoQual)

**AutoQual Self-Evolving Agent: CodeAct와 Loop Engineering으로 스스로 생성·복구·진화하는 AutoQual 멀티 에이전트**

- 도메인: 반도체 장비가 PM·부품 교체·알람으로 Down된 뒤 Seasoning·Qual 판정을 거쳐 Up되는 AutoQual 업무
- 핵심 구조: Super Agent가 기준정보(`spec_agent`)·로그분석(`log_agent`)·레거시DB(`legacy_agent`) Agent를 편성하고, 모든 Agent는 CodeAct(Python 코드를 행동으로 실행)로 동작
- Self-Evolving: Grow(새 Agent 생성) / Heal(오류 자가 복구) / Evolve(5계층 개선: 파라미터·프롬프트 → 스킬 → Agent 코드 → Agent 구성 → Super Agent 편성 전략), 변이 → 평가 → 선택 → 보관 사이클
- Loop Engineering: L1 Task / L2 Heal·Grow(최대 5회·15분) / L3 Evolve 3중 루프, 예산·종료 조건·검증 게이트
- 이력 리플레이 진화: 3년치 과거 Qual 이력을 시간순 재생(Walk-forward, 최근 6개월 Held-out), Time-Travel Guard로 미래 정보 누출 차단
- Jev 판단 게이트: 루프 내 반복 분기 판단은 Jev(보정 확률), 코드 작성·계획은 LLM, Spec 판정·권한은 결정적 코드

다른 후보(eWorks Self-Healing, Persona Swarm, Talk-to-Fab)는 `docs/00_ideation/`에 기록으로만 보존하며, 이후 작업은 모두 AutoQual 기준으로 진행한다.

## 레포 구조

```
aimaster/
├─ CLAUDE.md
├─ docs/                                   # 단계별 문서 (번호 = 진행 순서)
│  ├─ 00_ideation/                         # 주제 선정 전 후보 기록 (보존만, 수정하지 않음)
│  │  ├─ 01_eWorks_Self-Healing_Hybrid_Agent/   # AutoQual의 전신 (v1 → v2 → 기획서)
│  │  ├─ 02_Persona_Swarm/
│  │  └─ 03_Talk-to-Fab/                   # 초안·시나리오 + demo/ (디지털트윈 웹 데모)
│  ├─ 01_planning/                         # 확정 주제 기획서·시나리오
│  ├─ 02_architecture/                     # 설계서 + format.md(설계서 양식)
│  └─ (03_ 이후: 데이터 명세, 구현 기록, 평가 리포트 등 단계가 진행되면 추가)
│
│  # ↓ 개발 단계에서 만들 예정 (설계서 기준 초안, 구현 시작 시 확정)
├─ mock_env/      # 목업 데이터 생성기·장애 주입기·생성된 Mock DB/로그
├─ autoqual/      # 에이전트 본체: Super Agent, 메인 Agent 3종, CodeAct 런타임, Registry, L1/L2/L3 루프
├─ eval/          # 고정 평가 하네스, Evolve/Held-out셋, KPI 측정 스크립트 (루프가 수정 불가)
├─ ui/            # 운영 UI
└─ tests/
```

## 문서 맵

| 단계 | 파일 | 내용 |
| --- | --- | --- |
| 아이디에이션 | `docs/00_ideation/*/` | 후보 주제 3종과 시나리오, Talk-to-Fab 데모 |
| 기획 (확정) | `docs/01_planning/01_AutoQual_Self-Evolving_Agent_기획서.md` | 배경·목표·KPI·핵심 기능 10개·범위 |
| 시나리오 | `docs/01_planning/01_AutoQual_Self-Evolving_Agent_시나리오.md` | 사용자·운영 시나리오 |
| 설계 | `docs/02_architecture/01_AutoQual_Self-Evolving_Agent_설계서.md` | Agent 페르소나, LangGraph 워크플로우·상태, 도구 명세, 메모리 전략, 기술 스택 |
| 설계 양식 | `docs/02_architecture/format.md` | 설계서 템플릿 |

기능·KPI·도구 시그니처의 **기준(Source of Truth)은 위 기획서와 설계서**다. 구현이 설계와 달라지면 설계서도 함께 갱신한다.

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

- LLM: `claude-opus-5-5`(Factory·Heal·Evolve 코드 생성), `claude-sonnet-5-5`(Super Agent 계획·종합), `claude-haiku-5-5`(요약·엔티티 추출), Jev(분기 판단, 대안 SemIf 또는 소형 분류 모델)
- Agent Framework: LangGraph (StateGraph + Subgraph + Checkpointer + interrupt)
- 저장소: PostgreSQL 단일 DB (Registry·경험 메모리·진화 아카이브·Lineage), RAG 미사용
- Output: Pydantic Structured Output
- Monitoring: Langfuse(셀프호스팅) + OpenTelemetry
- 운영 UI: 채팅, Agent 편성 그래프, 루프 트레이스, 승인 패널, 진화 리포트·아카이브, Lineage 뷰

## 진행 현황

- [x] 아이디에이션 (후보 4종 비교)
- [x] 주제 확정: 01 AutoQual Self-Evolving Agent
- [x] 기획서·시나리오·설계서 작성
- [ ] Mock AutoQual 환경 (목업 데이터 생성기 + 장애 주입기)
- [ ] CodeAct 런타임·샌드박스 / Agent Registry
- [ ] Super Agent + 메인 Agent 3종 (L1 Task Loop)
- [ ] Heal·Grow (L2) → Evolve·이력 리플레이 (L3)
- [ ] 운영 UI
- [ ] KPI 평가 및 최종 보고

## 작업 규칙

- 사용자와의 대화와 문서는 한국어로 작성한다
- 문서는 `docs/NN_단계명/` 아래에 `NN_주제명_종류.md` 형식(예: `01_AutoQual_Self-Evolving_Agent_설계서.md`)으로 둔다
- 파일 이동·이름 변경은 `git mv`로 해서 이력을 유지한다
- 단계가 끝나면 위 진행 현황 체크리스트를 갱신한다
