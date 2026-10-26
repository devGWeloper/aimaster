// Agent 편성 맵 — Super Agent가 어떤 Agent를 코드로 호출하는지, 각 Agent가 무슨 값을 가져왔는지, 누가 태어나고(Grow) 고쳐지고(Heal) 진화하고 폐기되는지를 실시간으로 그린다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BaseEdge, ReactFlow, ReactFlowProvider, ViewportPortal, getBezierPath, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { hub } from '@/lib/hub';
import { ms, useApp } from '@/store/store';
import type { AnyEv } from '@/lib/types';
import { cn } from '@/lib/utils';
import { buildGraph, curve, SUPER, W, H } from './layout';
import { AgentNode, PortNode, SkillNode, SuperNode } from './nodes';

const nodeTypes = { super: SuperNode, agent: AgentNode, skill: SkillNode, port: PortNode };

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<{ status?: string; kind?: string }>>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const k = data?.kind, st = data?.status;
  const style = k === 'skill' ? { stroke: 'var(--line-2)', strokeDasharray: '2 5', strokeWidth: 1.2, opacity: 0.8 }
    : k === 'dep' ? { stroke: '#4a5a6a', strokeDasharray: '6 4', strokeWidth: 1.3 }
      : st === 'probation' ? { stroke: 'color-mix(in oklab, var(--l2) 60%, var(--line-2))', strokeDasharray: '6 4', strokeWidth: 1.5 }
        : st === 'deprecated' ? { stroke: 'var(--line-2)', strokeDasharray: '3 6', strokeWidth: 1.2 }
          : { stroke: 'var(--line-2)', strokeWidth: 1.6 };
  return <BaseEdge id={id} path={path} style={style} markerEnd={k === 'dep' ? 'url(#aq-arrow)' : undefined} />;
}
const edgeTypes = { flow: FlowEdge };

interface Pulse { id: number; d: string; kind: string; label?: string; dur: number; mx: number; my: number }
const PULSE_C: Record<string, string> = { '': 'var(--l1)', back: 'var(--ok)', ind: '#8aa0b8', redirect: 'var(--warn)' };

