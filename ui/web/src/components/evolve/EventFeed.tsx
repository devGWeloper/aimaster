// 진화 사건 피드 — 진행 중 런(4단계 진행) + 완료 리포트 카드(감지 → 후보 → 평가 → 반영). 펼치면 리포트 전문.
import { useState } from 'react';
import { useApp } from '@/store/store';
import { STEPS, type LiveCard } from '@/store/evolve';
import type { Report } from '@/lib/types';
import { AGENT_KO, short } from '@/lib/ko';
import { cn } from '@/lib/utils';
import ReportDetail from './ReportDetail';

const KIND: Record<string, [string, string, string]> = {
  grow: ['GROW', 'l2', 'Agent 생성'], heal: ['HEAL', 'l2', 'Self-Healing'], quarter: ['EVOLVE', 'l3', '분기 진화 (리플레이)'], judgment: ['EVOLVE', 'l3', '판단 진화 (운영 결과 학습)'],
  structure: ['EVOLVE', 'l3', '구조 진화 (중복·성능)'], orchestration: ['EVOLVE', 'l3', '편성 전략 진화'], merge: ['EVOLVE', 'l3', '병합 재도전 (아카이브 출발)'],
  rollback: ['ROLLBACK', 'bad', '자동 롤백'], retire: ['RETIRE', 'warn', 'Agent 폐기 검토'], replay: ['REPLAY', 'l3', '리플레이 최종 평가'],
};
export function kindOf(r: Report) { if (r.kind === 'evolve') return (r.content || {}).kind || 'quarter'; return r.kind; }
export function result(k: string, c: any): { text: string; cls: string } {
  if (k === 'heal') return c.status === 'healed' ? { text: `${c.from_version} → ${c.to_version} · MTTR ${c.mttr}`, cls: 'ok' } : c.status === 'external' ? { text: '외부 장애 — 패치 없음', cls: 'warn' } : { text: '중단 → 운영자', cls: 'bad' };
  if (k === 'grow') return c.ok ? { text: `${short(c.agent_id)} ${c.version} probation`, cls: 'ok' } : { text: '생성 중단', cls: 'bad' };
  if (k === 'rollback') return { text: `롤백 ${(c.cascade || []).length}건`, cls: 'bad' };
  if (k === 'retire') return { text: `유예 ${(c.items || []).filter((x: any) => x.decision === 'deprecated').length} · 보류 ${(c.items || []).filter((x: any) => x.decision === 'hold').length}`, cls: 'warn' };
  if (k === 'replay') { const f = c.final || {}; return { text: f.before ? `판정 일치 ${f.before.accuracy?.toFixed(0)}% → ${f.after.accuracy?.toFixed(0)}%` : '평가', cls: 'ok' }; }
  if (k === 'structure') return (c.changes || []).length ? { text: `승격 ${c.changes.length}건 · 중복 ${c.dup_before}% → ${c.dup_after}%`, cls: 'ok' } : { text: c.status || '보류', cls: 'warn' };
  if (k === 'orchestration') return c.change ? { text: `super_agent ${c.change.from} → ${c.change.to}`, cls: 'ok' } : { text: '변경 없음', cls: 'warn' };
  if (k === 'merge') return c.ok ? { text: '병합 채택', cls: 'ok' } : { text: '기각', cls: 'warn' };
  if (k === 'judgment') return c.status === 'adopted' ? { text: `채택 (승인 ${c.approver || ''})`, cls: 'ok' } : { text: c.status || '승인 대기', cls: 'warn' };
  const ad = (c.adopted || []).length, n = (c.candidates || []).length;
  return ad ? { text: `채택 ${ad} / 후보 ${n}`, cls: 'ok' } : { text: `기각 ${n} / 후보 ${n}`, cls: 'warn' };
}
export function title(k: string, c: any, r: Report) {
  if (k === 'heal') return `${AGENT_KO[c.agent_id] || c.agent_id} — ${c.classification?.type || '오류'}: ${(c.cause || c.signature || '').slice(0, 80)}`;
  if (k === 'grow') return `${AGENT_KO[c.agent_id] || c.agent_id || '새 Agent'} — 처리 불가 능력 ${(c.need || []).join(', ')}`;
  if (k === 'quarter') { const ad = (c.candidates || []).filter((x: any) => x.decision === 'adopt'); return `${c.quarter} — ${ad.length ? ad.map((x: any) => x.title).join(' / ').slice(0, 100) : '채택 없음 (기각안은 아카이브에 보관)'}`; }
  if (k === 'judgment') return `${c.group} — 1차 Fail 편향 감지 → Focus Ring 보정 (${(c.detect || [])[0] || ''})`.slice(0, 120);
  if (k === 'structure') return (c.detect || [])[0] || 'FDC 파싱 중복 → fdc_toolkit 추출';
  if (k === 'orchestration') return (c.detect || [])[0] || '편성 이력 분석';
  if (k === 'merge') return c.line || '아카이브 병합안 재도전';
  if (k === 'rollback') return c.cause || '승격 후 Shadow 불일치';
  if (k === 'retire') return (c.scan || []).map((x: any) => `${short(x.agent_id)} ${x.days_unused}일 미사용`).join(' · ') || '폐기 후보';
  return r.title;
}
const RES_C: Record<string, string> = { ok: 'text-ok', bad: 'text-bad', warn: 'text-warn' };

