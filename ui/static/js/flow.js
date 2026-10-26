// 흐름 화면 — 질문 하나가 Loop Engineering(L1·L2·L3) → CodeAct → Self-Evolving으로 이어지는 과정을 한 화면에 보여준다
//   자막(지금 무슨 일이) · 3중 루프 트랙(토큰이 실제 노드를 따라 이동) · CodeAct(작성 코드 → 샌드박스 검사 → 실행) · Jev 판단 · Agent 계보
import { $, h, s, api, vdate, AGENT_KO, HEAD_KO, short, diffLines, highlight, debounce } from './util.js';

let A = null;
const spd = () => (A.state ? Number(A.state.speed) : 1);
const ms = (base) => { const v = spd(); return v ? base / Math.max(0.5, v) : 0; };

/* ══════════════════════════════════════════════════════════
   루프 트랙 정의 — 트랙 윗변 = 진행 방향, 아랫변 = 되돌아가는 길(재시도·다음 주기)
   ══════════════════════════════════════════════════════════ */
const VB = { w: 1000, h: 452 };
const LANES = {
  L3: { c: 'l3', x0: 30, x1: 970, top: 58, h: 50, name: 'L3 EVOLVE', sub: '쌓인 경험으로 Agent 자체를 바꾸는 바깥 루프',
    back: '↺ 다음 진화 주기 (분기·야간) — 기각안은 아카이브에서 재출발',
    slots: [['metrics', '지표 수집'], ['jev', 'Jev 진화 판단', 'jev'], ['mutate', '변이 후보', 'ca'], ['eval', '하네스 평가', 'det'],
      ['select', '선택·승인', 'gate'], ['archive', '아카이브 보관'], ['shadow', 'Shadow 검증'], ['promote', '승격 / 롤백']] },
  L1: { c: 'l1', x0: 30, x1: 970, top: 206, h: 58, name: 'L1 TASK', sub: '질문 1건을 처리하는 루프 · 종료: 목표 충족 / 재계획 1회',
    back: '↺ 경험 기록 → 다음 질문이 꺼내 씀', backX: 190,
    slots: [['q', '질문', 'q'], ['parse', '요청 해석'], ['mem', '경험 메모리'], ['route', 'Jev 편성', 'jev'], ['plan', 'CodeAct 계획', 'ca'],
      ['exec', '샌드박스 실행', 'ca'], ['obs', '관찰·검증'], ['resp', '종합·응답'], ['judge', '결정적 판정', 'det'], ['gate', '사람 승인', 'gate']] },
  GROW: { c: 'l2', x0: 30, x1: 486, top: 358, h: 50, below: true, name: 'L2 GROW', sub: '처음 보는 요청 → 새 Agent를 만든다',
    back: '↺ 테스트 실패 → 다시 생성 (예산 5회·15분)',
    slots: [['search', '아카이브 검색'], ['schema', '스키마 탐색', 'ca'], ['gen', '코드 생성', 'ca'], ['test', '테스트', 'det'], ['reg', 'probation 등록']] },
  HEAL: { c: 'l2', x0: 514, x1: 970, top: 358, h: 50, below: true, name: 'L2 HEAL', sub: '실행 오류 → 자기 코드를 고친다',
    back: '↺ 테스트 실패 → 블랙리스트 후 재패치 (예산 5회·15분)',
    slots: [['cls', '오류 분류', 'jev'], ['diag', '원인 진단', 'ca'], ['patch', '패치 작성', 'ca'], ['test', '회귀 테스트', 'det'], ['reg', '버전 반영']] },
};
const LANE_LABEL = { L1: 'L1 TASK', HEAL: 'L2 HEAL', GROW: 'L2 GROW', L3: 'L3 EVOLVE' };

for (const L of Object.values(LANES)) {
  const r = L.h / 2;
  const a = L.x0 + r, b = L.x1 - r, pad = 14;
  const step = (b - a - 2 * pad) / (L.slots.length - 1);
  Object.assign(L, { r, a, b, yT: L.top, yB: L.top + L.h, straight: b - a, pw: Math.min(step - 7, 116), pos: {} });
  L.total = 2 * L.straight + 2 * Math.PI * r;
  L.backLen = L.straight + Math.PI * r + (b - (L.backX || (a + b) / 2));
  L.slots.forEach(([k, label, kind], i) => { const x = a + pad + i * step; L.pos[k] = { x, len: x - a, i, label, kind }; });
  L.d = `M ${a} ${L.yT} H ${b} A ${r} ${r} 0 0 1 ${b} ${L.yB} H ${a} A ${r} ${r} 0 0 1 ${a} ${L.yT} Z`;
}

// 루프 사이를 잇는 길 (막히면 아래 L2로, 경험은 위 L3로, 진화 결과는 다시 L1로)
const P = (lane, k) => LANES[lane].pos[k].x;
const LINKS = {
  'l1-grow': { d: vcurve(P('L1', 'route'), LANES.L1.yB, P('GROW', 'search'), LANES.GROW.yT - 16), label: '처리 불가 → Grow', c: 'l2' },
  'grow-l1': { d: vcurve(P('GROW', 'reg'), LANES.GROW.yT - 16, P('L1', 'plan'), LANES.L1.yB), label: '새 Agent 투입', c: 'l2' },
  'l1-heal': { d: vcurve(P('L1', 'obs'), LANES.L1.yB, P('HEAL', 'cls'), LANES.HEAL.yT - 16), label: '확인 불가 → Heal', c: 'l2' },
  'heal-l1': { d: vcurve(P('HEAL', 'reg'), LANES.HEAL.yT - 16, P('L1', 'resp'), LANES.L1.yB), label: '복구 후 재응답', c: 'l2' },
  'l1-l3': { d: `M 30 ${LANES.L1.yT + LANES.L1.r} C 4 ${LANES.L1.yT}, 4 ${LANES.L3.yB}, 30 ${LANES.L3.yT + LANES.L3.r}`, label: '경험 → 진화 재료', c: 'l3', side: 'l' },
  'l3-l1': { d: `M 970 ${LANES.L3.yT + LANES.L3.r} C 996 ${LANES.L3.yB}, 996 ${LANES.L1.yT}, 970 ${LANES.L1.yT + LANES.L1.r}`, label: '새 버전 배포', c: 'l3', side: 'r' },
};
function vcurve(x1, y1, x2, y2) {
  const k = (y2 - y1) * 0.55;
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
}

// 이벤트 노드 → 트랙 위치 ('@back' = 되돌아가는 길, '@stop' = 루프 중단)
const NODE_SLOT = {
  L1: { parse_request: 'parse', retrieve_memory: 'mem', jev_route: 'route', grow_subgraph: 'route', plan_codeact: 'plan', rework_plan: 'plan',
    execute_sandbox: 'exec', observe: 'obs', mark_unavailable: 'obs', synthesize: 'resp', respond: 'resp', await_qual_result: 'resp',
    replay_measure: 'resp', deterministic_judge: 'judge', compare_actual: 'judge', approval_gate: 'gate', apply_state_change: 'gate', log_experience: '@back' },
  HEAL: { start: 'cls', jev_classify_error: 'cls', heal_history: 'cls', diagnose_codeact: 'diag', write_patch: 'patch', check_blacklist: 'patch',
    blacklist_patch: '@back', run_regression: 'test', register_version: 'reg', cascade: 'reg', reanswer_pending: 'reg', escalate_operator: '@stop' },
  GROW: { start: 'search', search_archive: 'search', restore_genome: 'gen', write_spec: 'schema', explore_schema: 'schema',
    generate_code_and_tests: 'gen', run_tests: 'test', register_probation: 'reg', abort_with_reason: '@stop' },
  L3: { collect_metrics: 'metrics', analyze_cause: 'metrics', cluster_recheck: 'metrics', classify_override: 'metrics',
    jev_need_evolve: 'jev', jev_need_grow: 'jev', jev_need_retire: 'jev', jev_need_merge: 'jev', mutate: 'mutate',
    evaluate_harness: 'eval', verify_replacement: 'eval', migrate_tests: 'eval', select: 'select', archive: 'archive',
    shadow_run: 'shadow', promote: 'promote', auto_rollback: 'promote' },
};

