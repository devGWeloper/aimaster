// 진화 슬라이스 — 진행 중인 Heal·Grow·Evolve 런의 4단계 진행 카드 (완료되면 리포트 카드로 대체)
import type { AnyEv } from '@/lib/types';
import { agentKo } from '@/lib/ko';

export type EvKind = 'heal' | 'grow' | 'evolve';
export const STEPS: Record<string, string[]> = {
  evolve: ['감지', '변이 후보', '하네스 평가', '선택·반영'], heal: ['오류 감지', 'Jev 분류·진단', '패치·회귀 테스트', '버전 반영'], grow: ['처리 불가 감지', '명세·스키마 탐색', '코드·테스트 생성', 'probation 등록'],
  rollback: ['Shadow 불일치', '원인', '원자적 롤백', 'Held-out 추가'], retire: ['미사용 감지', '의존성·대체 검증', '유예(deprecated)', '승인·아카이브'], replay: ['재생', '분기 진화', 'Held-out 평가', '결과'],
};
const NODE_STEP: Record<string, number> = { collect_metrics: 0, analyze_cause: 0, cluster_recheck: 0, classify_override: 0, jev_need_evolve: 0, jev_need_grow: 0, jev_need_retire: 0, jev_need_merge: 0,
  mutate: 1, evaluate_harness: 2, verify_replacement: 1, migrate_tests: 2, select: 3, archive: 3, shadow_run: 3, promote: 3, auto_rollback: 2,
  start: 0, jev_classify_error: 1, heal_history: 1, diagnose_codeact: 1, write_patch: 2, check_blacklist: 2, run_regression: 2, blacklist_patch: 2, register_version: 3, cascade: 3, reanswer_pending: 3, escalate_operator: 3,
  search_archive: 0, restore_genome: 2, write_spec: 1, explore_schema: 1, generate_code_and_tests: 2, run_tests: 2, register_probation: 3, abort_with_reason: 3 };

export interface LiveCard { id: string; kind: EvKind; title: string; stepIdx: number; stepState: 'run' | 'bad'; note: string; n: number; at: number; agent_id?: string; done: boolean }
export interface EvolveState { live: Record<string, LiveCard>; order: string[]; reportsVersion: number; lineageVersion: number }
export const initialEvolve = (): EvolveState => ({ live: {}, order: [], reportsVersion: 0, lineageVersion: 0 });

function card(E: EvolveState, id: string, kind: EvKind, title: string, ev: AnyEv): LiveCard {
  let c = E.live[id];
  if (!c) {
    c = { id, kind, title, stepIdx: 0, stepState: 'run', note: '시작', n: 0, at: ev.wall, done: false };
    E.live[id] = c;
    E.order.unshift(id);
    if (E.order.length > 12) { const old = E.order.pop()!; delete E.live[old]; }
  }
  return c;
}

export function evolveReduce(E: EvolveState, ev: AnyEv) {
  switch (ev.type) {
    case 'node': {
      if (ev.backlog) break;
      const key = ev.heal_id || ev.grow_id || ev.run_id;
      if (!key) break;
      const kind: EvKind = ev.heal_id ? 'heal' : ev.grow_id ? 'grow' : 'evolve';
      const title = kind === 'heal' ? `${agentKo(ev.agent_id)} ${ev.version || ''} 자가 복구` : kind === 'grow' ? `새 Agent 생성${ev.agent_id ? ` — ${agentKo(ev.agent_id)}` : ''}` : `L3 Evolve ${key}`;
      const c = card(E, key, kind, title, ev);
      if (ev.agent_id) { c.agent_id = ev.agent_id; c.title = title; }
      const i = NODE_STEP[ev.node];
      if (i != null) { c.stepIdx = i; c.stepState = /중단|실패|롤백|에스컬레이션/.test(ev.detail || '') ? 'bad' : 'run'; }
      c.note = ev.detail || ev.node;
      c.at = ev.wall;
      break;
    }
    case 'candidate': {
      if (ev.backlog) break;
      const c = card(E, ev.run_id, 'evolve', `L3 Evolve ${ev.run_id}`, ev);
      c.n += 1;
      c.note = `후보 ${c.n}개 평가 중 — 최근 ${ev.cid} ${ev.ok ? '채택' : '기각'} (${ev.reason || ''})`.slice(0, 140);
      c.stepIdx = 2; c.stepState = ev.ok ? 'run' : 'bad';
      break;
    }
    case 'report': {
      const c = E.live[ev.report_id];
      if (c) c.done = true;
      E.reportsVersion += 1;
      break;
    }
    case 'version': if (ev.kind !== 'baseline') E.lineageVersion += 1; break;
    case 'registry': if (ev.event !== 'baseline') E.lineageVersion += 1; break;
    default: break;
  }
}
