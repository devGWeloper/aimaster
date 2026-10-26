// 대화 — 엔지니어 요청 · Super Agent 응답 전문 · Mock Fab 진행 메모 · 리플레이 재생 카드
import { useEffect, useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { useApp } from '@/store/store';
import { hhmm } from '@/lib/format';
import { PM_KO } from '@/lib/ko';
import { cn } from '@/lib/utils';
import Blocks from '@/components/common/Blocks';
import type { ChatMsg } from '@/store/chat';

const PRESETS = [
  'ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘',
  'CVD-05 A챔버 Showerhead 교체 PM 끝났어. AutoQual 진행해줘',
  'Particle 15ea, ER 187.2 nm/min, Unif 2.4%',
  '지난 분기 ETCH 장비에서 Qual Fail 났던 건들, 교체 부품 사용시간이랑 관계 있는지 분석해줘',
  'CVD-05 A챔버 PM 사이클 간 drift 추이 보여줘',
  'ETCH-07 B챔버 Wet Clean 최근 이력 보여줘',
];
const NOTE_C: Record<string, string> = { fab: 'text-ink-3', warn: 'text-warn', l2: 'text-l2', ok: 'text-ok' };

export default function Chat() {
  const msgs = useApp((s) => s.chat.msgs);
  const send = useApp((s) => s.send);
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => { const el = logRef.current; if (el && follow) el.scrollTop = el.scrollHeight; }, [msgs, follow]);
  const submit = async () => { const t = text.trim(); if (!t) return; setText(''); await send(t); };
  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-2"><h2 className="text-[13.5px] font-bold">대화</h2><span className="text-[11.5px] text-ink-3">엔지니어 요청 · Super Agent 응답</span></div>
      <div ref={logRef} onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 40); }} className="min-h-0 flex-1 space-y-3 overflow-auto px-3 pb-3">
        {msgs.length === 0 && (
          <div className="mx-1 mt-4 rounded-lg border border-dashed border-line p-3 text-[12px] text-ink-3">
            <div className="mb-1 font-semibold text-ink-2">엔지니어처럼 요청하면 Super Agent가 처리합니다</div>
            가운데 편성 맵에서 어떤 Agent가 불리고 무엇을 가져오는지, 왼쪽에서 지금 하는 일과 루프 위치를 볼 수 있습니다.
          </div>
        )}
        {msgs.map((m) => <Msg key={m.id} m={m} />)}
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
          {PRESETS.map((p) => <button key={p} type="button" title={p} onClick={() => setText(p)} className="max-w-[200px] flex-none truncate rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[11px] text-ink-2 hover:border-l1/60 hover:text-ink">{p}</button>)}
        </div>
        <div className="flex gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} rows={2} placeholder="예) ETCH-07 B챔버 Wet Clean PM 끝났어. AutoQual 진행해줘"
            className="min-w-0 flex-1 resize-none rounded-lg border border-line-2 bg-bg px-3 py-2 text-[12.5px] outline-none focus:border-l1" />
          <button type="button" onClick={submit} className="flex w-11 items-center justify-center rounded-lg bg-l1 text-[#06221f] hover:bg-l1/85" aria-label="요청"><SendHorizontal className="size-4" /></button>
        </div>
      </div>
    </section>
  );
}

function Msg({ m }: { m: ChatMsg }) {
  if (m.kind === 'user') return (
    <div className="ml-8 rounded-[12px_12px_3px_12px] border border-line-2 bg-raise px-3 py-2">
      <div className="text-[10.5px] text-ink-3">{m.who} · {hhmm(m.vts)}</div>
      <div className="text-[12.5px]">{m.text}</div>
    </div>
  );
  if (m.kind === 'replay') {
    const ev = m.ev!, c = ev.compare || {}, rec = ev.recommendation || {};
    return (
      <div className="rounded-lg border border-l3/40 bg-panel-2 px-3 py-2 text-[11.5px]">
        <div className="text-[10.5px] text-l3">리플레이 · {ev.quarter} · QH {ev.qh_seq}</div>
        <div className="font-semibold">{ev.chamber_id} {PM_KO[ev.pm_type] || ev.pm_type} — 과거 건 재생</div>
        <div className="text-ink-2">추천 {rec.count ?? '-'}매 · 당시 {ev.actual?.n1}매 → 1차 {ev.actual?.q1 === 'P' ? 'PASS' : 'FAIL'} · 예측 {c.pred_ok ? '일치' : '불일치'} · 판정 {c.judge_ok ? '일치' : '불일치'}</div>
      </div>
    );
  }
  if (!m.blocks.length && !m.notes.length) return <div className="px-1 text-[11px] text-ink-3">Super Agent 처리 중 …</div>;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-ink-3"><span className="font-semibold text-l1">Super Agent</span>{m.rid} · {hhmm(m.vts)}{m.latency ? ` · 가상 응답 ${(m.latency / 1000).toFixed(1)}s` : ''}</div>
      {m.blocks.length > 0 && <Blocks blocks={m.blocks} compact />}
      {m.notes.map((n, i) => <div key={i} className={cn('px-1 text-[11.5px]', NOTE_C[n.cls] || 'text-ink-2')}>{n.text}</div>)}
    </div>
  );
}
