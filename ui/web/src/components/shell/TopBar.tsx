// 상단 제어바 — 브랜드 · 가상 시각 · 모드 칩 · Autopilot 제어(재생/일시정지/정지/속도/승인 모드)
import { Pause, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useApp } from '@/store/store';
import { vdate } from '@/lib/format';
import { cn } from '@/lib/utils';

const SPEEDS = [[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×'], [0, '최대']] as const;

export default function TopBar() {
  const snap = useApp((s) => s.snap);
  const clock = useApp((s) => s.clock);
  const connected = useApp((s) => s.connected);
  const control = useApp((s) => s.control);
  const replayClock = useApp((s) => s.live.replayClock);
  const { d, t } = vdate(clock || snap?.clock);
  const running = !!snap?.story?.running;
  const nDone = (snap?.story?.done || []).length, nAll = (snap?.story?.chapters || []).length;
  const playLabel = running ? 'Autopilot 실행 중' : nDone >= nAll && nAll ? 'Autopilot 처음부터' : nDone ? 'Autopilot 이어서' : 'Autopilot 시작';
  const replay = snap?.replay?.state === 'running';
  const llm = snap?.llm || { mode: 'offline' };

  return (
    <header className="col-span-2 flex items-center gap-5 border-b border-line bg-panel px-4">
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 40 40" className="size-8" aria-hidden="true">
          <circle cx="20" cy="20" r="16" fill="#1f2a34" stroke="var(--l1)" strokeWidth="2" />
          <path d="M15 35.6h10" stroke="var(--panel)" strokeWidth="3.2" />
          <g fill="#3a4a59"><rect x="12" y="12" width="7" height="7" /><rect x="21" y="12" width="7" height="7" /><rect x="12" y="21" width="7" height="7" /><rect x="21" y="21" width="7" height="7" fill="var(--gate)" /></g>
        </svg>
        <div className="leading-tight">
          <div className="text-[15px] font-extrabold tracking-tight">AutoQual</div>
          <div className="text-[11px] text-ink-3">Self-Evolving Agent</div>
        </div>
      </div>
      <div className="flex items-baseline gap-2 border-l border-line pl-5">
        <span className="text-[12px] text-ink-2">{d}</span>
        <span className="font-mono text-[22px] font-semibold tracking-tight">{t}</span>
        <span className="text-[11px] text-ink-3">가상 시각</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <Chip on={!replay} c="ok">운영 모드</Chip>
        {replay && <Chip on c="l3">리플레이 · Time-Travel Guard ON{replayClock ? ` · ${replayClock.slice(0, 10)}` : ''}</Chip>}
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <Chip on={llm.mode !== 'offline'} c="l1">{llm.mode === 'offline' ? 'LLM 오프라인 Playbook' : `LLM 사내 API (${llm.mode})`}</Chip>
          </TooltipTrigger>
          <TooltipContent>{llm.mode === 'offline' ? '사내 LLM 미연결. 결정적 재현용 Playbook 코드로 동작 (config/llm.json으로 연결)' : llm.base_url}</TooltipContent>
        </Tooltip>
        {(snap?.faults || []).map((f) => <Chip key={f.fault_id} on c="bad">장애 주입 {f.type}</Chip>)}
        {!connected && <Chip on c="warn">서버 연결 재시도 중</Chip>}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <Button size="lg" className="font-semibold" disabled={running} onClick={() => control('/api/story/start', {})}>
          <Play className="size-4 fill-current" /> {playLabel}
        </Button>
        <Button size="icon-lg" variant="outline" className={cn(snap?.paused && 'border-gate text-gate')} onClick={() => control(snap?.paused ? '/api/resume' : '/api/pause', {})} aria-label="일시정지 / 재개">
          <Pause className="size-4 fill-current" />
        </Button>
        <Button size="icon-lg" variant="outline" onClick={() => control('/api/story/stop', {})} aria-label="정지"><Square className="size-3.5 fill-current" /></Button>
        <div className="ml-1 inline-flex overflow-hidden rounded-lg border border-line-2">
          {SPEEDS.map(([v, label]) => (
            <button key={v} type="button" onClick={() => control('/api/speed', { speed: v })}
              className={cn('h-8 px-2.5 text-[12px] text-ink-2 hover:text-ink', Number(snap?.speed ?? 1) === v && 'bg-raise text-ink font-semibold')}>{label}</button>
          ))}
        </div>
        <label className="ml-2 flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
          <Switch checked={snap?.approval_mode === 'auto'} onCheckedChange={(v) => control('/api/approval_mode', { mode: v ? 'auto' : 'manual' })} />
          {snap?.approval_mode === 'auto' ? '승인: 데모 자동' : '승인: 사람'}
        </label>
      </div>
    </header>
  );
}

function Chip({ on, c, children }: { on?: boolean; c: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-panel-2 px-2.5 text-[11.5px] text-ink-2', on && `lane-${c} border-[color-mix(in_oklab,var(--c)_50%,var(--line))] text-ink`)}>
      <i className={cn('size-1.5 rounded-full bg-ink-3', on && 'bg-[var(--c)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--c)_25%,transparent)]')} />{children}
    </span>
  );
}
