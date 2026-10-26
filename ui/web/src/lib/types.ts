// 이벤트·스냅샷 타입 — 백엔드(autoqual/*)가 SSE로 송출하는 이벤트는 type별 필드가 다르므로 열린 타입으로 받는다.
export type Lane = 'L1' | 'HEAL' | 'GROW' | 'L3';
export type Tone = '' | 'ok' | 'bad' | 'ver' | 'gate' | 'warn';

export interface Ev {
  seq: number;
  type: string;
  vts?: string;
  wall: number;
  backlog?: boolean;
}
// 자주 쓰는 필드에 접근할 때의 편의 타입
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEv = Ev & Record<string, any>;

export interface Chapter { id: string; title: string; date: string; desc: string; done: boolean; checkpoint: boolean }
export interface Agent {
  agent_id: string; kind: 'agent' | 'skill'; name_ko?: string; protected?: boolean;
  status: 'active' | 'probation' | 'deprecated' | 'retired' | 'candidate' | string;
  active_version: string | null; shadow_version?: string | null; shadow_mode?: string | null; replacement?: string | null; grace_until?: string | null;
  origin?: string; created_ts?: string; last_called_ts?: string | null; direct_calls: number; indirect_calls: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lines: number; deps: { skills?: Record<string, string>; agents?: string[] }; card?: any;
  versions: { version: string; status: string; reason?: string; ts?: string }[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Approval { request_id: string; kind: string; title: string; payload: any; status: 'pending' | 'approved' | 'rejected'; requested_ts: string; decided_ts?: string | null; approver?: string | null; reason?: string | null }
export interface FabChamber { chamber_id: string; state: 'RUN' | 'DOWN' | 'QUAL' | 'APPROVAL' | string; since: string; note?: string; thread_id?: string | null }
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Snapshot {
  clock: string; speed: number; paused: boolean; approval_mode: 'manual' | 'auto';
  llm: { mode: string; base_url?: string; [k: string]: any }; jev: { model: string; calls: number };
  story: { chapters: Chapter[]; current: string | null; running: boolean; done?: string[]; last?: string };
  registry: { agents: Agent[] }; approvals: Approval[]; faults: any[]; replay: any; replay_rows: any[]; after_sc007: any;
  fab: FabChamber[]; policy: any;
  counts: { lessons: number; cases: number; heals: number; grows: number; evolves: number; archive: number; audit: number; sandbox: any; guard: any };
  last_seq: number;
}
export interface LineageRow { id: number; agent_id: string; from_version: string | null; to_version: string; kind: string; ref?: string; ts: string; note?: string; diff_add?: number; diff_del?: number }
export interface Report { report_id: string; kind: string; title: string; ts: string; content: any }
/* eslint-enable @typescript-eslint/no-explicit-any */
