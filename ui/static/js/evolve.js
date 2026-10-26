// Self-Evolving 패널 — "무엇이 감지돼 → 어떤 후보(5계층)가 만들어져 → 루프 밖 하네스로 어떻게 평가돼 → 무엇이 채택·반영됐는지"를 사건 단위로 보여준다.
//   왼쪽: 진화 사건 피드 (Grow · Heal · Evolve(분기/판단/구조/편성/병합) · 롤백 · 폐기) — 리포트에서 만들고, 진행 중인 런은 이벤트로 파이프라인이 채워진다
//   오른쪽: 5계층 요약 + Agent Genome 계보(행 = Agent, 열 = 사건, 알약 = 새 버전)
import { $, h, api, vdate, AGENT_KO, short, diffLines } from './util.js';
import { Evo } from './stage.js';

let A = null;
const t = (vts) => vdate(vts).t;
const LAYERS = [['①', '파라미터·교훈', 'Jev 임계값·Seasoning 보정 계수·교훈 세트'], ['②', '스킬', '성공한 CodeAct를 공용 함수로'], ['③', 'Agent 코드', '파서·SQL·판정 로직 패치'],
  ['④', 'Agent 구성', '생성·병합·분리·폐기'], ['⑤', '편성 전략', 'Super Agent 호출 규칙·템플릿·임계값']];
const KIND = {
  grow: ['GROW', 'l2', 'Agent 생성'], heal: ['HEAL', 'l2', 'Self-Healing'], quarter: ['EVOLVE', 'l3', '분기 진화 (리플레이)'], judgment: ['EVOLVE', 'l3', '판단 진화 (운영 결과 학습)'],
  structure: ['EVOLVE', 'l3', '구조 진화 (중복·성능)'], orchestration: ['EVOLVE', 'l3', '편성 전략 진화'], merge: ['EVOLVE', 'l3', '병합 재도전 (아카이브 출발)'],
  rollback: ['ROLLBACK', 'bad', '자동 롤백'], retire: ['RETIRE', 'warn', 'Agent 폐기 검토'], replay: ['REPLAY', 'l3', '리플레이 최종 평가'],
};
const STEPS = { evolve: ['감지', '변이 후보', '하네스 평가', '선택·반영'], heal: ['오류 감지', 'Jev 분류·진단', '패치·회귀 테스트', '버전 반영'], grow: ['처리 불가 감지', '명세·스키마 탐색', '코드·테스트 생성', 'probation 등록'],
  rollback: ['Shadow 불일치', '원인', '원자적 롤백', 'Held-out 추가'], retire: ['미사용 감지', '의존성·대체 검증', '유예(deprecated)', '승인·아카이브'], replay: ['재생', '분기 진화', 'Held-out 평가', '결과'] };
const NODE_STEP = { collect_metrics: 0, analyze_cause: 0, cluster_recheck: 0, classify_override: 0, jev_need_evolve: 0, jev_need_grow: 0, jev_need_retire: 0, jev_need_merge: 0,
  mutate: 1, evaluate_harness: 2, verify_replacement: 1, migrate_tests: 2, select: 3, archive: 3, shadow_run: 3, promote: 3, auto_rollback: 2,
  start: 0, jev_classify_error: 1, heal_history: 1, diagnose_codeact: 1, write_patch: 2, check_blacklist: 2, run_regression: 2, blacklist_patch: 2, register_version: 3, cascade: 3, reanswer_pending: 3, escalate_operator: 3,
  search_archive: 0, restore_genome: 2, write_spec: 1, explore_schema: 1, generate_code_and_tests: 2, run_tests: 2, register_probation: 3, abort_with_reason: 3 };

function kindOf(r) {
  if (r.kind === 'evolve') return (r.content || {}).kind || ((r.content || {}).quarter ? 'quarter' : 'quarter');
  return r.kind;
}
function layerNo(s) { const m = /[①②③④⑤]/.exec(String(s || '')); return m ? '①②③④⑤'.indexOf(m[0]) : -1; }