// 자막 — 노드마다 "지금 Agent가 무엇을 하는지" 한 문장
const SAY = {
  parse_request: 'Super Agent가 질문에서 장비·챔버·PM 종류를 뽑아냅니다',
  retrieve_memory: '과거 경험(교훈·유사 사례·편성 템플릿)을 꺼내 옵니다',
  jev_route: 'Jev가 어떤 Agent를 부를지 확률로 판단합니다',
  grow_subgraph: '기존 Agent로는 처리할 수 없습니다 — Grow 루프로 내려갑니다',
  plan_codeact: 'Super Agent가 실행 계획을 Python 코드로 작성합니다 (CodeAct)',
  rework_plan: 'Qual Fail — 재작업 계획을 다시 세웁니다',
  execute_sandbox: '작성한 코드를 샌드박스에서 실행해 하위 Agent들을 호출합니다',
  observe: '실행 결과를 사후 검증합니다',
  mark_unavailable: '검증에 실패한 항목은 추측하지 않고 "확인 불가"로 표시합니다',
  synthesize: '결과를 종합해 추천안을 만듭니다',
  respond: '엔지니어에게 응답합니다',
  await_qual_result: 'Mock Fab에서 Seasoning·Qual 측정 결과를 기다립니다',
  replay_measure: '리플레이 — 당시 실제 측정값을 불러옵니다',
  deterministic_judge: 'Pass/Fail은 LLM이 아니라 결정적 코드 judge_qual이 판정합니다',
  compare_actual: '추천·판정을 당시 실제 결과와 비교해 채점합니다',
  approval_gate: '장비 Up은 Jev 확신도와 무관하게 반드시 사람이 승인합니다',
  apply_state_change: '승인된 장비 상태 변경을 반영합니다',
  log_experience: '이번 결과를 경험 메모리에 기록합니다 — 다음 질문과 진화의 재료',
  'HEAL:start': '오류 감지 — L2 Heal 루프에 진입합니다',
  jev_classify_error: 'Jev가 오류 유형을 분류합니다 (코드 결함 / 외부 장애)',
  heal_history: '같은 오류를 고친 적이 있는지 Heal 이력을 찾아봅니다',
  diagnose_codeact: 'Healer가 진단 코드로 로그를 슬라이싱해 필요한 구간만 관찰하고 원인을 찾습니다',
  write_patch: 'Healer가 Agent의 소스 코드를 직접 고칩니다',
  check_blacklist: '이미 실패했던 패치인지 블랙리스트(AST 해시)로 확인합니다',
  blacklist_patch: '패치 실패 — 블랙리스트에 올리고 다른 패치를 다시 시도합니다',
  run_regression: '회귀 테스트로 패치가 기존 기능을 깨지 않는지 검증합니다',
  register_version: '테스트를 통과한 패치를 새 버전으로 교체합니다',
  cascade: '같은 문제를 가진 다른 Agent도 연쇄 복구합니다',
  reanswer_pending: '"확인 불가"였던 항목을 다시 분석해 답합니다',
  escalate_operator: '복구 불가 — 예산 안에서 멈추고 사람에게 넘깁니다',
  'GROW:start': '처음 보는 요청 — Agent Factory가 새 Agent를 만들기 시작합니다',
  search_archive: '진화 아카이브에 재사용할 수 있는 Genome이 있는지 찾습니다',
  restore_genome: '아카이브의 Genome을 복원해 현재 스키마로 다시 시험합니다',
  write_spec: '새 Agent의 명세(역할·입출력)를 작성합니다',
  explore_schema: '탐색 코드로 레거시 스키마·코드값 분포·결측·경계일을 파악합니다 (엣지 케이스 재료)',
  generate_code_and_tests: '새 Agent의 코드와 테스트(정상 + 스키마 기반 엣지 케이스)를 생성합니다',
  run_tests: '생성한 Agent를 정상·엣지 케이스 + 하네스 불변식으로 검증합니다',
  register_probation: '새 Agent를 probation(시험 운영)으로 등록하고 L1로 복귀합니다',
  abort_with_reason: '생성 중단 — 예산 초과 또는 불가 사유를 기록합니다',
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
  auto_rollback: 'Shadow 불일치 — 관련 Agent를 원자적으로 자동 롤백합니다',
};

const BAD = {
  observe: /확인 불가/, mark_unavailable: /./, run_regression: /재현 테스트 실패|— 실패/, run_tests: /실패/, check_blacklist: /일치/,
  blacklist_patch: /./, escalate_operator: /./, abort_with_reason: /./, auto_rollback: /./, evaluate_harness: /— 실패/,
};

const ACTOR = { super_agent: ['Super Agent', 'l1'], healer: ['Healer', 'l2'], factory: ['Agent Factory', 'l2'], evolver: ['Evolver', 'l3'] };
const PIPE = {
  plan: ['LLM 코드 작성', 'AST 검사', 'import 검사', '샌드박스 실행', '사후 검증'],
  diag: ['진단 코드 작성', 'AST 정적 검사', '로그 슬라이싱 실행', '원인 도출'],
  patch: ['패치 작성', 'AST·블랙리스트', '회귀 테스트', '버전 반영'],
  explore: ['탐색 코드 작성', 'AST 정적 검사', '읽기 전용 실행', '스키마 파악'],
  gen: ['Agent 코드 생성', 'AST 정적 검사', '테스트', 'probation 등록'],
  evolve: ['변이 생성', '하네스 평가', '선택·승인', 'Registry 반영'],
  rollback: ['Shadow 불일치', '원자적 롤백', 'Registry 반영'],
};
const VKIND = { heal: 'Heal 패치', grow: 'Grow 생성', evolve: 'Evolve 채택', compose: '구성 변경(MAJOR)', rollback: '자동 롤백', promote: '정식 승격',
  restore: '아카이브 복원', baseline: '초기 구축', deprecate: '폐기 유예', retire: '폐기 확정', grace_restart: '유예 재시작', defect: '결함 판정' };

/* ══════════════════════════════════════════════════════════
   루프 맵
   ══════════════════════════════════════════════════════════ */
