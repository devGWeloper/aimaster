// 편성 맵 노드 — Agent(호출 중·오류·치유 중·새 버전·탄생·값 칩) · Super Agent(단계 라벨) · 스킬 · 시스템 포트(hot)
import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { hub } from '@/lib/hub';
import { AGENT_DESC, AGENT_KO, STATUS_KO, VKIND, short } from '@/lib/ko';
import { ms, useApp } from '@/store/store';
import type { AnyEv } from '@/lib/types';
import { cn } from '@/lib/utils';
import type { AgentData, PortData } from './layout';

let booted = false;
let seqCounter = 0;
setTimeout(() => { booted = true; }, 2500);
hub.on('_backlog', () => { booted = false; seqCounter = 0; setTimeout(() => { booted = true; }, 1200); });
hub.on('request', (ev: AnyEv) => { if (ev.source !== 'sim') seqCounter = 0; });
hub.on('agent_start', (ev: AnyEv) => { seqCounter += 1; ev._seq = seqCounter; });   // 호출 순번 (노드 구독보다 먼저 등록되어 먼저 실행)

interface Fx { calling: boolean; error: boolean; healing: boolean; flash: boolean; done: boolean; seq: number | null; born: boolean; chip: { text: string; cls: string; id: number } | null; scan: boolean }
const fx0: Fx = { calling: false, error: false, healing: false, flash: false, done: false, seq: null, born: false, chip: null, scan: false };

