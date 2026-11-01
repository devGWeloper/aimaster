// 편성 맵 레이아웃 — Super Agent(위) · 메인/생성 Agent(가운데 줄) · 공용 스킬(아래 줄) · 시스템 포트(양옆·아래)
//   발표 화면에서 글자가 읽히도록 여백을 줄이고 노드를 키운다. Agent 수가 늘면 노드 폭이 줄어든다.
import type { Edge, Node } from '@xyflow/react';
import type { Agent } from '@/lib/types';

export const W = 1100, H = 490;
export const SIZE = { super: [320, 88], agent: [200, 108], skill: [150, 48], port: [168, 50] } as const;
export const PORTS: Record<string, { x: number; y: number; label: string; sub: string; c: string }> = {
  jev: { x: 92, y: 36, label: 'Jev 판단', sub: '분기 판단 · 보정 확률', c: 'jev' },
  memory: { x: 92, y: 98, label: '경험 메모리', sub: '교훈 · 사례 · 템플릿', c: 'l1' },
  sandbox: { x: 1008, y: 36, label: 'Sandbox', sub: '코드 실행 · 읽기 전용', c: 'l1' },
  harness: { x: 1008, y: 98, label: '평가 하네스', sub: '테스트 · 채점 (루프 밖 고정)', c: 'ok' },
  healer: { x: 92, y: 400, label: 'Healer', sub: 'L2 Heal · 자기 코드 패치', c: 'l2' },
  factory: { x: 550, y: 458, label: 'Agent Factory', sub: 'L2 Grow · 새 Agent 생성', c: 'l2' },
  evolver: { x: 1008, y: 400, label: 'Evolver', sub: 'L3 Evolve · 변이·평가·선택', c: 'l3' },
};
export const SUPER = { x: 550, y: 50 };
const ROW_AGENT = 218, ROW_SKILL = 342;
const MAIN = ['spec_agent', 'log_agent', 'legacy_agent'];

export type AgentData = { agent: Agent; kind: 'super' | 'agent' | 'skill'; w: number };
export type PortData = { id: string; label: string; sub: string; c: string };
export type MapNode = Node<AgentData, 'super' | 'agent' | 'skill'> | Node<PortData, 'port'>;

// 한 줄에 n개를 가운데 정렬로 배치 — 간격은 maxStep 이하, 전체 폭은 span 이하. 노드 폭은 간격에 맞춰 줄인다.
function row(n: number, span: number, maxStep: number, maxW: number) {
  const step = n > 1 ? Math.min(maxStep, span / (n - 1)) : 0;
  const x0 = W / 2 - (step * (n - 1)) / 2;
  return { xs: Array.from({ length: n }, (_, i) => x0 + i * step), w: n > 1 ? Math.min(maxW, step - 14) : maxW };
}

export function centers(agents: Agent[]) {
  const pos = new Map<string, [number, number]>();
  const width = new Map<string, number>();
  pos.set('super_agent', [SUPER.x, SUPER.y]);
  const ag = agents.filter((a) => a.kind === 'agent' && a.agent_id !== 'super_agent' && a.status !== 'retired');
  const order = [...MAIN.filter((x) => ag.some((a) => a.agent_id === x)), ...ag.filter((a) => !MAIN.includes(a.agent_id)).sort((a, b) => ((a.created_ts || '') > (b.created_ts || '') ? 1 : -1)).map((a) => a.agent_id)];
  const ra = row(order.length, W - 200, 270, SIZE.agent[0]);
  order.forEach((id, i) => { pos.set(id, [ra.xs[i], ROW_AGENT]); width.set(id, ra.w); });
  const sk = agents.filter((a) => a.kind === 'skill').map((a) => a.agent_id);
  const rs = row(sk.length, 600, 200, SIZE.skill[0]);
  sk.forEach((id, i) => { pos.set(id, [rs.xs[i], ROW_SKILL]); width.set(id, rs.w); });
  for (const [k, p] of Object.entries(PORTS)) pos.set(`port:${k}`, [p.x, p.y]);
  return { pos, width };
}

export function buildGraph(agents: Agent[]): { nodes: MapNode[]; edges: Edge[]; pos: Map<string, [number, number]> } {
  const { pos, width } = centers(agents);
  const nodes: MapNode[] = [];
  const edges: Edge[] = [];
  for (const [k, p] of Object.entries(PORTS)) {
    const [w, h] = SIZE.port;
    nodes.push({ id: `port:${k}`, type: 'port', position: { x: p.x - w / 2, y: p.y - h / 2 }, data: { id: k, label: p.label, sub: p.sub, c: p.c }, draggable: false, selectable: false, width: w, height: h });
  }
  for (const a of agents) {
    const p = pos.get(a.agent_id);
    if (!p) continue;
    const kind = a.agent_id === 'super_agent' ? 'super' : a.kind === 'skill' ? 'skill' : 'agent';
    const h = SIZE[kind][1];
    const w = width.get(a.agent_id) ?? SIZE[kind][0];
    nodes.push({ id: a.agent_id, type: kind, position: { x: p[0] - w / 2, y: p[1] - h / 2 }, data: { agent: a, kind, w }, draggable: false, selectable: false, width: w, height: h } as MapNode);
    if (kind === 'agent') edges.push({ id: `e:super:${a.agent_id}`, source: 'super_agent', target: a.agent_id, sourceHandle: 'b', targetHandle: 't', type: 'flow', data: { status: a.status, kind: 'call' } });
    for (const skid of Object.keys(a.deps?.skills || {})) if (pos.has(skid)) edges.push({ id: `e:${a.agent_id}:${skid}`, source: a.agent_id, target: skid, sourceHandle: 'b', targetHandle: 't', type: 'flow', data: { kind: 'skill' } });
    for (const dep of a.deps?.agents || []) if (pos.has(dep)) {
      const left = (pos.get(a.agent_id)![0] < pos.get(dep)![0]);
      edges.push({ id: `e:${a.agent_id}:${dep}`, source: a.agent_id, target: dep, sourceHandle: left ? 'rs' : 'ls', targetHandle: left ? 'lt' : 'rt', type: 'flow', data: { kind: 'dep' } });
    }
  }
  return { nodes, edges, pos };
}

// 연출용 곡선 경로 (중심 → 중심)
export function curve(a: [number, number], b: [number, number], bend = 0.15) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return `M ${a[0]} ${a[1]} Q ${mx - dy * bend} ${my + dx * bend} ${b[0]} ${b[1]}`;
}
