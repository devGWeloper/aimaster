// 라이브 — 기본 화면. 왼쪽: 지금 Agent가 하는 일(업무 상황·자막·루프 위치·행동 일지) / 가운데: AutoQual 업무 흐름 + 편성 맵 + 포커스(코드·확률·판정·승인) / 오른쪽: 대화
import NowPanel from '@/components/live/NowPanel';
import FocusCard from '@/components/live/FocusCard';
import Chat from '@/components/live/Chat';
import BizStrip from '@/components/live/BizStrip';
import OrchestrationMap from '@/components/map/OrchestrationMap';

export default function LivePage() {
  return (
    <div className="grid h-full grid-cols-[380px_minmax(0,1fr)_320px]">
      <NowPanel />
      <div className="flex min-h-0 min-w-0 flex-col border-x border-line">
        <BizStrip />
        <div className="flex items-baseline gap-3 px-4 pt-2.5">
          <h2 className="flex-none text-[14px] font-bold">Agent 편성</h2>
          <span className="truncate text-[12px] text-ink-3">Super Agent가 어떤 Agent를 불러 무엇을 가져오는지. 노드 = Agent가 대신 답하는 질문과 데이터 출처 · 클릭하면 상세</span>
        </div>
        <div className="min-h-0 flex-1"><OrchestrationMap live /></div>
        <FocusCard />
      </div>
      <Chat />
    </div>
  );
}
