// 포맷 헬퍼
export function vdate(vts?: string | null) {
  if (!vts) return { d: '', t: '' };
  const [d, t] = String(vts).split(' ');
  return { d, t: (t || '').slice(0, 5) };
}
export const hhmm = (vts?: string | null) => vdate(vts).t;
export const mmdd = (vts?: string | null) => { const d = vdate(vts).d; return d ? d.slice(5) : ''; };
export function fmtVal(v: unknown) {
  if (v == null) return '-';
  if (typeof v === 'number') {
    if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(2);
    return Math.abs(v) >= 1000 ? v.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : String(Math.round(v * 1000) / 1000);
  }
  return String(v);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fmtSpec(sp: any) {
  if (!sp) return '';
  const lo = sp.lower, up = sp.upper;
  if (lo != null && up != null) return `${fmtVal(lo)} ~ ${fmtVal(up)}`;
  if (up != null) return `≤ ${fmtVal(up)}`;
  if (lo != null) return `≥ ${fmtVal(lo)}`;
  return '-';
}
export const unitKo = (u: unknown) => String(u || '').replace('A/min', 'Å/min');
export function fmtNum(v: unknown, d = 1) {
  if (v == null || Number.isNaN(v)) return '-';
  return Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d });
}
export const esc = (t: unknown) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const KW = /\b(def|return|if|elif|else|for|in|import|from|as|not|and|or|None|True|False|while|try|except|raise|with|lambda|global|continue|break|pass|class|yield)\b/g;
export function highlight(code: string) {
  return esc(code)
    .replace(/(&quot;.*?&quot;|'[^'\n]*')/g, '<span class="tk-s">$1</span>')
    .replace(/(#[^\n]*)/g, '<span class="tk-c">$1</span>')
    .replace(KW, '<span class="tk-k">$1</span>')
    .replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tk-n">$1</span>');
}
export function diffClass(ln: string) {
  if (ln.startsWith('+') && !ln.startsWith('+++')) return 'add';
  if (ln.startsWith('-') && !ln.startsWith('---')) return 'del';
  if (ln.startsWith('@@')) return 'hunk';
  return '';
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: Parameters<T>) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const pct = (v: unknown, d = 0) => (v == null ? '-' : `${Number(v).toFixed(d)}%`);
export const signed = (v: unknown, unit = '') => (v == null ? '-' : `${Number(v) > 0 ? '+' : ''}${v}${unit}`);
