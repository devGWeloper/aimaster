// 편성 맵 레이아웃 — Super Agent(위) · 메인/생성 Agent(가운데 줄) · 공용 스킬(아래 줄) · 시스템 포트(양옆·아래)
import type { Edge, Node } from '@xyflow/react';
import type { Agent } from '@/lib/types';

export const W = 1000, H = 440;
export const SIZE = { super: [224, 68], agent: [152, 64], skill: [122, 40], port: [136, 42] } as const;
export const PORTS: Record<string, { x: number; y: number; label: string; sub: string; c: string }> = {
  jev: { x: 92, y: 62, label: 'Jev 판단', sub: '보정 확률', c: 'jev' },
  memory: { x: 92, y: 122, label: '경험 메모리', sub: '교훈·사례·템플릿', c: 'l1' },
  sandbox: { x: 908, y: 62, label: 'Sandbox', sub: 'AST·프록시·감사', c: 'l1' },
  harness: { x: 908, y: 122, label: '평가 하네스', sub: '루프 밖 고정', c: 'ok' },
  healer: { x: 92, y: 322, label: 'Healer', sub: 'L2 Heal · 자기 코드 패치', c: 'l2' },
  factory: { x: 500, y: 404, label: 'Agent Factory', sub: 'L2 Grow · 새 Agent 생성', c: 'l2' },
  evolver: { x: 908, y: 322, label: 'Evolver', sub: 'L3 Evolve · 변이·평가·선택', c: 'l3' },
};
export const SUPER = { x: 500, y: 62 };
const ROW_AGENT = 200, ROW_SKILL = 312;
const MAIN = ['spec_agent', 'log_agent', 'legacy_agent'];

export type AgentData = { agent: Agent; kind: 'super' | 'agent' | 'skill' };
export type PortData = { id: string; label: string; sub: string; c: string };
export type MapNode = Node<AgentData, 'super' | 'agent' | 'skill'> | Node<PortData, 'port'>;

export function centers(agents: Agent[]) {
  const pos = new Map<string, [number, number]>();
  pos.set('super_agent', [SUPER.x, SUPER.y]);
  const ag = agents.filter((a) => a.kind === 'agent' && a.agent_id !== 'super_agent' && a.status !== 'retired');
  const order = [...MAIN.filter((x) => ag.some((a) => a.agent_id === x)), ...ag.filter((a) => !MAIN.includes(a.agent_id)).sort((a, b) => ((a.created_ts || '') > (b.created_ts || '') ? 1 : -1)).map((a) => a.agent_id)];
  const x0 = 200, x1 = 800;
  const stepA = order.length > 1 ? (x1 - x0) / (order.length - 1) : 0;
  order.forEach((id, i) => pos.set(id, [order.length > 1 ? x0 + i * stepA : 500, ROW_AGENT]));
  const sk = agents.filter((a) => a.kind === 'skill').map((a) => a.agent_id);
  const sx0 = 250, sx1 = 750;
  const stepS = sk.length > 1 ? (sx1 - sx0) / (sk.length - 1) : 0;
  sk.forEach((id, i) => pos.set(id, [sk.length > 1 ? sx0 + i * stepS : 500, ROW_SKILL]));
  for (const [k, p] of Object.entries(PORTS)) pos.set(`port:${k}`, [p.x, p.y]);
  return pos;
}

export function buildGraph(agents: Agent[]): { nodes: MapNode[]; edges: Edge[]; pos: Map<string, [number, number]> } {
  const pos = centers(agents);
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
    const [w, h] = SIZE[kind];
    nodes.push({ id: a.agent_id, type: kind, position: { x: p[0] - w / 2, y: p[1] - h / 2 }, data: { agent: a, kind }, draggable: false, selectable: false, width: w, height: h } as MapNode);
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