const Loops = {
  svg: null, g: {}, st: {}, links: {},
  build(host) {
    const svg = s('svg', { viewBox: `0 0 ${VB.w} ${VB.h}`, class: 'fl-svg', role: 'img', 'aria-label': '3중 루프: L3 Evolve, L1 Task, L2 Grow·Heal' });
    svg.append(s('defs', {},
      ...['l1', 'l2', 'l3'].map((c) => s('marker', { id: `fa-${c}`, viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' },
        s('path', { d: 'M0 0L8 4L0 8z', class: `mk ${c}` })))));
    // 루프 사이 연결
    const lk = s('g', { class: 'fl-links' });
    for (const [id, L] of Object.entries(LINKS)) {
      const g = s('g', { class: `lk ${L.c}` });
      const p = s('path', { d: L.d, class: 'lk-p', 'marker-end': `url(#fa-${L.c})` });
      g.append(p);
      if (L.side) {
        const x = L.side === 'l' ? 11 : 989, y = (LANES.L3.yB + LANES.L1.yT) / 2;
        g.append(s('text', { class: 'lk-t', x, y, 'text-anchor': 'middle', transform: `rotate(${L.side === 'l' ? -90 : 90} ${x} ${y})` }, L.label));
      } else {
        const m = /M ([\d.]+) ([\d.]+) C .* ([\d.]+) ([\d.]+)$/.exec(L.d);
        const mx = (Number(m[1]) + Number(m[3])) / 2, my = (Number(m[2]) + Number(m[4])) / 2;
        const w = textW(L.label, 10.5) + 12;
        g.append(s('rect', { class: 'lk-bg', x: mx - w / 2, y: my - 9, width: w, height: 18, rx: 9 }), s('text', { class: 'lk-t', x: mx, y: my + 3.6, 'text-anchor': 'middle' }, L.label));
      }
      this.links[id] = { g, p };
      lk.append(g);
    }
    svg.append(lk);
    for (const [key, L] of Object.entries(LANES)) svg.append(this.lane(key, L));
    host.append(svg);
    this.svg = svg;
  },
  lane(key, L) {
    const g = s('g', { class: `fl-lane ${L.c}`, 'data-lane': key });
    const hy = L.below ? L.yB + 34 : L.yT - 30;
    g.append(s('text', { class: 'ln-name', x: L.x0 + 4, y: hy }, L.name), s('text', { class: 'ln-sub', x: L.x0 + 4 + textW(L.name, 13, true) + 10, y: hy }, L.sub));
    const status = s('text', { class: 'ln-st', x: L.x1 - 4, y: hy, 'text-anchor': 'end' }, '대기');
    g.append(s('path', { class: 'trk', d: L.d }), s('path', { class: 'trk-flow', d: L.d }));
    const bx = L.backX || (L.a + L.b) / 2, bw = textW(L.back, 10.5) + 16;
    const back = s('g', { class: 'back' }, s('rect', { x: bx - bw / 2, y: L.yB - 9, width: bw, height: 18, rx: 9 }), s('text', { x: bx, y: L.yB + 3.6, 'text-anchor': 'middle' }, L.back));
    const tok = s('g', { class: 'tok' }, s('circle', { r: 11, class: 'tok-halo' }), s('circle', { r: 6.5, class: 'tok-c' }), s('circle', { r: 2.4, class: 'tok-i' }));
    tok.style.opacity = 0;
    g.append(back, status, tok);      // 토큰은 노드 아래 — 이동 중에만 보이고, 멈추면 노드 하이라이트가 위치를 보여준다
    const nodes = {};
    for (const [k, p] of Object.entries(L.pos)) {
      const n = s('g', { class: `nd ${p.kind || ''}`, transform: `translate(${p.x - L.pw / 2},${L.yT - 16})` },
        s('title', {}, p.label),
        s('rect', { class: 'nd-b', width: L.pw, height: 32, rx: 16 }),
        s('text', { class: 'nd-t', x: L.pw / 2, y: 20.5, 'text-anchor': 'middle' }, p.label));
      if (p.kind === 'ca') n.append(s('circle', { class: 'nd-ca', cx: L.pw - 9, cy: 1, r: 4 }));
      if (p.kind === 'det') n.append(s('rect', { class: 'nd-det', x: L.pw - 13, y: -3, width: 8, height: 8, rx: 1.5 }));
      if (p.kind === 'gate') n.append(s('rect', { class: 'nd-gate', x: L.pw - 13, y: -3, width: 8, height: 8, rx: 1.5, transform: `rotate(45 ${L.pw - 9} 1)` }));
      nodes[k] = n;
      g.append(n);
    }
    const bub = s('g', { class: 'bub' }, s('rect', { rx: 4, height: 17 }), s('text', {}));
    g.append(bub);
    this.g[key] = { g, nodes, bub, tok, status, back, track: g.querySelector('.trk') };
    this.st[key] = { cur: null, len: 0, run: null, visited: new Set(), anim: null, idle: null };
    return g;
  },
  // 이벤트 반영: lane의 slot으로 토큰을 움직이고 노드 상태를 바꾼다
  go(key, slot, ev, { bad = false, detail = null, run = null } = {}) {
    const L = LANES[key], G = this.g[key], S = this.st[key];
    if (run && run !== S.run) {
      S.run = run;
      S.visited.clear();
      for (const n of Object.values(G.nodes)) n.classList.remove('cur', 'done', 'bad', 'wait');
      G.g.classList.remove('stop');
    }
    if (S.cur && G.nodes[S.cur]) { G.nodes[S.cur].classList.remove('cur', 'wait'); G.nodes[S.cur].classList.add('done'); }
    G.back.classList.remove('hot');
    let target;
    if (slot === '@back') {
      target = L.backLen;
      G.back.classList.add('hot');
      S.cur = null;
    } else if (slot === '@stop') {
      G.g.classList.add('stop');
      target = S.len;
    } else {
      const p = L.pos[slot];
      target = p.len;
      S.cur = slot;
      S.visited.add(slot);
      const n = G.nodes[slot];
      n.classList.remove('done');
      n.classList.add('cur');
      n.classList.toggle('bad', !!bad);
    }
    if (bad && slot === '@stop' && S.cur) G.nodes[S.cur]?.classList.add('bad');
    this.move(key, target, ev.backlog);
    this.bubble(key, slot === '@back' ? null : slot === '@stop' ? S.cur : slot, detail ?? ev.detail, bad || slot === '@stop');
    this.wake(key, ev.backlog);
  },
  wait(key, slot) { this.g[key].nodes[slot]?.classList.add('wait'); },
  move(key, target, instant) {
    const L = LANES[key], G = this.g[key], S = this.st[key];
    cancelAnimationFrame(S.anim);
    G.tok.style.opacity = 1;
    let from = S.len;
    let to = target;
    if (to < from - 0.5) to += L.total;              // 뒤로 가는 길 = 트랙을 한 바퀴 돌아 되돌아온다
    const d = ms(Math.min(1500, 380 + (to - from) * 0.9));
    const place = (len) => { const pt = G.track.getPointAtLength(((len % L.total) + L.total) % L.total); G.tok.setAttribute('transform', `translate(${pt.x},${pt.y})`); };
    if (instant || !d || to === from) { S.len = target; place(target); return; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / d);
      const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
      place(from + (to - from) * e);
      if (k < 1) S.anim = requestAnimationFrame(step);
      else S.len = target;
    };
    S.len = target;
    S.anim = requestAnimationFrame(step);
  },
  bubble(key, slot, text, bad) {
    const L = LANES[key], G = this.g[key];
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) { G.bub.style.display = 'none'; return; }
    const max = key === 'L1' || key === 'L3' ? 72 : 40;
    const str = t.length > max ? `${t.slice(0, max - 1)}…` : t;
    const w = textW(str, 11) + 14;
    const cx = slot ? L.pos[slot].x : (L.backX || (L.a + L.b) / 2);
    const x = Math.max(L.a - L.r + 6, Math.min(L.b + L.r - 6 - w, cx - w / 2));
    const y = L.yT + (L.h >= 58 ? 23 : 20);
    G.bub.style.display = '';
    G.bub.classList.toggle('bad', !!bad);
    const [r, tx] = G.bub.children;
    Object.entries({ x, y, width: w }).forEach(([k, v]) => r.setAttribute(k, v));
    tx.setAttribute('x', x + 7);
    tx.setAttribute('y', y + 12.4);
    tx.textContent = str;
  },
  status(key, text) { this.g[key].status.textContent = text; },
  reset() {
    for (const [key, G] of Object.entries(this.g)) {
      const S = this.st[key];
      S.run = null;
      S.cur = null;
      S.visited.clear();
      for (const n of Object.values(G.nodes)) n.classList.remove('cur', 'done', 'bad', 'wait');
      G.g.classList.remove('stop', 'on');
      G.back.classList.remove('hot');
      G.bub.style.display = 'none';
      G.tok.style.opacity = 0;
      G.status.textContent = '대기';
    }
  },
  wake(key, backlog) {
    const G = this.g[key], S = this.st[key];
    if (backlog) return;
    G.g.classList.add('on');
    clearTimeout(S.idle);
    S.idle = setTimeout(() => G.g.classList.remove('on'), 9000);
  },
  spark(id) {
    const L = this.links[id];
    if (!L) return;
    L.g.classList.add('hot');
    clearTimeout(L.t);
    L.t = setTimeout(() => L.g.classList.remove('hot'), ms(2600) || 900);
    const p = s('path', { d: L.p.getAttribute('d'), class: 'lk-spark' });
    L.g.append(p);
    const len = p.getTotalLength();
    p.style.strokeDasharray = `22 ${len + 40}`;
    p.animate([{ strokeDashoffset: 22 }, { strokeDashoffset: -len }], { duration: ms(900) || 300, easing: 'ease-in-out' });
    setTimeout(() => p.remove(), (ms(900) || 300) + 60);
  },
};

