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
// 파이썬 구문 강조 — 원본 코드를 한 번만 훑는다. (치환을 여러 번 겹치면 앞에서 넣은 <span class="…"> 의 'class'·따옴표를
//   다음 패스가 다시 잡아 HTML이 깨지고, 문자열·주석 안의 키워드·숫자까지 칠해진다)
const TOK = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(#[^\n]*)|\b(def|return|if|elif|else|for|in|import|from|as|not|and|or|is|None|True|False|while|try|except|finally|raise|with|lambda|global|continue|break|pass|class|yield)\b|\b(\d+(?:\.\d+)?)\b/g;
const TK_CLS = ['', 'tk-s', 'tk-c', 'tk-k', 'tk-n'];
export function highlight(code: string) {
  let out = '', last = 0;
  for (const m of code.matchAll(TOK)) {
    const i = m.index ?? 0;
    const g = m.findIndex((x, k) => k > 0 && x != null);
    out += esc(code.slice(last, i)) + `<span class="${TK_CLS[g]}">${esc(m[0])}</span>`;
    last = i + m[0].length;
  }
  return out + esc(code.slice(last));
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
