// 공용 유틸 — DOM 헬퍼, 포맷, API
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) { /* noop */ }
    throw new Error(msg);
  }
  return r.json();
}

export function vdate(vts) {
  if (!vts) return { d: '', t: '' };
  const [d, t] = String(vts).split(' ');
  return { d, t: (t || '').slice(0, 5) };
}

export const short = (id) => String(id || '').replace(/_agent$/, '');

export const AGENT_KO = {
  super_agent: 'Super Agent', spec_agent: '기준정보', log_agent: '로그분석', legacy_agent: '레거시DB',
  chamber_trend_agent: '챔버추이', part_history_agent: '부품이력', lot_trace_agent: 'Lot추적',
  legacy_sql_toolkit: 'SQL 툴킷', code_value_resolver: '코드값 해석', seasoning_pass_curve: 'Pass 곡선', fdc_toolkit: 'FDC 툴킷',
};

export const STATUS_KO = { active: '운영', probation: '시험 운영', deprecated: '폐기 유예', retired: '폐기', candidate: '후보' };

export const NODE_KO = {
  parse_request: '요청 해석', retrieve_memory: '경험 메모리 조회', jev_route: 'Jev 편성', grow_subgraph: 'Grow 진입', plan_codeact: '실행 계획(CodeAct)',
  execute_sandbox: '샌드박스 실행', observe: '관찰·사후 검증', mark_unavailable: '확인 불가 표시', synthesize: '결과 종합', respond: '응답',
  await_qual_result: 'Qual 결과 대기', deterministic_judge: '결정적 판정', rework_plan: '재작업 계획', approval_gate: '사람 승인 게이트',
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

export const HEAD_KO = { can_handle: '기존 Agent로 처리 가능?', route: 'Agent 편성 (multi-choice)', classify_error: '오류 유형 분류', need_evolve: '진화 필요?',
  need_merge: 'Agent 병합 필요?', need_retire: '폐기 필요?', unrecoverable: '복구 불가?', need_grow: '신규 분석 필요?', template_match: '템플릿 적용?',
  entity: '요청 장비는?' };

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function fmtNum(v, d = 1) {
  if (v == null || Number.isNaN(v)) return '-';
  return Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d });
}

export function diffLines(text) {
  return String(text || '').split('\n').map((ln) => {
    let cls = '';
    if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'add';
    else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'del';
    else if (ln.startsWith('@@')) cls = 'hunk';
    return h('div', { class: `dl ${cls}` }, ln || ' ');
  });
}

// 간단한 Python 하이라이터 (코드 뷰)
const KW = /\b(def|return|if|elif|else|for|in|import|from|as|not|and|or|None|True|False|while|try|except|raise|with|lambda|global|continue|break|pass)\b/g;
export function highlight(code) {
  return esc(code)
    .replace(/(&quot;.*?&quot;|'[^'\n]*')/g, '<span class="tk-s">$1</span>')
    .replace(/(#[^\n]*)/g, '<span class="tk-c">$1</span>')
    .replace(KW, '<span class="tk-k">$1</span>')
    .replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tk-n">$1</span>');
}
