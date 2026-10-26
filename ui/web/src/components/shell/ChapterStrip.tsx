// 챕터 타임라인 — 시나리오(SC-006 → SC-009) 진행 지점. 클릭하면 체크포인트로 이동/그 챕터부터 실행.
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useApp } from '@/store/store';
import { api } from '@/lib/api';
import type { Chapter } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function ChapterStrip() {
  const snap = useApp((s) => s.snap);
  const live = useApp((s) => s.live.chapter);
  const toast = useApp((s) => s.toast);
  const refresh = useApp((s) => s.refresh);
  const [pick, setPick] = useState<Chapter | null>(null);
  const st = snap?.story;
  if (!st) return <nav className="col-span-2 border-b border-line" />;
  const curId = st.running ? (st.current || live?.id) : null;
  const idx = pick ? st.chapters.findIndex((c) => c.id === pick.id) : -1;
  const prev = idx > 0 ? st.chapters[idx - 1] : null;
  const canJump = idx === 0 || !!prev?.checkpoint;

  const jump = async (start: boolean) => {
    if (!pick) return;
    setPick(null);
    try { await api('/api/story/jump', { id: pick.id }); if (start) await api('/api/story/start', { from: pick.id }); else toast(`${pick.title} 직전 상태로 이동했습니다.`); }
    catch (e) { toast((e as Error).message, 'error'); }
    refresh();
  };

  return (
    <nav className="col-span-2 overflow-x-auto border-b border-line bg-bg" aria-label="시나리오 타임라인">
      <div className="flex h-full min-w-max items-stretch px-3">
        {st.chapters.map((c, i) => {
          const cur = curId === c.id;
          return (
            <button key={c.id} type="button" title={`${c.title}\n${c.desc}${c.checkpoint ? '\n(체크포인트 있음. 클릭해 이 지점으로 이동)' : ''}`}
              onClick={() => { if (st.running) { toast('Autopilot 실행 중입니다. 정지 후 이동하세요.', 'warn'); return; } setPick(c); }}
              className={cn('relative flex min-w-[128px] flex-col justify-center border-r border-line px-4 pl-6 text-left text-ink-3 hover:text-ink', cur && 'bg-[linear-gradient(180deg,transparent,color-mix(in_oklab,var(--l1)_12%,transparent))]')}>
              <i className={cn('absolute left-2.5 top-1/2 size-[7px] -translate-y-1/2 rounded-full bg-line-2', c.done && 'bg-ok', cur && 'lane-l1 bg-l1 beat')} />
              <span className="text-[10.5px] leading-none">{c.date}</span>
              <span className={cn('mt-1 whitespace-nowrap text-[12px] font-semibold text-ink-2', (c.done || cur) && 'text-ink')}>{i === 0 ? c.title : c.title.replace(/^SC-\d+\s*/, (m) => m)}</span>
              {cur && <i className="absolute inset-x-0 bottom-0 h-[2px] bg-l1" />}
            </button>
          );
        })}
      </div>
      <Dialog open={!!pick} onOpenChange={(o) => { if (!o) setPick(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pick?.date} · {pick?.title}</DialogTitle>
            <DialogDescription>{pick?.desc}{prev && !prev.checkpoint ? ' 이전 챕터 체크포인트가 없어 처음부터 실행해야 합니다.' : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPick(null)}>닫기</Button>
            <Button variant="outline" disabled={!canJump} onClick={() => jump(false)}>이 지점으로 이동</Button>
            <Button disabled={!canJump} onClick={() => jump(true)}>이 챕터부터 실행</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