export const Evolve = {
  el: {}, cards: new Map(), live: new Map(), loaded: false, layerCnt: [0, 0, 0, 0, 0], first: true,
  init(app, host) {
    A = app;
    const e = this.el;
    e.feed = h('div', { class: 'ev-feed' });
    e.layers = h('div', { class: 'ev-layers' });
    e.sum = h('div', { class: 'ev-sum' });
    e.lin = h('div', { class: 'ev-lin' });
    host.append(
      h('header', { class: 'fp-h' }, h('b', { class: 'kw l3' }, 'SELF-EVOLVING'),
        h('span', { class: 'fp-d' }, 'Agent가 자기 자신을 바꾼 기록 — 감지 → 변이(5계층) → 루프 밖 하네스 평가 → 선택(Evolve셋 개선 ∧ Held-out 비하락) → 보관·반영'), e.sum),
      h('div', { class: 'ev-body' },
        h('div', { class: 'ev-left' }, h('div', { class: 'ev-sh' }, h('b', {}, '진화 사건'), h('span', { class: 'muted' }, '최근 순 · 펼치면 후보·점수·diff')), e.feed),
        h('div', { class: 'ev-right' }, h('div', { class: 'ev-sh' }, h('b', {}, '진화 대상 5계층'), h('span', { class: 'muted' }, '채택된 변경 수')), e.layers,
          h('div', { class: 'ev-sh' }, h('b', {}, 'Agent Genome 계보'), h('span', { class: 'muted' }, '행 = Agent · 열 = 사건(시간순) · 알약 = 새 버전')), e.lin)));
    Evo.build(e.lin);
    Evo.sync();
    this.renderLayers();
    this.load();
  },
  async load() {
    let list = [];
    try { list = await api('/api/reports'); } catch (err) { return; }
    const rows = list.filter((r) => ['evolve', 'heal', 'grow', 'rollback', 'retire', 'replay'].includes(r.kind)).slice(0, 60);
    const full = await Promise.all(rows.map((r) => api(`/api/report/${r.report_id}`).catch(() => null)));
    this.el.feed.innerHTML = '';
    this.cards.clear();
    this.layerCnt = [0, 0, 0, 0, 0];
    for (const r of full.filter(Boolean).sort((a, b) => (a.ts > b.ts ? 1 : a.ts < b.ts ? -1 : 0))) this.add(r, false);   // 오래된 것부터 prepend → 최신이 위
    this.renderLayers();
    this.loaded = true;
    if (!this.el.feed.childElementCount) this.el.feed.append(h('div', { class: 'ev-empty' }, 'Autopilot을 시작하면 리플레이 분기 진화(SC-006)부터 Agent가 스스로 바뀐 기록이 여기 쌓입니다.'));
  },
  renderSum() {
    const st = A.state?.counts || {};
    const rows = Evo.rows || [];
    const n = (k) => rows.filter((r) => k.includes(r.kind) && (r.from_version !== r.to_version || r.kind === 'retire')).length;
    this.el.sum.innerHTML = '';
    this.el.sum.append(...[['l2', 'Grow', n(['grow'])], ['l2', 'Heal', n(['heal'])], ['l3', 'Evolve 채택', n(['evolve', 'compose'])], ['ok', '승격', n(['promote'])],
      ['bad', '롤백', n(['rollback'])], ['gone', '폐기', n(['retire'])], ['base', '교훈', st.lessons ?? 0], ['base', '아카이브', st.archive ?? 0]]
      .map(([c, k, v]) => h('span', { class: `ec ${c}` }, h('i', {}), k, h('b', {}, v))));
  },
  renderLayers() {
    const e = this.el;
    e.layers.innerHTML = '';
    LAYERS.forEach(([no, name, desc], i) => e.layers.append(h('div', { class: `ev-layer ${this.layerCnt[i] ? 'on' : ''}`, title: `${no} ${name} — ${desc}` }, h('b', {}, no), h('div', {}, h('div', { class: 'ln' }, name), h('div', { class: 'ld' }, desc)), h('em', {}, String(this.layerCnt[i])))));
    this.renderSum();
  },

  // ── 카드 ────────────────────────────────────────────────
  add(r, live) {
    const c = r.content || {};
    const k = kindOf(r);
    const card = this.card(r, k, c);
    const old = this.cards.get(r.report_id) || this.live.get(r.report_id);
    if (old) old.el.replaceWith(card.el); else this.el.feed.prepend(card.el);
    this.cards.set(r.report_id, card);
    this.live.delete(r.report_id);
    for (const x of c.candidates || []) if (x.decision === 'adopt' && layerNo(x.layer) >= 0) this.layerCnt[layerNo(x.layer)] += 1;
    if (k === 'heal' && c.status === 'healed') this.layerCnt[2] += 1;
    if (k === 'grow' && c.ok) this.layerCnt[3] += 1;
    if (k === 'retire') this.layerCnt[3] += (c.items || []).filter((x) => x.decision === 'deprecated').length;
    if (k === 'orchestration' && c.change) this.layerCnt[4] += 1;
    if (k === 'structure' && (c.changes || []).length) this.layerCnt[1] += 1;
    if (live) { card.el.classList.add('new'); this.renderLayers(); if (this.first || !card.open) this.toggle(card, true); }
    return card;
  },
  card(r, k, c) {
    const [badge, cls, name] = KIND[k] || ['EVOLVE', 'l3', k];
    const stepsKey = ['heal', 'grow', 'rollback', 'retire', 'replay'].includes(k) ? k : 'evolve';
    const res = this.result(k, c);
    const card = { id: r.report_id, open: false, el: null, stepsKey };
    const steps = h('div', { class: 'ev-steps' }, ...STEPS[stepsKey].map((s, i) => h('span', { class: `es done ${i === 3 && res.cls === 'bad' ? 'bad' : ''}` }, h('i', {}, String(i + 1)), s)));
    const body = h('div', { class: 'ev-cb', hidden: true });
    const head = h('div', { class: 'ev-ch', onclick: () => this.toggle(card) },
      h('span', { class: `ev-badge ${cls}` }, badge), h('span', { class: 'ev-id' }, r.report_id), h('span', { class: 'ev-title' }, this.title(k, c, r)),
      h('span', { class: `ev-res ${res.cls}` }, res.text), h('span', { class: 'ev-ts' }, String(r.ts).slice(0, 16)), h('span', { class: 'ev-tog' }, '▸'));
    card.el = h('article', { class: `ev-card ${cls}` }, head, h('div', { class: 'ev-sub' }, h('span', { class: 'ev-kind' }, name), steps), body);
    card.body = body; card.head = head; card.detail = () => this.detail(k, c, r);
    return card;
  },
  toggle(card, force) {
    card.open = force != null ? force : !card.open;
    card.body.hidden = !card.open;
    card.el.classList.toggle('open', card.open);
    card.head.querySelector('.ev-tog').textContent = card.open ? '▾' : '▸';
    if (card.open && !card.body.childElementCount && card.detail) { try { card.body.append(...card.detail()); } catch (e) { console.error(e); card.body.append(h('div', { class: 'muted' }, String(e))); } }
    if (card.open) this.first = false;
  },
  result(k, c) {
    if (k === 'heal') return c.status === 'healed' ? { text: `${c.from_version} → ${c.to_version} · MTTR ${c.mttr}`, cls: 'ok' } : c.status === 'external' ? { text: '외부 장애 — 패치 없음', cls: 'warn' } : { text: '중단 → 운영자', cls: 'bad' };
    if (k === 'grow') return c.ok ? { text: `${short(c.agent_id)} ${c.version} probation`, cls: 'ok' } : { text: '생성 중단', cls: 'bad' };
    if (k === 'rollback') return { text: `롤백 ${(c.cascade || []).length}건`, cls: 'bad' };
    if (k === 'retire') return { text: `유예 ${(c.items || []).filter((x) => x.decision === 'deprecated').length} · 보류 ${(c.items || []).filter((x) => x.decision === 'hold').length}`, cls: 'warn' };
    if (k === 'replay') { const f = c.final || {}; return { text: f.before ? `판정 일치 ${f.before.accuracy?.toFixed(0)}% → ${f.after.accuracy?.toFixed(0)}%` : '평가', cls: 'ok' }; }
    if (k === 'structure') return (c.changes || []).length ? { text: `승격 ${c.changes.length}건 · 중복 ${c.dup_before}% → ${c.dup_after}%`, cls: 'ok' } : { text: c.status || '보류', cls: 'warn' };
    if (k === 'orchestration') return c.change ? { text: `super_agent ${c.change.from} → ${c.change.to}`, cls: 'ok' } : { text: '변경 없음', cls: 'warn' };
    if (k === 'merge') return c.ok ? { text: '병합 채택', cls: 'ok' } : { text: '기각', cls: 'warn' };
    if (k === 'judgment') return c.status === 'adopted' ? { text: `채택 (승인 ${c.approver || ''})`, cls: 'ok' } : { text: c.status || '승인 대기', cls: 'warn' };
    const ad = (c.adopted || []).length, n = (c.candidates || []).length;
    return ad ? { text: `채택 ${ad} / 후보 ${n}`, cls: 'ok' } : { text: `기각 ${n} / 후보 ${n}`, cls: 'warn' };
  },
  title(k, c, r) {
    if (k === 'heal') return `${AGENT_KO[c.agent_id] || c.agent_id} — ${c.classification?.type || '오류'}: ${(c.cause || c.signature || '').slice(0, 70)}`;
    if (k === 'grow') return `${AGENT_KO[c.agent_id] || c.agent_id || '새 Agent'} — 처리 불가 능력 ${(c.need || []).join(', ')}`;
    if (k === 'quarter') { const ad = (c.candidates || []).filter((x) => x.decision === 'adopt'); return `${c.quarter} — ${ad.length ? ad.map((x) => x.title).join(' / ').slice(0, 90) : '채택 없음 (기각안은 아카이브에 보관)'}`; }
    if (k === 'judgment') return `${c.group} — 1차 Fail 편향 감지 → Focus Ring 보정 (${(c.detect || [])[0] || ''})`.slice(0, 110);
    if (k === 'structure') return (c.detect || [])[0] || 'FDC 파싱 중복 → fdc_toolkit 추출';
    if (k === 'orchestration') return (c.detect || [])[0] || '편성 이력 분석';
    if (k === 'merge') return c.line || '아카이브 병합안 재도전';
    if (k === 'rollback') return c.cause || '승격 후 Shadow 불일치';
    if (k === 'retire') return (c.scan || []).map((x) => `${short(x.agent_id)} ${x.days_unused}일 미사용`).join(' · ') || '폐기 후보';
    if (k === 'replay') return r.title;
    return r.title;
  },
  // 상세
  detail(k, c, r) {
    const out = [];
    const L = (txt, cls) => h('div', { class: `ev-ln ${cls || ''}` }, txt);
    const sec = (title, ...kids) => h('div', { class: 'ev-sec' }, h('div', { class: 'ev-st' }, title), ...kids);
    if (k === 'heal') {
      const cl = c.classification || {};
      out.push(sec('① 오류 감지', L(`시그니처 ${c.signature}`), L(`${c.error?.type || ''}: ${c.error?.message || ''}`.slice(0, 160), 'bad')),
        sec('② Jev 분류 · CodeAct 진단', L(`Jev 오류 유형 ${cl.type} (p=${cl.p})${cl.reclassified ? ' — 진단 후 재분류' : ''}`), c.slicing ? L(`로그 슬라이싱: ${c.slicing}`, 'muted') : null, L(`원인: ${c.cause || '-'}`)),
        sec(`③ 패치 ${(c.attempts || []).length}회 · 회귀 테스트`, ...(c.attempts || []).map((a) => L(`${a.n}회차 ${a.result === 'pass' ? '통과' : '기각'} — ${a.summary} (+${a.diff_add}/−${a.diff_del}, ${a.model}) · 회귀 ${a.tests?.passed ?? 0}/${a.tests?.total ?? 0}${(a.tests?.failures || []).length ? ' — ' + a.tests.failures.map((f) => `${f.label || f.case}: ${f.error}`).join('; ').slice(0, 160) : ''}`, a.result === 'pass' ? 'ok' : 'bad'))),
        sec('④ 반영', L(c.status === 'healed' ? `${c.agent_id} ${c.from_version} → ${c.to_version} · MTTR ${c.mttr} · 재응답 ${c.pending}건` : `${c.status}: ${c.escalate_reason || ''}`, c.status === 'healed' ? 'ok' : 'bad'),
          ...(c.cascade || []).map((x) => L(`연쇄 복구: ${x.agent_id} ${x.from} → ${x.to || '실패'} (회귀 ${x.tests}) — ${x.why}`, 'ok'))));
      if (c.diff) out.push(sec('패치 diff', h('div', { class: 'tr-code diff' }, ...diffLines(c.diff))));
    } else if (k === 'grow') {
      out.push(sec('① 처리 불가 감지', L(`필요 능력 ${(c.need || []).join(', ')} — 기존 Agent 조합으로 불가 (Jev can_handle=no) → Agent Factory`)),
        c.spec ? sec('② 명세 (LLM 작성) · 스키마 탐색 (CodeAct)', ...Object.entries(c.spec).map(([kk, v]) => L(`${kk}: ${Array.isArray(v) ? v.join(', ') : v}`)), c.schema?.codes ? L(`코드값 PRT_CD ${c.schema.codes.total}종 (사전 ${c.schema.codes.documented} + 추론 ${(c.schema.codes.undocumented || []).length}) · 엣지 후보 ${Object.keys(c.schema.edges || {}).length}종`, 'muted') : null) : null,
        sec(`③ 코드·테스트 생성 ${(c.attempts || []).length}회`, ...(c.attempts || []).map((a) => L(`${a.n}회차 ${a.result === 'pass' ? '통과' : '실패'} — ${a.version} (${a.lines || '-'} lines, ${a.model || '-'}) ${a.note || ''}${(a.tests || []).length ? ` · 테스트 ${a.tests.filter((x) => x.ok).length}/${a.tests.length}` : ''}`, a.result === 'pass' ? 'ok' : 'bad'))),
        sec('④ 등록', ...(c.lines || []).map((x) => L(x))));
    } else if (k === 'rollback') {
      out.push(sec('① Shadow 불일치 감지', L(`${c.group} ${c.n}건 중 불일치 ${c.mismatch}건 — ${(c.detail || []).join('; ')}`, 'bad')), sec('② 원인', L(c.cause || '')),
        sec('③ 원자적 롤백 (공용 스킬 의존 Agent까지)', ...(c.cascade || []).map((x) => L(`${x.agent_id} ${x.from} → ${x.to}`, 'bad'))), sec('④ 재발 방지', L(`불일치 샘플 ${c.heldout_added}건 Held-out셋 추가 · 결함 버전 번호 재사용 안 함`)));
    } else if (k === 'retire') {
      out.push(sec('① 미사용·대체 감지', ...(c.scan || []).map((x) => L(`${x.agent_id} ${x.version}: 마지막 호출 ${x.days_unused}일 전 · 직접/간접(30일) ${x.direct_30d}/${x.indirect_30d} · 기능 중첩 ${x.overlap} · Jev ${Number(x.p).toFixed(2)} — ${x.reason}`))),
        sec('②③ 의존성 분석 · 대체 검증 · 유예', ...(c.items || []).map((x) => L(`${x.agent_id}: ${x.decision === 'hold' ? '폐기 보류' : `deprecated (유예 ~${String(x.grace_until || '').slice(0, 10)})`} — ${x.why || x.reason}${x.verify ? ` · 대체 검증 ${x.verify.ok}/${x.verify.total} 일치 · 테스트 이관 ${x.migrated}건` : ''}`, x.decision === 'hold' ? 'warn' : 'ok'))),
        c.grace_event ? sec('유예 중 사건', L(`대체 검증 재수행 ${c.grace_event.verify?.ok}/${c.grace_event.verify?.total} → 유예 재시작 ~${String(c.grace_event.grace_until).slice(0, 10)}`)) : null,
        c.final ? sec('④ 확정', L(`편성 후보 Agent ${c.final.n}개: ${(c.final.candidates || []).join(', ')} — 폐기 Genome·테스트·Lineage는 아카이브 보관(복원 가능)`)) : null);
    } else if (k === 'replay') {
      const f = c.final || {};
      out.push(sec('Held-out 최종 평가 (진화에 쓰지 않은 최근 6개월)', L(`${f.n}건 — 판정 일치율 ${f.before?.accuracy?.toFixed(0)}% → ${f.after?.accuracy?.toFixed(0)}% · 1차 Pass 예측 ${f.before?.pred_acc}% → ${f.after?.pred_acc}% · 추천 오차 ±${f.before?.rec_error} → ±${f.after?.rec_error}매`),
        L(`미래 정보 누출 ${f.leaks}건 (Time-Travel Guard 차단·필터 ${Number(f.guard_blocked || 0).toLocaleString()}건)`, 'ok')));
    } else {
      // evolve 계열 (quarter / judgment / structure / orchestration / merge)
      const det = c.detect || [];
      if (k === 'quarter') out.push(sec('① 감지', L(`${c.quarter} 재생 결과 분석 — Jev 진화 필요 p=${c.jev ?? '-'} · 기준선 Evolve셋 판정 일치율 ${c.base?.E?.accuracy ?? '-'}% (${c.base?.E?.n ?? '-'}건) · 검증셋 ${c.base?.V?.accuracy ?? '-'}%`), ...(c.clusters || []).map((x) => L(`미해결 오차 군집 ${x.id}: ${x.text}`, 'muted'))));
      else if (k === 'judgment') out.push(sec('① 감지 (경험 메모리)', ...det.map((x) => L(x)), L(`${c.group} ${(c.period || []).join(' ~ ')}: AutoQual ${c.n}건 · Override ${c.overrides}건 · 추천대로 진행 ${c.followed}건 중 1차 Fail ${c.followed_fail}건 · 그중 Focus Ring 600h 초과 ${c.fr_fail}건`), L(`Override 분류: 결과로 뒷받침 ${c.backed}건 학습 / 보수적 ${c.conservative}건 제외`, 'muted')));
      else out.push(sec('① 감지', ...det.map((x) => L(x)), c.dup_before != null ? L(`FDC 파싱 코드 중복 ${c.dup_before}% · log_agent p50 ${c.p50_before}s`) : null, c.from_archive ? L(`출발점: 아카이브 ${c.from_archive} (이전 기각안)`) : null));
      const cands = c.candidates || [];
      if (cands.length) {
        const tb = h('table', { class: 'tr-tools' }, h('thead', {}, h('tr', {}, h('th', {}, '후보'), h('th', {}, '계층'), h('th', { class: 'num' }, 'Evolve셋'), h('th', { class: 'num' }, 'Held-out'), h('th', {}, '결정'))));
        const body = h('tbody');
        for (const x of cands) {
          const sc = x.scores || {};
          body.append(h('tr', { class: x.decision === 'adopt' ? 'ok' : '' }, h('td', {}, h('b', {}, x.cid), ' ', (x.title || x.line || '').slice(0, 80), x.why ? h('div', { class: 'muted' }, x.why.slice(0, 90)) : null),
            h('td', {}, x.layer || ''), h('td', { class: 'num' }, sc.dE != null ? `${sc.dE > 0 ? '+' : ''}${sc.dE}%p` : (x.dE != null ? `${x.dE > 0 ? '+' : ''}${x.dE}` : '-')),
            h('td', { class: 'num' }, sc.dV != null ? `${sc.dV > 0 ? '+' : ''}${sc.dV}%p` : '-'),
            h('td', {}, h('span', { class: `st ${x.decision}` }, { adopt: '채택', reject: '기각', hold: '보류' }[x.decision] || x.decision || ''), x.reason ? h('div', { class: 'muted' }, x.reason.slice(0, 110)) : null,
              (x.changes || []).length ? h('div', { class: 'ev-ok' }, x.changes.map((ch) => `${short(ch.agent_id)} ${ch.from || '-'} → ${ch.to}`).join(' / ')) : null,
              x.lessons?.new?.length ? h('div', { class: 'lesson-txt' }, `신규 교훈 ${x.lessons.new.map((l) => l.id || l).join(', ')}`) : null)));
        }
        tb.append(body);
        out.push(sec(`②③ 변이 후보 ${cands.length}개 → 루프 밖 하네스 평가 (Evolve셋 개선 ∧ Held-out 비하락이어야 채택, 전부 아카이브 보관)`, tb));
      }
      const changes = c.changes || (c.change ? [c.change] : []);
      const final = [];
      if (k === 'judgment') final.push(L(`상태: ${c.status === 'adopted' ? `채택 — 운영자 승인 ${c.approver || ''}` : '운영자 승인 대기'}`, c.status === 'adopted' ? 'ok' : 'warn'));
      if (c.shadow) final.push(L(`Shadow 운영 ${c.shadow.n}건 (${Object.entries(c.shadow.by_group || {}).map(([g, n]) => `${g} ${n}`).join(', ')}) · 불일치 ${c.shadow.mismatch}건 → ${c.shadow.mismatch ? '승격 보류' : '승격'}`, c.shadow.mismatch ? 'bad' : 'ok'));
      if (c.dup_after != null) final.push(L(`결과: 중복 ${c.dup_before}% → ${c.dup_after}% · p50 ${c.p50_before}s → ${c.p50_after}s`, 'ok'));
      if (c.calls) final.push(L(`요청당 호출 Agent ${c.calls[0]} → ${c.calls[1]}`, 'ok'));
      for (const ch of changes) final.push(L(`반영: ${ch.agent_id || 'super_agent'} ${ch.from || '-'} → ${ch.to}`, 'ok'));
      if ((c.adopted || []).length) final.push(L(`채택 ${c.adopted.join(', ')} → 다음 분기부터 새 버전으로 재생 (Walk-forward)`, 'ok'));
      if (c.grow) final.push(L(`반복 필요 분석 감지 → Grow ${c.grow}`, 'l2'));
      if (final.length) out.push(sec('④ 선택 · 반영', ...final));
    }
    out.push(h('div', { class: 'ev-foot' }, h('button', { class: 'btn small', onclick: () => window.Views?.openReport?.(r.report_id) }, '리포트 전문'),
      r.report_id.startsWith('V-') || r.report_id.startsWith('E-') ? h('button', { class: 'btn small', onclick: () => A.go('archive') }, '아카이브') : null));
    return out.filter(Boolean);
  },

  // ── 진행 중 런 (이벤트) ──────────────────────────────────
  event(ev) {
    switch (ev.type) {
      case 'report': if (!ev.backlog || this.loaded) this.onReport(ev); break;
      case 'node': this.progress(ev); break;
      case 'candidate': { const c = this.liveCard(ev.run_id, 'evolve'); if (c) { c.n = (c.n || 0) + 1; c.note.textContent = `후보 ${c.n}개 평가 중 — 최근 ${ev.cid} ${ev.ok ? '채택' : '기각'} (${ev.reason || ''})`.slice(0, 140); this.mark(c, 2, ev.ok ? 'run' : 'bad'); } break; }
      case 'version': if (!ev.backlog && ev.kind !== 'baseline') { Evo.loadSoon(); setTimeout(() => this.renderSum(), 600); } break;
      case '_state': Evo.sync(); this.renderSum(); break;
      default: break;
    }
  },
  async onReport(ev) {
    try { const r = await api(`/api/report/${ev.report_id}`); this.add(r, !ev.backlog); } catch (err) { /* noop */ }
  },
  liveCard(id, kind, title) {
    if (!id) return null;
    if (this.cards.has(id)) return null;
    let c = this.live.get(id);
    if (!c) {
      const [badge, cls, name] = kind === 'heal' ? KIND.heal : kind === 'grow' ? KIND.grow : ['EVOLVE', 'l3', 'L3 Evolve 진행 중'];
      const steps = STEPS[kind] || STEPS.evolve;
      c = { id, kind, n: 0, steps: [] };
      c.note = h('div', { class: 'ev-ln muted' }, '시작');
      c.stepEls = steps.map((s, i) => h('span', { class: 'es' }, h('i', {}, String(i + 1)), s));
      c.el = h('article', { class: `ev-card ${cls} live new` },
        h('div', { class: 'ev-ch' }, h('span', { class: `ev-badge ${cls}` }, badge), h('span', { class: 'ev-id' }, id), h('span', { class: 'ev-title' }, title || `${name} — 진행 중`), h('span', { class: 'ev-res run' }, '진행 중')),
        h('div', { class: 'ev-sub' }, h('span', { class: 'ev-kind' }, name), h('div', { class: 'ev-steps' }, ...c.stepEls)), h('div', { class: 'ev-cb' }, c.note));
      this.live.set(id, c);
      this.el.feed.prepend(c.el);
      this.el.feed.querySelector('.ev-empty')?.remove();
    }
    return c;
  },
  mark(c, i, state) { c.stepEls.forEach((el, j) => { el.classList.remove('run'); if (j < i) el.classList.add('done'); }); const el = c.stepEls[i]; if (el) { el.classList.remove('done'); el.classList.add(state === 'bad' ? 'bad' : 'run'); } },
  progress(ev) {
    if (ev.backlog) return;
    const key = ev.heal_id || ev.grow_id || ev.run_id;
    if (!key) return;
    const kind = ev.heal_id ? 'heal' : ev.grow_id ? 'grow' : 'evolve';
    const title = kind === 'heal' ? `${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.version || ''} 자가 복구 — 진행 중` : kind === 'grow' ? `새 Agent 생성${ev.agent_id ? ` — ${AGENT_KO[ev.agent_id] || ev.agent_id}` : ''} — 진행 중` : null;
    const c = this.liveCard(key, kind, title);
    if (!c) return;
    if (title && ev.agent_id) c.el.querySelector('.ev-title').textContent = title;
    const i = NODE_STEP[ev.node];
    if (i != null) this.mark(c, i, /중단|실패|롤백|에스컬레이션/.test(ev.detail || '') ? 'bad' : 'run');
    c.note.textContent = ev.detail || ev.node;
  },
  shown() { Evo.render(); },
};
