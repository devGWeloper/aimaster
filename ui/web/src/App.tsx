import { useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApp } from '@/store/store';
import TopBar from '@/components/shell/TopBar';
import Rail from '@/components/shell/Rail';
import ChapterStrip from '@/components/shell/ChapterStrip';
import ApprovalGate from '@/components/shell/ApprovalGate';
import Toasts from '@/components/shell/Toasts';
import Drawer from '@/components/shell/Drawer';
import LivePage from '@/pages/Live';
import LoopPage from '@/pages/Loop';
import EvolvePage from '@/pages/Evolve';
import AgentsPage from '@/pages/Agents';
import ApprovalsPage from '@/pages/Approvals';
import FabPage from '@/pages/Fab';

export default function App() {
  const view = useApp((s) => s.view);
  const refresh = useApp((s) => s.refresh);
  const connect = useApp((s) => s.connect);
  useEffect(() => {
    let alive = true;
    refresh().then(() => { if (alive) connect(); });
    const t = setInterval(refresh, 15000);
    const onHash = () => { const v = location.hash.replace('#', ''); if (v) useApp.setState({ view: v as never }); };
    addEventListener('hashchange', onHash);
    return () => { alive = false; clearInterval(t); removeEventListener('hashchange', onHash); };
  }, [refresh, connect]);

  return (
    <TooltipProvider delay={200}>
      <div className="grid h-full grid-cols-[64px_minmax(0,1fr)] grid-rows-[56px_52px_minmax(0,1fr)]">
        <TopBar />
        <ChapterStrip />
        <Rail />
        <main className="relative min-h-0 min-w-0">
          {view === 'live' && <LivePage />}
          {view === 'loop' && <LoopPage />}
          {view === 'evolve' && <EvolvePage />}
          {view === 'agents' && <AgentsPage />}
          {view === 'approvals' && <ApprovalsPage />}
          {view === 'fab' && <FabPage />}
        </main>
      </div>
      <ApprovalGate />
      <Drawer />
      <Toasts />
    </TooltipProvider>
  );
}