function Inner({ live }: { live: boolean }) {
  const agents = useApp((s) => s.snap?.registry.agents);
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const graph = useMemo(() => buildGraph(agents || []), [agents]);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [step, setStep] = useState<{ text: string; cls: string } | null>(null);
  const [req, setReq] = useState<string | null>(null);
  const pid = useRef(0);
  const posRef = useRef(graph.pos);
  posRef.current = graph.pos;

  useEffect(() => {
    const fit = () => rf.fitView({ padding: 0.04, duration: 250 });
    const t = setTimeout(fit, 50);
    const ro = new ResizeObserver(() => fit());
    if (wrap.current) ro.observe(wrap.current);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [rf, graph]);

  useEffect(() => {
    const pulse = (from: string, to: string, kind = '', label?: string) => {
      const P = posRef.current;
      const a = P.get(from) || P.get('super_agent')!, b = P.get(to);
      if (!a || !b) return;
      const dur = ms(700) || 250;
      const id = ++pid.current;
      const d = curve(a, b, from === 'super_agent' || !P.get(from) ? 0.15 : 0.25);
      setPulses((p) => [...p.slice(-12), { id, d, kind, label, dur, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 - 8 }]);
      setTimeout(() => setPulses((p) => p.filter((x) => x.id !== id)), Math.max(dur, label ? (ms(2400) || 900) : dur) + 80);
    };
    const STEP: Record<string, string> = { parse_request: '요청 해석', retrieve_memory: '경험 메모리 조회', jev_route: 'Jev 편성', grow_subgraph: 'Grow 대기', plan_codeact: 'CodeAct 계획 작성', execute_sandbox: '샌드박스 실행',
      observe: '사후 검증', mark_unavailable: '확인 불가 표시 → Heal', synthesize: '결과 종합', respond: '응답', await_qual_result: 'Qual 결과 대기', deterministic_judge: 'judge_qual 판정', rework_plan: '재작업 계획', approval_gate: '사람 승인 대기', apply_state_change: '상태 반영', log_experience: '경험 기록' };
    const offs = [
      hub.on('request', (ev: AnyEv) => { if (ev.source === 'sim') return; setReq(ev.request_id); setStep({ text: `요청 접수 — ${ev.request_id}`, cls: 'l1' }); }),
      hub.on('agent_start', (ev: AnyEv) => pulse(ev.caller || 'super_agent', ev.agent_id, ev.indirect ? 'ind' : '', live ? ev.action : undefined)),
      hub.on('agent_end', (ev: AnyEv) => pulse(ev.agent_id, ev.caller && posRef.current.get(ev.caller) ? ev.caller : 'super_agent', 'back')),
      hub.on('redirect', (ev: AnyEv) => pulse(ev.agent_id, ev.to, 'redirect', '리다이렉트')),
      hub.on('node', (ev: AnyEv) => {
        if (ev.loop === 'L1' && STEP[ev.node]) setStep({ text: STEP[ev.node], cls: ev.node === 'approval_gate' ? 'gate' : ev.node === 'mark_unavailable' ? 'bad' : 'l1' });
        if (ev.loop === 'L2' && ev.sub !== 'grow') setStep({ text: `Self-Healing ${ev.heal_id} — ${ev.detail || ''}`.slice(0, 64), cls: 'l2' });
        if (ev.loop === 'L2' && ev.sub === 'grow') setStep({ text: `Agent Factory ${ev.grow_id} — ${ev.detail || ''}`.slice(0, 64), cls: 'l2' });
        if (ev.loop === 'L3') setStep({ text: `L3 Evolve ${ev.run_id} — ${ev.detail || ''}`.slice(0, 64), cls: 'l3' });
      }),
      hub.on('response', (ev: AnyEv) => { if (ev.rtype && !['rework', 'judge', 'state'].includes(ev.rtype)) setStep({ text: '응답 완료', cls: 'ok' }); }),
      hub.on('judge', (ev: AnyEv) => setStep({ text: `judge_qual → ${ev.judgement?.result} (결정적 코드)`, cls: ev.judgement?.result === 'PASS' ? 'ok' : 'bad' })),
      hub.on('approval', (ev: AnyEv) => { if (ev.kind === 'state_change') setStep({ text: ev.action === 'requested' ? '사람 승인 대기 — 장비 UP' : `사람 ${ev.approved ? '승인' : '반려'} — ${ev.approver}`, cls: ev.action === 'requested' ? 'gate' : ev.approved ? 'ok' : 'bad' }); }),
      hub.on('version', (ev: AnyEv) => { if (ev.kind !== 'baseline') pulse('port:' + (ev.kind === 'heal' ? 'healer' : ev.kind === 'grow' ? 'factory' : 'evolver'), ev.agent_id, '', VKIND_SHORT[ev.kind]); }),
    ];
    return () => offs.forEach((o) => o());
  }, [live]);

  return (
    <div ref={wrap} className="relative h-full w-full">
      <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.04 }} minZoom={0.2} maxZoom={2}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnPinch={false} panOnDrag={false} panOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }}>
        <svg style={{ position: 'absolute', width: 0, height: 0 }}><defs><marker id="aq-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="#4a5a6a" /></marker></defs></svg>
        <ViewportPortal>
          <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
            {pulses.map((p) => (
              <g key={p.id}>
                <path d={p.d} fill="none" stroke={PULSE_C[p.kind] || PULSE_C['']} strokeWidth={2} strokeOpacity={0.35} strokeDasharray="4 6" />
                <circle r={5} fill={PULSE_C[p.kind] || PULSE_C['']} style={{ filter: 'drop-shadow(0 0 6px currentColor)' }}>
                  <animateMotion dur={`${p.dur}ms`} path={p.d} fill="freeze" calcMode="spline" keySplines="0.3 0 0.2 1" keyTimes="0;1" />
                </circle>
                {p.label && <g transform={`translate(${p.mx},${p.my})`}><rect x={-(p.label.length * 6.5 + 16) / 2} y={-10} width={p.label.length * 6.5 + 16} height={20} rx={10} fill="#1b242e" stroke={PULSE_C[p.kind] || PULSE_C['']} strokeOpacity={0.6} /><text y={4} textAnchor="middle" fill="#e8eef4" fontSize={11} fontFamily="JetBrains Mono, monospace">{p.label}</text></g>}
              </g>
            ))}
            {step && live && (
              <g transform={`translate(${SUPER.x},${SUPER.y + 52})`}>
                <rect x={-130} y={-11} width={260} height={22} rx={11} fill="#1b242e" stroke={`var(--${step.cls === 'bad' ? 'bad' : step.cls === 'ok' ? 'ok' : step.cls === 'gate' ? 'gate' : step.cls === 'l2' ? 'l2' : step.cls === 'l3' ? 'l3' : 'l1'})`} strokeOpacity={0.7} />
                <text y={4} textAnchor="middle" fill="#e8eef4" fontSize={11.5} fontWeight={600}>{step.text.length > 34 ? `${step.text.slice(0, 33)}…` : step.text}</text>
              </g>
            )}
          </svg>
        </ViewportPortal>
      </ReactFlow>
      {req && live && <div className="absolute right-3 top-2 font-mono text-[11px] text-ink-3">{req}</div>}
    </div>
  );
}
const VKIND_SHORT: Record<string, string> = { heal: 'Heal 패치', grow: '생성', evolve: 'Evolve', compose: '구성', rollback: '롤백', promote: '승격', restore: '복원' };

export default function OrchestrationMap({ live = true, className }: { live?: boolean; className?: string }) {
  return (
    <div className={cn('relative h-full w-full', className)}>
      <ReactFlowProvider><Inner live={live} /></ReactFlowProvider>
      <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-3 text-[10.5px] text-ink-3">
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm border border-line-2 bg-panel-2" />운영(active)</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm border border-dashed border-l2" />시험 운영(probation)</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm border border-dashed border-warn" />폐기 유예</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-l1" />호출 · <i className="size-2 rounded-full bg-ok" />값 반환</span>
        <span className="flex items-center gap-1"><i className="h-2 w-5 rounded-full border border-l1/50 bg-[#10302f]" />값 칩 = 이번 호출에서 가져온 값</span>
      </div>
    </div>
  );
}
