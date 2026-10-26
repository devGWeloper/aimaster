// 라이브 — 기본 화면. 왼쪽: 지금 Agent가 하는 일(자막·루프 위치·행동 일지) / 가운데: 편성 맵 + 포커스(코드·확률·판정·승인) / 오른쪽: 대화
import NowPanel from '@/components/live/NowPanel';
import FocusCard from '@/components/live/FocusCard';
import Chat from '@/components/live/Chat';
import OrchestrationMap from '@/components/map/OrchestrationMap';

export default function LivePage() {
  return (
    <div className="grid h-full grid-cols-[440px_minmax(0,1fr)_350px]">
      <NowPanel />
      <div className="flex min-h-0 min-w-0 flex-col border-x border-line">
        <div className="flex items-baseline gap-3 px-4 pt-3">
          <h2 className="text-[13.5px] font-bold">Agent 편성</h2>
          <span className="truncate text-[11.5px] text-ink-3">요청이 처리되는 동안 Super Agent가 누구를 부르고 무엇을 받아오는지. 새로 태어나고, 고쳐지고, 진화하고, 폐기되는 Agent까지</span>
        </div>
        <div className="min-h-0 flex-1"><OrchestrationMap live /></div>
        <FocusCard />
      </div>
      <Chat />
    </div>
  );
}