export default function EventFeed({ reports }: { reports: Report[] }) {
  const live = useApp((s) => s.evolve.live);
  const order = useApp((s) => s.evolve.order);
  const running = order.map((k) => live[k]).filter((c) => c && !c.done && !reports.some((r) => r.report_id === c.id));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 pb-4">
      {running.map((c) => <LiveRow key={c.id} c={c} />)}
      {reports.length === 0 && running.length === 0 && <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-ink-3">Autopilot을 시작하면 리플레이 분기 진화(SC-006)부터 Agent가 스스로 바뀐 기록이 여기 쌓입니다.</div>}
      {reports.map((r) => {
        const k = kindOf(r), c = r.content || {};
        const [badge, cls, name] = KIND[k] || ['EVOLVE', 'l3', k];
        const stepsKey = ['heal', 'grow', 'rollback', 'retire', 'replay'].includes(k) ? k : 'evolve';
        const res = result(k, c);
        const isOpen = open === r.report_id;
        return (
          <article key={r.report_id} className={cn(`lane-${cls} rounded-xl border bg-panel`, isOpen ? 'border-[var(--c)]' : 'border-line')}>
            <button type="button" onClick={() => setOpen(isOpen ? null : r.report_id)} className="flex w-full flex-col gap-1.5 px-4 py-3 text-left">
              <div className="flex w-full items-center gap-2">
                <span className="inline-flex h-[20px] items-center rounded-full bg-[color-mix(in_oklab,var(--c)_22%,transparent)] px-2 text-[10.5px] font-extrabold text-[var(--c)]">{badge}</span>
                <span className="font-mono text-[11px] text-ink-3">{r.report_id}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title(k, c, r)}</span>
                <span className={cn('flex-none text-[12px] font-semibold', RES_C[res.cls])}>{res.text}</span>
                <span className="flex-none font-mono text-[11px] text-ink-3">{String(r.ts).slice(0, 16)}</span>
                <span className="text-[10px] text-ink-3">{isOpen ? '▾' : '▸'}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11.5px] text-ink-3">{name}</span>
                <div className="flex items-center gap-1">
                  {STEPS[stepsKey].map((s, i) => <span key={s} className={cn('inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[10.5px]', i === 3 && res.cls === 'bad' ? 'border-bad/60 text-[#ffd6d4]' : 'border-ok/40 text-ink-2')}><i className={cn('size-1.5 rounded-full', i === 3 && res.cls === 'bad' ? 'bg-bad' : 'bg-ok')} />{s}</span>)}
                </div>
              </div>
            </button>
            {isOpen && <div className="border-t border-line px-4 py-4"><ReportDetail r={r} /></div>}
          </article>
        );
      })}
    </div>
  );
}

function LiveRow({ c }: { c: LiveCard }) {
  const [badge, cls, name] = c.kind === 'heal' ? KIND.heal : c.kind === 'grow' ? KIND.grow : ['EVOLVE', 'l3', 'L3 Evolve 진행 중'];
  const steps = STEPS[c.kind] || STEPS.evolve;
  return (
    <article className={cn(`lane-${cls} flash-in rounded-xl border border-[var(--c)] bg-panel px-4 py-3 shadow-[0_0_0_3px_color-mix(in_oklab,var(--c)_14%,transparent)]`)}>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-[20px] items-center rounded-full bg-[var(--c)] px-2 text-[10.5px] font-extrabold text-[#06221f]">{badge}</span>
        <span className="font-mono text-[11px] text-ink-3">{c.id}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.title}</span>
        <span className="flex-none text-[12px] font-semibold text-l1 glow">진행 중</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <span className="text-[11.5px] text-ink-3">{name}</span>
        <div className="flex items-center gap-1">
          {steps.map((s, i) => <span key={s} className={cn('inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[10.5px]', i < c.stepIdx ? 'border-ok/40 text-ink-2' : i === c.stepIdx ? (c.stepState === 'bad' ? 'border-bad text-[#ffd6d4]' : 'border-[var(--c)] text-ink') : 'border-line text-ink-3')}><i className={cn('size-1.5 rounded-full', i < c.stepIdx ? 'bg-ok' : i === c.stepIdx ? (c.stepState === 'bad' ? 'bg-bad' : 'bg-[var(--c)] glow') : 'bg-line-2')} />{s}</span>)}
        </div>
      </div>
      <div className="mt-1.5 text-[12px] text-ink-2">{c.note}</div>
    </article>
  );
}