function useFx(id: string, kind: 'super' | 'agent' | 'skill') {
  const [fx, setFx] = useState<Fx>(fx0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const chipId = useRef(0);
  useEffect(() => {
    const T = timers.current;
    const mark = (k: keyof Fx, dur?: number) => { setFx((f) => ({ ...f, [k]: true })); if (dur) { clearTimeout(T[k]); T[k] = setTimeout(() => setFx((f) => ({ ...f, [k]: false })), dur); } };
    const unmark = (k: keyof Fx) => { clearTimeout(T[k]); setFx((f) => ({ ...f, [k]: false })); };
    const chip = (text: string, cls: string, dur = 7000) => {
      const cid = ++chipId.current;
      setFx((f) => ({ ...f, chip: { text, cls, id: cid } }));
      clearTimeout(T.chip);
      if (dur) T.chip = setTimeout(() => setFx((f) => (f.chip?.id === cid ? { ...f, chip: null } : f)), dur);
    };
    if (kind === 'agent' && booted) { mark('born', ms(20000) || 6000); chip('새 Agent 생성 (probation)', 'l2', 9000); }
    void seqCounter;
    const offs = [
      hub.on('request', (ev: AnyEv) => { if (ev.source === 'sim') return; setFx((f) => ({ ...f, done: false, seq: null, chip: kind === 'super' ? f.chip : null })); if (kind === 'super') mark('calling', 1500); }),
      hub.on('agent_start', (ev: AnyEv) => {
        if (kind === 'super') { mark('calling', 1200); return; }
        if (ev.agent_id !== id) return;
        mark('calling');
        setFx((f) => ({ ...f, seq: f.seq ?? ev._seq ?? null }));
      }),
      hub.on('agent_end', (ev: AnyEv) => {
        if (ev.agent_id !== id) return;
        unmark('calling');
        if (!ev.ok) { mark('error', 4000); chip(`✗ ${ev.error_type || '오류'} → 확인 불가 · Heal`, 'bad', 9000); }
        else { if ((ev.summary || []).length) chip(ev.summary[0], 'val', 0); mark('done'); }
      }),
      hub.on('code', (ev: AnyEv) => { if (kind === 'super' && ev.agent === 'super_agent') { mark('calling', 1500); chip(ev.template_id ? `편성 템플릿 ${ev.template_id} 적용` : '실행 계획 코드 작성 (CodeAct)', 'l1', 4000); } }),
      hub.on('jev', (ev: AnyEv) => { if (kind === 'super' && ev.head === 'route') chip(`Jev 편성 → ${(Array.isArray(ev.answer) ? ev.answer : [ev.answer]).map(short).join(' + ')}`, 'jev', 5000); }),
      hub.on('node', (ev: AnyEv) => {
        if (ev.loop === 'L2' && ev.sub !== 'grow' && ev.agent_id === id) {
          mark('healing', ms(5000) || 1500);
          if (ev.node === 'write_patch' || ev.node === 'diagnose_codeact') mark('scan', ms(2700) || 900);
          if (ev.node === 'write_patch') chip('Healer가 소스 코드 패치 중', 'l2', 5000);
          if (ev.node === 'diagnose_codeact') chip('Healer가 원인 진단 중', 'l2', 5000);
        }
      }),
      hub.on('version', (ev: AnyEv) => {
        if (ev.agent_id !== id || ev.kind === 'baseline') return;
        mark('flash', 1400);
        chip(`${ev.from_version || '—'} → ${ev.to_version} (${VKIND[ev.kind] || ev.kind})`, ev.kind === 'rollback' ? 'bad' : 'ver', 8000);
        if (ev.kind === 'rollback') mark('error', 3000);
      }),
      hub.on('registry', (ev: AnyEv) => {
        if (ev.agent_id !== id) return;
        if (ev.event === 'retire') chip('폐기 → 아카이브 보관', 'gone', 9000);
        if (ev.event === 'deprecate') chip('폐기 유예 — 호출은 대체 Agent로', 'warn', 9000);
        if (ev.event === 'promote') chip('정식 승격', 'ok', 8000);
      }),
    ];
    return () => { offs.forEach((o) => o()); Object.values(T).forEach(clearTimeout); };
  }, [id, kind]);
  return fx;
}

const CHIP: Record<string, string> = { val: 'border-l1/50 bg-[#10302f] text-[#c9f5f1]', bad: 'border-bad/60 bg-[#3a1f20] text-[#ffd6d4]', l2: 'border-l2/60 bg-[#381f30] text-[#ffd8ef]', l1: 'border-l1/50 bg-[#10302f] text-[#c9f5f1]',
  jev: 'border-jev/60 bg-[#1b2b42] text-[#d9e9ff]', ver: 'border-l3/60 bg-[#2a2850] text-[#e2e0ff]', gone: 'border-line-2 bg-raise text-ink-2', warn: 'border-warn/60 bg-[#3a2d14] text-[#ffe9c6]', ok: 'border-ok/60 bg-[#163324] text-[#d2f7e2]' };

function Chip({ chip, w }: { chip: Fx['chip']; w: number }) {
  if (!chip) return null;
  const str = chip.text.length > 36 ? `${chip.text.slice(0, 35)}…` : chip.text;
  return <div key={chip.id} title={chip.text} className={cn('pop absolute left-1/2 top-full z-10 mt-1.5 max-w-[260px] -translate-x-1/2 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium', CHIP[chip.cls] || CHIP.val)} style={{ minWidth: Math.min(w, 80) }}>{str}</div>;
}
const Handles = () => (
  <>
    <Handle id="t" type="target" position={Position.Top} />
    <Handle id="b" type="source" position={Position.Bottom} />
    <Handle id="ls" type="source" position={Position.Left} /><Handle id="lt" type="target" position={Position.Left} />
    <Handle id="rs" type="source" position={Position.Right} /><Handle id="rt" type="target" position={Position.Right} />
  </>
);

export const SuperNode = memo(function SuperNode({ data }: NodeProps<Node<AgentData>>) {
  const fx = useFx('super_agent', 'super');
  const a = data.agent;
  const open = useApp((s) => s.openDrawer);
  return (
    <div className="relative" style={{ width: 224, height: 68 }}>
      <Handles />
      <button type="button" onClick={() => open('agent', a.agent_id)} className={cn('lane-l1 flex h-full w-full flex-col items-center justify-center rounded-xl border-2 border-l1/70 bg-[#13303a] text-center shadow-[0_0_0_0_transparent] transition-shadow',
        fx.calling && 'beat border-l1 shadow-[0_0_24px_color-mix(in_oklab,var(--l1)_45%,transparent)]')}>
        <div className="text-[15px] font-extrabold tracking-tight">Super Agent</div>
        <div className="font-mono text-[10.5px] text-l1">{a.active_version}</div>
        <div className="text-[10px] text-ink-3">{AGENT_DESC.super_agent}</div>
      </button>
      <Chip chip={fx.chip} w={224} />
    </div>
  );
});

export const AgentNode = memo(function AgentNode({ id, data }: NodeProps<Node<AgentData>>) {
  const fx = useFx(id, 'agent');
  const a = data.agent;
  const open = useApp((s) => s.openDrawer);
  const st = a.status;
  const stC = st === 'active' ? 'l1' : st === 'probation' ? 'l2' : st === 'deprecated' ? 'warn' : 'ink';
  return (
    <div className="relative" style={{ width: 152, height: 64 }}>
      <Handles />
      <button type="button" onClick={() => open('agent', a.agent_id)} title={`${a.agent_id} · ${STATUS_KO[st] || st}`}
        className={cn(`lane-${stC} relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-lg border bg-panel-2 text-center transition-all`,
          st === 'active' && 'border-line-2', st === 'probation' && 'border-dashed border-l2/70', st === 'deprecated' && 'border-dashed border-warn/60 opacity-80 [background:repeating-linear-gradient(45deg,#242b33_0_6px,#2d2a22_6px_12px)]',
          fx.calling && 'beat border-l1 bg-[#13303a]', fx.done && !fx.calling && 'border-ok/60', fx.error && 'border-bad bg-[#3a1f20]', fx.healing && 'border-l2 bg-[#381f30] shadow-[0_0_22px_color-mix(in_oklab,var(--l2)_40%,transparent)]',
          fx.flash && 'border-l3 shadow-[0_0_28px_color-mix(in_oklab,var(--l3)_55%,transparent)]', fx.born && 'pop border-l2 shadow-[0_0_28px_color-mix(in_oklab,var(--l2)_50%,transparent)]')}>
        <div className="text-[14px] font-bold">{AGENT_KO[a.agent_id] || short(a.agent_id)}</div>
        <div className="font-mono text-[10.5px] text-ink-2">{short(a.agent_id)} {a.active_version}</div>
        <div className={cn('text-[10px]', st === 'active' ? 'text-ink-3' : st === 'probation' ? 'text-l2' : 'text-warn')}>{STATUS_KO[st] || st}{a.shadow_version ? ` · Shadow ${a.shadow_version}` : ''}{st === 'deprecated' && a.replacement ? ` → ${short(a.replacement)}` : ''}</div>
        {fx.scan && <i className="scanbar absolute inset-y-0 left-0 w-1.5 bg-l2/80" />}
      </button>
      {fx.born && <span className="pop absolute -right-2 -top-2 rounded-full bg-l2 px-1.5 text-[10px] font-extrabold text-[#2a0a1f]">NEW</span>}
      {fx.seq != null && fx.done && <span className="absolute -left-2 -top-2 flex size-[18px] items-center justify-center rounded-full bg-l1 text-[10px] font-extrabold text-[#06221f]">{fx.seq}</span>}
      <Chip chip={fx.chip} w={152} />
    </div>
  );
});

export const SkillNode = memo(function SkillNode({ id, data }: NodeProps<Node<AgentData>>) {
  const fx = useFx(id, 'skill');
  const a = data.agent;
  const open = useApp((s) => s.openDrawer);
  return (
    <div className="relative" style={{ width: 122, height: 40 }}>
      <Handles />
      <button type="button" onClick={() => open('agent', a.agent_id)} className={cn('flex h-full w-full flex-col items-center justify-center rounded-md border border-dashed border-line-2 bg-panel text-center', fx.flash && 'border-l3 shadow-[0_0_20px_color-mix(in_oklab,var(--l3)_50%,transparent)]', fx.born && 'pop border-l3')}>
        <div className="text-[11.5px] font-semibold text-ink-2">{AGENT_KO[a.agent_id] || short(a.agent_id)}</div>
        <div className="font-mono text-[10px] text-ink-3">{a.active_version}</div>
      </button>
      <Chip chip={fx.chip} w={122} />
    </div>
  );
});

export const PortNode = memo(function PortNode({ data }: NodeProps<Node<PortData>>) {
  const [hot, setHot] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const fire = (dur = 1600) => { setHot(true); if (t.current) clearTimeout(t.current); t.current = setTimeout(() => setHot(false), dur); };
    const k = data.id;
    const offs = [
      hub.on('agent_start', () => { if (k === 'sandbox') fire(900); }),
      hub.on('code', () => { if (k === 'sandbox') fire(); }),
      hub.on('jev', () => { if (k === 'jev') fire(); }),
      hub.on('tests', () => { if (k === 'harness') fire(800); }),
      hub.on('candidate', () => { if (k === 'harness') fire(1500); }),
      hub.on('node', (ev: AnyEv) => {
        if (ev.node === 'retrieve_memory' && k === 'memory') fire();
        if (ev.node === 'log_experience' && k === 'memory') fire();
        if (ev.loop === 'L2' && ev.sub !== 'grow' && k === 'healer') fire(2500);
        if (ev.loop === 'L2' && ev.sub === 'grow' && k === 'factory') fire(3000);
        if (ev.loop === 'L3' && k === 'evolver') fire(3000);
        if (['run_regression', 'run_tests', 'evaluate_harness', 'verify_replacement'].includes(ev.node) && k === 'harness') fire(2000);
      }),
    ];
    return () => { offs.forEach((o) => o()); if (t.current) clearTimeout(t.current); };
  }, [data.id]);
  return (
    <div className={cn(`lane-${data.c} flex h-[42px] w-[136px] flex-col items-center justify-center rounded-md border border-line bg-panel text-center transition-all`, hot && 'beat border-[var(--c)] bg-[color-mix(in_oklab,var(--c)_14%,var(--panel))]')}>
      <Handles />
      <div className={cn('text-[11.5px] font-bold text-ink-2', hot && 'text-ink')}>{data.label}</div>
      <div className="text-[9.5px] text-ink-3">{data.sub}</div>
    </div>
  );
});
