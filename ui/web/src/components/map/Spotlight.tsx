// Agent 변경 스포트라이트 — 기능 추가(Grow)·코드 수정(Heal)·기준 보정(Evolve)·정식 전환·되돌림·정리 예정·정리 순간을 편성 맵 위에 크게 띄운다.
//   여러 사건이 몰리면 줄을 세워 하나씩 보여주고(클릭하면 다음), 지나간 사건은 오른쪽 아래 "생애 기록"에 남긴다.
import { useEffect, useRef, useState } from 'react';
import { hub } from '@/lib/hub';
import { agentKo } from '@/lib/ko';
import { ms } from '@/store/store';
import type { AnyEv } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Life { id: number; kind: string; agent: string; from?: string | null; to?: string | null; note?: string; ref?: string; diff?: string }
const META: Record<string, { label: string; c: string; how: string }> = {
  grow: { label: '신규 분석 기능 추가', c: 'l2', how: '처음 보는 요청 → Agent Factory가 명세·코드·테스트를 직접 작성 → 엣지 테스트 통과 → 시험 운영(probation) 투입' },
  restore: { label: '보관함에서 복원', c: 'l2', how: '새로 만들기 전에 진화 아카이브의 기존 Genome을 복원해 현재 스키마로 재검증' },
  heal: { label: '로그 변경 대응 — 코드 수정', c: 'l2', how: '실행 오류 감지 → Healer가 원인 진단 → 소스 코드 패치 → 회귀 테스트 전부 통과 → 새 버전으로 교체' },
  evolve: { label: '추천 기준 보정 반영', c: 'l3', how: '변이 후보 생성 → 루프 밖 하네스 채점(Held-out 비하락) → 사람 승인 → 반영' },
  compose: { label: '기능 통합', c: 'l3', how: '기능이 겹치는 Agent를 합쳐 구조를 단순화 (MAJOR 버전)' },
  promote: { label: '정식 운영 전환', c: 'ok', how: '시험 운영 기간 동안 성공 누적 + 운영자 승인 → active' },
  rollback: { label: '자동 되돌림', c: 'bad', how: '승격 후 Shadow 결과 불일치 → 관련 Agent를 이전 안정 버전으로 한꺼번에 되돌림' },
  deprecate: { label: '정리 예정 (유예)', c: 'warn', how: '장기 미사용·대체됨 → 호출은 대체 Agent로 리다이렉트, 유예 기간 후 사람 승인 시 폐기' },
  retire: { label: '기능 정리 — 보관함 이동', c: 'bad', how: '편성·Heal·회귀 대상에서 제거. Genome·테스트·Lineage는 아카이브에 보관 (언제든 복원 가능)' },
};

export default function Spotlight() {
  const [queue, setQueue] = useState<Life[]>([]);
  const [log, setLog] = useState<Life[]>([]);
  const seq = useRef(0);
  const seen = useRef<Map<string, number>>(new Map());
  const cur = queue[0];

  useEffect(() => {
    const push = (l: Omit<Life, 'id'>) => {
      if (!META[l.kind]) return;
      const key = `${l.kind}:${l.agent}:${l.to || ''}`;
      const now = Date.now();
      if ((seen.current.get(key) || 0) > now - 5000) return;   // version·registry 이벤트 중복 제거
      seen.current.set(key, now);
      const item = { ...l, id: ++seq.current };
      setQueue((q) => [...q, item].slice(-6));
      setLog((g) => [item, ...g].slice(0, 3));
    };
    const offs = [
      hub.on('version', (ev: AnyEv) => push({ kind: ev.kind, agent: ev.agent_id, from: ev.from_version, to: ev.to_version, note: ev.note, ref: ev.ref,
        diff: ev.diff_add || ev.diff_del ? `+${ev.diff_add || 0} / −${ev.diff_del || 0} lines` : undefined })),
      hub.on('registry', (ev: AnyEv) => { if (['deprecate', 'retire', 'promote'].includes(ev.event)) push({ kind: ev.event, agent: ev.agent_id, note: ev.note }); }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), ms(3600) || 2500);
    return () => clearTimeout(t);
  }, [cur]);

  return (
    <>
      {log.length > 0 && (
        <div className="pointer-events-none absolute bottom-1.5 right-3 z-10 w-[240px] space-y-0.5 text-right">
          <div className="text-[10.5px] font-semibold text-ink-3">Agent 변경 기록</div>
          {log.map((l) => { const m = META[l.kind]; return (
            <div key={l.id} className={cn('truncate text-[11px]', `lane-${m.c}`)}><b className="text-[var(--c)]">{m.label.split(' — ')[0]}</b> <span className="text-ink-2">{agentKo(l.agent)}{l.to ? ` ${l.to}` : ''}</span></div>
          ); })}
        </div>
      )}
      {cur && (() => { const m = META[cur.kind]; return (
        <button key={cur.id} type="button" onClick={() => setQueue((q) => q.slice(1))} title="클릭하면 다음"
          className={cn('pop absolute bottom-10 left-1/2 z-20 w-[min(520px,80%)] -translate-x-1/2 rounded-xl border-2 bg-[#121a22]/95 px-5 py-3.5 text-left shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur', `lane-${m.c} border-[var(--c)]`)}>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--c)] px-2.5 py-0.5 text-[11.5px] font-extrabold text-[#0b1016]">{m.label}</span>
            {cur.ref && <span className="font-mono text-[11px] text-ink-3">{cur.ref}</span>}
            {queue.length > 1 && <span className="ml-auto text-[11px] text-ink-3">+{queue.length - 1}건 대기 · 클릭하면 다음</span>}
          </div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <b className="text-[20px] font-extrabold tracking-tight">{agentKo(cur.agent)}{cur.agent.endsWith('_agent') ? ' Agent' : ''}</b>
            {(cur.from || cur.to) && <span className="font-mono text-[16px] font-bold text-[var(--c)]">{cur.from || '—'} → {cur.to || '—'}</span>}
            {cur.diff && <span className="font-mono text-[11px] text-ink-3">{cur.diff}</span>}
          </div>
          {cur.note && <div className="mt-1 line-clamp-2 text-[12.5px] text-ink">{cur.note}</div>}
          <div className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{m.how}</div>
        </button>
      ); })()}
    </>
  );
}
