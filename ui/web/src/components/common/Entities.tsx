// 요청 해석 결과 — Super Agent가 요청문에서 뽑아낸 엔티티
import { PM_KO, RTYPE_KO } from '@/lib/ko';
import type { AnyEv } from '@/lib/types';

export default function Entities({ en, rtype, detail, big }: { en: AnyEv; rtype?: string; detail?: string; big?: boolean }) {
  const rows: [string, string][] = [['요청 유형', RTYPE_KO[rtype || ''] || rtype || '-'], ['장비', en.eqp_id || en.eqp_prefix || '-'], ['모델 / 군', `${en.eqp_model || '-'} / ${en.eqp_group || '-'}`],
    ['챔버', en.chamber_id || '-'], ['PM 종류', en.pm_type ? `${PM_KO[en.pm_type] || en.pm_type}` : '-'], ['PM 시각', en.pm_start ? `${en.pm_start} ~ ${en.pm_end}` : '-'],
    ['교체 부품', (en.parts || []).join(', ') || '-'], ['Lot', en.lot || '-']];
  const shown = rows.filter((x) => x[1] !== '-' || ['장비', '챔버'].includes(x[0]));
  return (
    <div className="space-y-2">
      {detail && <div className="text-[12px] text-ink-3">{detail}</div>}
      <dl className={`kv ${big ? 'text-[13px]' : ''}`}>{shown.map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd className="font-semibold">{v}</dd></div>)}</dl>
    </div>
  );
}