// 대략적인 글자 폭 (SVG가 숨겨져 있어도 배치할 수 있게)
function textW(t, size, bold) {
  let w = 0;
  for (const ch of String(t)) w += /[ㄱ-힝]/.test(ch) ? size * 0.92 : /[A-Z0-9]/.test(ch) ? size * 0.64 : size * 0.52;
  return w * (bold ? 1.06 : 1);
}

/* ══════════════════════════════════════════════════════════
   자막 — 시나리오 · 질문 · 지금
   ══════════════════════════════════════════════════════════ */
const Cap = {
  trail: [], el: {},
  build(host) {
    const e = this.el;
    e.ch = h('div', { class: 'cap-t' }, 'Autopilot 대기');
    e.chk = h('div', { class: 'cap-k' }, '시나리오');
    e.story = h('div', { class: 'cap-s' }, '▶ 상단 Autopilot을 누르면 Agent가 시나리오를 스스로 수행합니다.');
    e.q = h('div', { class: 'cap-q' }, '아직 질문이 없습니다 — 오른쪽 위 입력창에서 직접 질문해 볼 수 있습니다.');
    e.qk = h('div', { class: 'cap-k' }, '질문');
    e.loop = h('span', { class: 'lchip' }, 'READY');
    e.say = h('div', { class: 'cap-say' }, 'Agent가 움직이면 여기 지금 하는 일이 한 문장으로 나옵니다');
    e.det = h('div', { class: 'cap-d' }, '');
    e.trail = h('div', { class: 'fl-trail' });
    host.append(
      h('div', { class: 'cap-row' },
        h('div', { class: 'cap-c cap-ch' }, e.chk, e.ch, e.story),
        h('div', { class: 'cap-c cap-qq' }, e.qk, e.q),
        h('div', { class: 'cap-c cap-now' }, h('div', { class: 'cap-k' }, e.loop, h('span', {}, '지금')), e.say, e.det)),
      e.trail);
    this.renderTrail();
  },
  chapter(ev) {
    const m = /^(SC-\d+)\s+(.*)$/.exec(ev.title || '');
    this.el.chk.textContent = `${m ? m[1] : '챕터'} · ${ev.date || ''}`;
    this.el.ch.textContent = m ? m[2] : ev.title;
    if (ev.desc) this.el.story.textContent = ev.desc;
  },
  story(text) { this.el.story.textContent = text; },
  question(who, text, tag) {
    this.el.qk.textContent = `질문 · ${who}${tag ? ` · ${tag}` : ''}`;
    this.el.q.textContent = `“${text}”`;
    this.el.q.classList.remove('flash');
    void this.el.q.offsetWidth;
    this.el.q.classList.add('flash');
    this.trail = [];
    this.renderTrail();
  },
  now(lane, say, detail, tone) {
    const e = this.el;
    e.loop.textContent = LANE_LABEL[lane] || lane;
    e.loop.className = `lchip ${LANES[lane]?.c || lane}`;
    e.say.textContent = say;
    e.say.className = `cap-say ${tone || ''}`;
    e.det.textContent = detail || '';
  },
  step(lane, label, bad) {
    const last = this.trail[this.trail.length - 1];
    if (last && last.lane === lane && last.label === label) { last.n += 1; last.bad = last.bad || bad; } else this.trail.push({ lane, label, bad, n: 1 });
    if (this.trail.length > 40) this.trail.splice(0, this.trail.length - 40);
    this.renderTrail();
  },
  renderTrail() {
    const t = this.el.trail;
    t.innerHTML = '';
    if (!this.trail.length) {
      t.append(h('span', { class: 'tr-help' }, h('b', {}, '읽는 법'),
        ' 질문은 가운데 ', h('i', { class: 'l1' }, 'L1 트랙'), '을 따라 처리됩니다. 막히면 아래 ', h('i', { class: 'l2' }, 'L2'),
        '로 내려가 스스로 코드를 고치거나(Heal) 새 Agent를 만들고(Grow), 위 ', h('i', { class: 'l3' }, 'L3'),
        '는 쌓인 경험으로 Agent 자체를 진화시킵니다. 트랙 아래쪽은 되돌아가는 길(재시도·다음 주기)입니다.'));
      return;
    }
    const items = this.trail.slice(-16);
    if (this.trail.length > 16) t.append(h('span', { class: 'tr-more' }, `… ${this.trail.length - 16}단계`));
    items.forEach((x, i) => {
      if (i || this.trail.length > 16) t.append(h('span', { class: 'tr-ar' }, '›'));
      t.append(h('span', { class: `tr ${LANES[x.lane]?.c || ''} ${x.bad ? 'bad' : ''} ${i === items.length - 1 ? 'last' : ''}` },
        x.lane !== 'L1' ? h('b', {}, x.lane === 'L3' ? 'L3' : 'L2') : null, x.label, x.n > 1 ? h('em', {}, `×${x.n}`) : null));
    });
    t.scrollLeft = t.scrollWidth;
  },
};

/* ══════════════════════════════════════════════════════════
   CodeAct — 작성 코드 · 샌드박스 단계 · 하위 Agent 호출
   ══════════════════════════════════════════════════════════ */
const Code = {
  el: {}, timer: null, kind: null, stages: [],
  build(host) {
    const e = this.el;
    e.actor = h('span', { class: 'actor' }, '—');
    e.purpose = h('span', { class: 'purpose' }, 'Agent가 코드를 쓰면 여기에 실시간으로 나타납니다');
    e.model = h('span', { class: 'model' }, '');
    e.code = h('pre', { class: 'ca2-code' });
    e.pipe = h('div', { class: 'ca2-pipe' });
    e.calls = h('div', { class: 'ca2-calls' });
    host.append(
      h('header', { class: 'fp-h' }, h('b', { class: 'kw l1' }, 'CODEACT'), h('span', { class: 'fp-d' }, 'Agent는 행동을 Python 코드로 써서 샌드박스에서 실행합니다')),
      h('div', { class: 'ca2-who' }, e.actor, e.purpose, e.model), e.code, e.pipe, e.calls);
    e.code.append(h('div', { class: 'ca2-empty' },
      h('div', {}, '이 패널에 나오는 코드는 모두 Agent가 직접 작성한 것입니다.'),
      h('div', {}, 'Super Agent의 실행 계획 · Healer의 진단/패치 · Factory의 새 Agent · Evolver의 진화 diff')));
    this.setPipe('plan', -1);
  },
  show(ev) {
    const e = this.el;
    const kind = ev.agent === 'super_agent' ? 'plan' : ev.agent === 'healer' ? (ev.diff ? 'patch' : 'diag')
      : ev.agent === 'factory' ? (/스키마/.test(ev.purpose || '') ? 'explore' : 'gen') : 'plan';
    const [nm, c] = ACTOR[ev.agent] || [AGENT_KO[ev.agent] || ev.agent, 'l1'];
    this.head(nm, c, ev.purpose || '', ev.model ? `${ev.model}${ev.source && ev.source !== 'online' ? ' · 오프라인 Playbook' : ''}` : (ev.template_id ? `편성 템플릿 ${ev.template_id}` : ''));
    if (kind === 'plan') this.resetCalls();
    this.setPipe(kind, 0);
    this.type(ev.code || '', !!ev.diff, ev.backlog, () => {
      this.mark(0, 'ok');
      this.mark(1, 'run');
      setTimeout(() => {
        this.mark(1, 'ok');
        if (kind === 'plan') { this.mark(2, 'ok'); this.mark(3, 'run'); } else this.mark(2, 'run');
      }, ev.backlog ? 0 : ms(320));
    });
  },
  evolve(ev) {
    const rb = ev.kind === 'rollback';
    this.head('Evolver', rb ? 'bad' : 'l3', `${AGENT_KO[ev.agent_id] || ev.agent_id} ${ev.from_version || '—'} → ${ev.to_version} · ${VKIND[ev.kind] || ev.kind}${ev.ref ? ` ${ev.ref}` : ''}`,
      `+${ev.diff_add || 0} / −${ev.diff_del || 0} lines`);
    this.setPipe(rb ? 'rollback' : 'evolve', -1);
    this.type(ev.diff, true, ev.backlog);
    this.stages.forEach((_, i) => setTimeout(() => this.mark(i, rb && i === 0 ? 'bad' : 'ok'), ev.backlog ? 0 : ms(160 * (i + 1))));
  },
  head(nm, c, purpose, model) {
    const e = this.el;
    e.actor.textContent = nm;
    e.actor.className = `actor ${c}`;
    e.purpose.textContent = purpose;
    e.model.textContent = model || '';
  },
  type(code, diff, instant, done) {
    const pre = this.el.code;
    clearInterval(this.timer);
    pre.innerHTML = '';
    if (diff) {
      pre.append(...diffLines(code));
      pre.scrollTop = 0;
      done?.();
      return;
    }
    if (instant || !spd()) { pre.innerHTML = highlight(code); done?.(); return; }
    let i = 0;
    const stepN = Math.max(6, Math.ceil(code.length / 70));
    this.timer = setInterval(() => {
      i = Math.min(code.length, i + stepN);
      pre.innerHTML = highlight(code.slice(0, i)) + (i < code.length ? '<span class="caret"></span>' : '');
      pre.scrollTop = pre.scrollHeight;
      if (i >= code.length) { clearInterval(this.timer); done?.(); }
    }, Math.max(10, 22 / Math.max(0.5, spd())));
  },
  setPipe(kind, cur) {
    this.kind = kind;
    const p = this.el.pipe;
    p.innerHTML = '';
    this.stages = PIPE[kind].map((t, i) => {
      if (i) p.append(h('span', { class: 'pp-ar' }, '→'));
      const st = h('span', { class: `pp ${i === cur ? 'run' : ''}` }, h('i', {}, String(i + 1)), t);
      p.append(st);
      return st;
    });
  },
  label(i, text) { const st = this.stages[i]; if (st) st.lastChild.textContent = text; },
  mark(i, state) {
    const st = this.stages[i];
    if (!st) return;
    st.classList.remove('run', 'ok', 'bad');
    st.classList.add(state);
  },
  node(ev) {
    const d = ev.detail || '';
    const bad = BAD[ev.node]?.test(d);
    const K = this.kind;
    if (K === 'plan' && ev.node === 'execute_sandbox') { this.mark(3, (ev.runs || []).some((r) => !r.ok) ? 'bad' : 'ok'); this.mark(4, 'run'); }
    if (K === 'plan' && ev.node === 'observe') this.mark(4, bad ? 'bad' : 'ok');
    if (K === 'diag' && ev.node === 'diagnose_codeact') { this.mark(2, 'ok'); this.mark(3, 'ok'); }
    if (K === 'patch' && ev.node === 'check_blacklist') { this.mark(1, bad ? 'bad' : 'ok'); if (!bad) this.mark(2, 'run'); }
    if (K === 'patch' && ev.node === 'run_regression' && /회귀 \d+\/\d+/.test(d)) { this.label(2, `회귀 ${/회귀 (\d+\/\d+)/.exec(d)[1]}`); this.mark(2, bad ? 'bad' : 'ok'); if (!bad) this.mark(3, 'run'); }
    if (K === 'patch' && ev.node === 'register_version') this.mark(3, 'ok');
    if (K === 'explore' && ev.node === 'explore_schema') { this.mark(2, 'ok'); this.mark(3, 'ok'); }
    if (K === 'gen' && ev.node === 'run_tests') { const m = /테스트 (\d+\/\d+)/.exec(d); if (m) this.label(2, `테스트 ${m[1]}`); this.mark(2, bad ? 'bad' : 'ok'); if (!bad) this.mark(3, 'run'); }
    if (K === 'gen' && ev.node === 'register_probation') this.mark(3, 'ok');
  },
  tests(ev) {
    if (!['patch', 'gen'].includes(this.kind)) return;
    const st = this.stages[2];
    if (!st) return;
    st.lastChild.textContent = ev.n ? `회귀 테스트 ${ev.n}건…` : `테스트: ${ev.label || ''}`;
    if (ev.ok === false) st.classList.add('bad');
  },
  resetCalls() {
    this.el.calls.innerHTML = '';
    this.calls = new Map();
  },
  call(ev, end) {
    if (!this.calls) this.resetCalls();
    const c = this.el.calls;
    if (!c.childElementCount) c.append(h('span', { class: 'cl-h' }, 'Super Agent가 코드로 호출한 Agent'));
    let chip = this.calls.get(ev.agent_id);
    if (!chip) {
      chip = h('span', { class: `cl ${ev.indirect ? 'ind' : ''}` }, ev.indirect ? '↳ ' : '', AGENT_KO[ev.agent_id] || short(ev.agent_id), h('em', {}, ev.version || ''));
      this.calls.set(ev.agent_id, chip);
      c.append(chip);
    }
    chip.classList.remove('run', 'ok', 'bad');
    chip.classList.add(end ? (ev.ok ? 'ok' : 'bad') : 'run');
    if (end && !ev.ok) chip.title = String(ev.error?.message || ev.error || '실패');
  },
};

/* ══════════════════════════════════════════════════════════
   Jev — 반복 분기 판단 (보정 확률)
   ══════════════════════════════════════════════════════════ */
const Jev = {
  el: {}, n: 0, rid: null,
  build(host) {
    const e = this.el;
    e.cnt = h('span', { class: 'fp-r' }, '');
    e.q = h('div', { class: 'jv-q' }, h('span', { class: 'muted' }, '루프 안의 반복 분기는 LLM 대신 Jev가 보정 확률로 판단합니다'));
    e.bars = h('div', { class: 'jv-bars' });
    host.append(h('header', { class: 'fp-h' }, h('b', { class: 'kw jev' }, 'JEV 판단'), h('span', { class: 'fp-d' }, '보정 확률 → 임계값 이상이면 자율 진행, 아니면 재검토'), e.cnt), e.q, e.bars);
  },
  show(ev) {
    const e = this.el;
    const rid = ev.request_id || ev.heal_id || ev.run_id || null;
    if (rid !== this.rid) { this.rid = rid; this.n = 0; }
    this.n += 1;
    e.cnt.textContent = rid ? `${rid} · ${this.n}번째 판단` : '';
    const sel = Array.isArray(ev.answer) ? ev.answer : [ev.answer];
    const ans = sel.map((x) => AGENT_KO[x] || x).join(', ');
    e.q.innerHTML = '';
    e.q.append(h('span', {}, HEAD_KO[ev.head] || ev.question || ev.head), h('span', { class: 'jv-ar' }, '→'), h('b', {}, ans || '-'));
    if (ev.threshold) e.q.append(h('span', { class: 'muted' }, ` 자율 ≥${ev.threshold}`));
    e.bars.innerHTML = '';
    const esc = (ev.escalated || []).map((x) => x.agent_id);
    const entries = Object.entries(ev.probs || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [k, p] of entries) {
      const c = sel.includes(k) ? 'sel' : esc.includes(k) ? 'esc' : 'off';
      const bar = h('i', { style: { width: ev.backlog ? `${Math.round(p * 100)}%` : '0%' } });
      e.bars.append(h('div', { class: `jv ${c}` }, h('span', { class: 'jv-k' }, AGENT_KO[k] || k), h('span', { class: 'jv-bar' }, bar), h('span', { class: 'jv-v' }, p.toFixed(2))));
      if (!ev.backlog) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${Math.round(p * 100)}%`; }));
    }
  },
};

/* ══════════════════════════════════════════════════════════
   Self-Evolving — Agent Genome 계보
   ══════════════════════════════════════════════════════════ */
const MAIN_AGENTS = ['super_agent', 'spec_agent', 'log_agent', 'legacy_agent'];
const EV_C = { baseline: 'base', heal: 'l2', grow: 'l2', evolve: 'l3', compose: 'l3', rollback: 'bad', promote: 'ok', restore: 'l1',
  deprecate: 'warn', retire: 'gone', grace_restart: 'warn', defect: 'bad' };
const Evo = {
  el: {}, rows: [], maxId: null, sig: '',
  build(host) {
    const e = this.el;
    e.cnt = h('div', { class: 'evo-cnt' });
    e.names = h('div', { class: 'evo-names' });
    e.scroll = h('div', { class: 'evo-scroll' });
    host.append(
      h('header', { class: 'fp-h' }, h('b', { class: 'kw l3' }, 'SELF-EVOLVING'), h('span', { class: 'fp-d' }, 'Agent Genome 계보 — 사람이 만든 1.0.0에서 Agent가 스스로 만들고·고치고·진화시킨 기록'), e.cnt),
      h('div', { class: 'evo-body' }, e.names, e.scroll),
      h('div', { class: 'evo-leg' }, ...[['l2', 'Grow 생성 · Heal 패치'], ['l3', 'Evolve 진화'], ['ok', '정식 승격'], ['bad', '롤백·결함'], ['warn', '폐기 유예'], ['gone', '폐기(아카이브)']]
        .map(([c, t]) => h('span', {}, h('i', { class: c }), t))));
  },
  async load() {
    try { this.rows = await api('/api/lineage'); } catch (e) { return; }
    this.render();
  },
  render() {
    const rows = this.rows;
    const st = A.state;
    if (!rows.length || !st) return;
    const chapters = st.story?.chapters || [];
    const reg = new Map((st.registry?.agents || []).map((a) => [a.agent_id, a]));
    // 열 = 같은 ref(진화 run·Heal·Grow 등)로 묶인 사건
    const cols = [];
    let prevKey = null;
    for (const r of rows) {
      const key = r.ref || r.ts;
      if (key !== prevKey) { cols.push({ key, ts: r.ts, ref: r.ref, items: [] }); prevKey = key; }
      cols[cols.length - 1].items.push(r);
    }
    const base = chapters[0]?.date || '2026-07-01';
    for (const c of cols) c.ch = chapterOf(c, chapters, base);
    // 행 = Agent (메인 → 생성된 Agent → 공용 스킬)
    const first = new Map();
    rows.forEach((r) => { if (!first.has(r.agent_id)) first.set(r.agent_id, r.id); });
    const ids = [...first.keys()];
    const kindOf = (id) => reg.get(id)?.kind || 'agent';
    const order = [...MAIN_AGENTS.filter((x) => first.has(x)),
      ...ids.filter((x) => !MAIN_AGENTS.includes(x) && kindOf(x) === 'agent').sort((a, b) => first.get(a) - first.get(b)),
      ...ids.filter((x) => kindOf(x) === 'skill').sort((a, b) => first.get(a) - first.get(b))];
    const RH = 15, TOP = 20;
    const avail = Math.max(300, this.el.scroll.clientWidth - 12);
    const CW = Math.max(42, Math.min(72, avail / cols.length));
    const W = Math.max(avail, cols.length * CW + 20), H = TOP + order.length * RH + 4;
    const svg = s('svg', { width: W, height: H, class: 'evo-svg' });
    // 챕터 띠
    let i0 = 0;
    for (let i = 1; i <= cols.length; i += 1) {
      if (i === cols.length || cols[i].ch !== cols[i0].ch) {
        const x = 8 + i0 * CW, w = (i - i0) * CW;
        const ch = chapters.find((c) => c.id === cols[i0].ch);
        svg.append(s('rect', { class: `band ${(chapters.indexOf(ch) % 2) ? 'odd' : ''}`, x, y: 0, width: w, height: H }));
        svg.append(s('text', { class: 'band-t', x: x + 4, y: 12 }, bandLabel(ch, w)));
        i0 = i;
      }
    }
    const newest = this.maxId;
    order.forEach((id, ri) => {
      const y = TOP + ri * RH + RH / 2;
      const cs = cols.map((c, ci) => ({ ci, it: c.items.filter((r) => r.agent_id === id) })).filter((x) => x.it.length);
      const a = reg.get(id);
      const x0 = 8 + cs[0].ci * CW + CW / 2;
      const gone = a?.status === 'retired';
      const xEnd = gone ? 8 + cs[cs.length - 1].ci * CW + CW / 2 : W - 4;
      svg.append(s('line', { class: `life ${gone ? 'gone' : ''} ${a?.status === 'deprecated' ? 'dep' : ''}`, x1: x0, y1: y, x2: xEnd, y2: y }));
      for (const { ci, it } of cs) {
        const pick = it.filter((r) => r.from_version !== r.to_version).pop() || it[it.length - 1];
        const x = 8 + ci * CW + CW / 2;
        const tip = it.map((r) => `${id} ${r.from_version || '—'} → ${r.to_version} · ${VKIND[r.kind] || r.kind} ${r.ref || ''} · ${String(r.ts).slice(0, 16)}\n${r.note || ''}`).join('\n\n');
        const fresh = newest != null && Number(pick.id) > newest;
        const c = EV_C[pick.kind] || 'base';
        let g;
        if (pick.from_version !== pick.to_version) {
          const w = textW(pick.to_version, 10) + 10;
          g = s('g', { class: `vp ${c} ${fresh ? 'new' : ''}`, transform: `translate(${x},${y})` }, s('title', {}, tip),
            s('rect', { x: -w / 2, y: -6.5, width: w, height: 13, rx: 6.5 }), s('text', { y: 3.6, 'text-anchor': 'middle' }, pick.to_version));
        } else if (pick.kind === 'retire') {
          g = s('g', { class: `vm gone ${fresh ? 'new' : ''}`, transform: `translate(${x},${y})` }, s('title', {}, tip), s('path', { d: 'M-4 -4L4 4M4 -4L-4 4' }));
        } else {
          g = s('g', { class: `vm ${c} ${fresh ? 'new' : ''}`, transform: `translate(${x},${y})` }, s('title', {}, tip), s('rect', { x: -4, y: -4, width: 8, height: 8, rx: 1.5, transform: 'rotate(45)' }));
        }
        svg.append(g);
      }
    });
    this.el.scroll.innerHTML = '';
    this.el.scroll.append(svg);
    this.el.scroll.scrollLeft = W;
    // 이름
    const nm = this.el.names;
    nm.innerHTML = '';
    nm.style.paddingTop = `${TOP}px`;
    for (const id of order) {
      const a = reg.get(id);
      nm.append(h('div', { class: `en ${a?.status || ''} ${a?.kind === 'skill' ? 'skill' : ''}`, title: `${id} · ${a?.status || ''}` },
        h('span', {}, AGENT_KO[id] || short(id)), h('em', {}, a?.active_version || '')));
    }
    // 카운터
    const n = (k) => rows.filter((r) => k.includes(r.kind) && (r.from_version !== r.to_version || ['retire'].includes(r.kind))).length;
    this.el.cnt.innerHTML = '';
    this.el.cnt.append(...[['l2', 'Grow', n(['grow'])], ['l2', 'Heal', n(['heal'])], ['l3', 'Evolve', n(['evolve', 'compose'])],
      ['bad', '롤백', n(['rollback'])], ['gone', '폐기', n(['retire'])], ['base', '교훈', st.counts?.lessons ?? 0]]
      .map(([c, t, v]) => h('span', { class: `ec ${c}` }, h('i', {}), t, h('b', {}, v))));
    this.maxId = Math.max(...rows.map((r) => Number(r.id)));
  },
  sync() {
    const sig = (A.state?.registry?.agents || []).map((a) => `${a.agent_id}:${a.active_version}:${a.status}:${a.versions.length}`).join('|');
    if (sig !== this.sig) { this.sig = sig; this.loadSoon(); }
  },
};
Evo.loadSoon = debounce(() => Evo.load(), 400);

function chapterOf(col, chapters, base) {
  if (!chapters.length) return null;
  if (col.items.every((r) => r.kind === 'baseline')) return chapters[0].id;
  const t = String(col.ts).slice(0, 10);
  if (t < base) return chapters[1]?.id;
  let best = chapters[1]?.id;
  for (const c of chapters) { const d = c.date.length === 7 ? `${c.date}-01` : c.date; if (d <= t) best = c.id; }
  return best;
}
function bandLabel(ch, w) {
  if (!ch) return '';
  const m = /SC-\d+/.exec(ch.title);
  const t = m ? `${m[0]}${/리플레이/.test(ch.title) ? ' 리플레이 3년' : ''}` : ch.title;
  return textW(t, 9.5) < w - 6 ? t : (m ? m[0].replace('SC-', '') : t.slice(0, 2));
}

/* ══════════════════════════════════════════════════════════
   이벤트 → 화면
   ══════════════════════════════════════════════════════════ */
const laneOf = (ev) => (ev.loop === 'L1' ? 'L1' : ev.loop === 'L3' ? 'L3' : ev.loop === 'L2' ? (ev.sub === 'grow' || ev.grow_id ? 'GROW' : 'HEAL') : null);
const runOf = (ev) => ev.request_id || ev.heal_id || ev.grow_id || ev.run_id || null;

function onNode(ev) {
  const lane = laneOf(ev);
  if (!lane) return;
  const slot = NODE_SLOT[lane][ev.node];
  if (!slot) return;
  const bad = !!BAD[ev.node]?.test(ev.detail || '');
  const run = runOf(ev);
  const first = run && Loops.st[lane].run !== run;
  if (first && !ev.backlog) {
    if (lane === 'HEAL') Loops.spark('l1-heal');
    if (lane === 'GROW') Loops.spark('l1-grow');
  }
  Loops.go(lane, slot, ev, { bad, run });
  if (!ev.backlog) {
    if (ev.node === 'reanswer_pending') Loops.spark('heal-l1');
    if (ev.node === 'register_probation') Loops.spark('grow-l1');
    if (ev.node === 'log_experience') Loops.spark('l1-l3');
    if (ev.node === 'mark_unavailable' || (ev.node === 'observe' && bad)) Loops.wait('L1', 'obs');
    if (ev.node === 'grow_subgraph') Loops.wait('L1', 'route');
  }
  if (lane !== 'L1' && run) Loops.status(lane, `${run}${ev.agent_id ? ` · ${short(ev.agent_id)}` : ''}${slot === '@stop' ? ' · 중단' : ''}`);
  if (lane === 'L1' && run) Loops.status('L1', `${run} · 진행 중`);
  const key = ev.node === 'start' ? `${lane}:start` : ev.node;
  const label = slot === '@back' ? (lane === 'L1' ? '경험 기록' : '재시도') : slot === '@stop' ? '중단' : LANES[lane].pos[slot].label;
  Cap.now(lane, SAY[key] || LANES[lane].pos[slot]?.label || ev.node, ev.detail, bad || slot === '@stop' ? 'bad' : '');
  Cap.step(lane, label, bad || slot === '@stop');
  Code.node(ev);
}

function onEvent(ev) {
  switch (ev.type) {
    case 'chapter':
      if (ev.phase === 'start') { Cap.chapter(ev); if (!ev.backlog) Loops.reset(); }
      break;
    case 'story': Cap.story(ev.text); break;
    case 'request':
      Cap.question(ev.user || '엔지니어', ev.text, ev.request_id);
      Code.resetCalls();
      Loops.go('L1', 'q', ev, { run: ev.request_id, detail: ev.text });
      Loops.status('L1', `${ev.request_id} · 진행 중`);
      Cap.now('L1', '질문이 들어왔습니다 — Super Agent가 처리를 시작합니다', ev.request_id);
      Cap.step('L1', '질문', false);
      break;
    case 'replay_case':
      Cap.question('리플레이', ev.text, `${ev.quarter} · replay_clock ${String(ev.replay_clock || '').slice(0, 10)}`);
      Loops.go('L1', 'q', ev, { run: `RP-${ev.qh_seq}`, detail: `과거 이력 재생 — ${ev.chamber_id} ${ev.pm_type}` });
      Loops.status('L1', `리플레이 QH ${ev.qh_seq} · ${ev.quarter}`);
      Cap.step('L1', '질문(과거)', false);
      break;
    case 'node': onNode(ev); break;
    case 'response':
      if (ev.request_id) Loops.status('L1', `${ev.request_id} · 응답`);
      break;
    case 'jev':
      Jev.show(ev);
      break;
    case 'code': Code.show(ev); break;
    case 'agent_start': if (Code.kind === 'plan') Code.call(ev, false); break;
    case 'agent_end': if (Code.kind === 'plan') Code.call(ev, true); break;
    case 'tests': Code.tests(ev); break;
    case 'budget': {
      const lane = ev.heal_id ? 'HEAL' : 'GROW';
      Loops.status(lane, `${ev.heal_id || ev.grow_id} · 시도 ${ev.attempts}/${ev.max_attempts} · ${ev.minutes}/${ev.max_minutes}분`);
      break;
    }
    case 'version': {
      if (ev.kind === 'baseline') break;
      if (['evolve', 'compose', 'rollback', 'promote', 'restore'].includes(ev.kind)) {
        Loops.go('L3', 'promote', ev, { bad: ev.kind === 'rollback', detail: `${short(ev.agent_id)} ${ev.from_version || '—'} → ${ev.to_version} (${VKIND[ev.kind]})` });
        if (!ev.backlog) Loops.spark('l3-l1');
        Cap.now('L3', ev.kind === 'rollback' ? `자동 롤백 — ${AGENT_KO[ev.agent_id] || ev.agent_id}를 이전 버전으로 되돌립니다`
          : `${AGENT_KO[ev.agent_id] || ev.agent_id}가 새 버전으로 진화했습니다 — 다음 질문부터 이 코드로 동작합니다`,
        `${ev.agent_id} ${ev.from_version || '—'} → ${ev.to_version} · ${VKIND[ev.kind] || ev.kind}${ev.ref ? ` ${ev.ref}` : ''} · +${ev.diff_add || 0}/−${ev.diff_del || 0}`, ev.kind === 'rollback' ? 'bad' : 'ver');
        Cap.step('L3', ev.kind === 'rollback' ? '롤백' : `${short(ev.agent_id)} ${ev.to_version}`, ev.kind === 'rollback');
        if (ev.diff) Code.evolve(ev);
      } else {
        Cap.now(ev.kind === 'grow' ? 'GROW' : 'HEAL', ev.kind === 'grow' ? `새 Agent ${AGENT_KO[ev.agent_id] || ev.agent_id}가 태어났습니다` : `${AGENT_KO[ev.agent_id] || ev.agent_id}가 스스로 고친 코드로 교체되었습니다`,
          `${ev.agent_id} ${ev.from_version || '—'} → ${ev.to_version}${ev.ref ? ` · ${ev.ref}` : ''} · +${ev.diff_add || 0}/−${ev.diff_del || 0}`, 'ver');
      }
      if (!ev.backlog) Evo.loadSoon();
      break;
    }
    case 'registry':
      if (ev.event === 'shadow') Loops.go('L3', 'shadow', ev, { detail: `${short(ev.agent_id)} ${ev.note || ''}` });
      if (ev.event === 'deprecate') Loops.go('L3', 'select', ev, { detail: `${short(ev.agent_id)} 폐기 유예 — ${ev.note || ''}` });
      if (ev.event === 'retire') { Loops.go('L3', 'archive', ev, { detail: `${short(ev.agent_id)} 폐기 → 아카이브 보관` }); Cap.now('L3', `${AGENT_KO[ev.agent_id] || ev.agent_id}를 폐기하고 아카이브에 보관합니다`, ev.note, 'ver'); }
      if (!ev.backlog && ev.event !== 'baseline') Evo.loadSoon();
      break;
    case 'candidate':
      Loops.go('L3', 'eval', ev, { run: ev.run_id, bad: ev.ok === false, detail: `${ev.cid} ${ev.title || ''} — ${ev.reason || ''}` });
      Cap.step('L3', `후보 ${ev.cid}`, ev.ok === false);
      break;
    case 'approval': {
      const L1k = ev.kind === 'state_change';
      if (ev.action === 'requested') {
        Loops.go(L1k ? 'L1' : 'L3', L1k ? 'gate' : 'select', ev, { detail: `승인 대기 — ${ev.title}` });
        Loops.wait(L1k ? 'L1' : 'L3', L1k ? 'gate' : 'select');
        Cap.now(L1k ? 'L1' : 'L3', '사람 승인을 기다립니다 — 무승인 변경은 0건', ev.title, 'gate');
      } else if (!String(ev.approver || '').includes('교대')) {
        Loops.go(L1k ? 'L1' : 'L3', L1k ? 'gate' : 'select', ev, { bad: !ev.approved, detail: `${ev.approved ? '승인' : '반려'} — ${ev.approver}` });
        Cap.now(L1k ? 'L1' : 'L3', `사람이 ${ev.approved ? '승인했습니다' : '반려했습니다'}`, `${ev.title} — ${ev.approver}${ev.reason ? ` (${ev.reason})` : ''}`, ev.approved ? 'ok' : 'bad');
      }
      break;
    }
    case 'fault':
      Cap.now('L1', '장애 주입 — 현실의 변화(로그 포맷·DB 이관 등)가 일어났습니다', ev.text, 'bad');
      break;
    case 'ops_batch':
      if (ev.phase === 'start') { Loops.status('L1', `배경 운영 0/${ev.n} · 자율 처리`); Cap.now('L1', '배경 운영 — 가상 엔지니어들의 요청을 Agent가 자율 처리합니다 (세부 화면 생략)', `${ev.start.slice(5, 16)} → ${ev.end.slice(5, 16)} · PM ${ev.n}건`); }
      if (ev.phase === 'progress') Loops.status('L1', `배경 운영 ${ev.done}/${ev.n} · 자율 처리`);
      if (ev.phase === 'end') Loops.status('L1', `배경 운영 ${ev.n}건 완료`);
      if (!ev.backlog) Loops.wake('L1');
      break;
    case 'replay_progress':
      if (ev.phase === 'start') Loops.status('L3', `리플레이 0/${ev.total.toLocaleString()} · Time-Travel Guard ON`);
      if (ev.phase === 'quarter_start') { Loops.status('L3', `리플레이 ${ev.quarter} · ${ev.split === 'heldout' ? 'Held-out (진화 없이 평가만)' : '진화 구간'}`); Cap.story(`이력 리플레이 — ${ev.quarter} 재생 중 (${ev.n}건). 미래 데이터는 Time-Travel Guard가 차단합니다.`); }
      if (ev.phase === 'case') Loops.status('L3', `리플레이 ${ev.done.toLocaleString()}/${ev.total.toLocaleString()} · ${String(ev.replay_clock || '').slice(0, 10)} · Guard 차단 ${ev.guard ?? 0}`);
      if (!ev.backlog) Loops.wake('L3');
      break;
    case 'replay_quarter':
      Cap.now('L3', `${ev.quarter} 진화 결과 — 판정 일치율 ${ev.accuracy}% · 추천 오차 ±${ev.rec_error}매`, (ev.events || []).slice(0, 2).join(' · '), 'ver');
      break;
    case '_state': Evo.sync(); break;
    default: break;
  }
}

/* ══════════════════════════════════════════════════════════
   질문 입력
   ══════════════════════════════════════════════════════════ */
const PRESETS = [
  'ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘',
  '지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘',
  'CVD-05 A챔버 PM 사이클 간 drift 추이 보여줘',
  'ETCH-07 B챔버 Wet Clean 최근 이력 보여줘',
  'Particle 15ea, ER 187.2 nm/min, Unif 2.4%',
];
function askForm() {
  const inp = h('input', { class: 'fl-in', list: 'fl-presets', placeholder: '질문을 넣어 Agent를 직접 움직여 보세요 (예시는 ▾)', 'aria-label': '질문 입력' });
  const f = h('form', { class: 'fl-ask' }, inp, h('datalist', { id: 'fl-presets' }, ...PRESETS.map((p) => h('option', { value: p }))),
    h('button', { class: 'btn primary small', type: 'submit' }, '질문'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const t = inp.value.trim();
    if (!t) return;
    inp.value = '';
    try { await api('/api/chat', { text: t }); } catch (err) { A.toast(err.message, 'error'); }
  };
  return f;
}

export const Flow = {
  init(app) {
    A = app;
    const v = $('#view-flow');
    const cap = h('section', { class: 'fl-cap' });
    const loops = h('section', { class: 'fl-panel fl-loops' });
    const code = h('section', { class: 'fl-panel fl-code' });
    const jev = h('section', { class: 'fl-panel fl-jev' });
    const evo = h('section', { class: 'fl-panel fl-evo' });
    loops.append(h('header', { class: 'fp-h' }, h('b', { class: 'kw l1' }, 'LOOP ENGINEERING'),
      h('span', { class: 'fp-d' }, '3중 루프 — 각 루프에 예산·종료 조건·검증 게이트'), askForm()));
    const map = h('div', { class: 'fl-map' });
    loops.append(map, h('footer', { class: 'fl-leg' },
      h('span', {}, h('i', { class: 'lg-tok' }), '토큰 = 지금 실행 중인 위치'),
      h('span', {}, h('i', { class: 'lg-ca' }), 'CodeAct (코드 작성·실행)'),
      h('span', {}, h('i', { class: 'lg-jev' }), 'Jev 판단 (보정 확률)'),
      h('span', {}, h('i', { class: 'lg-det' }), '결정적 코드 (LLM 아님)'),
      h('span', {}, h('i', { class: 'lg-gate' }), '사람 승인')));
    v.append(cap, loops, h('div', { class: 'fl-right' }, code, jev), evo);
    Cap.build(cap);
    Loops.build(map);
    Code.build(code);
    Jev.build(jev);
    Evo.build(evo);
    A.on('*', onEvent);
    Evo.sync();
    addEventListener('resize', debounce(() => Evo.render(), 300));
  },
  shown() { Evo.render(); },
};
