// REST 호출 — FastAPI(ui/server.py). 실패 시 detail 메시지를 Error로 던진다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const opt: RequestInit = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return r.json();
}

// 운영자 신원 — 승인·반려에 남는 이름 (브라우저 로컬 저장)
export function operatorName(): string {
  try { return localStorage.getItem('aq.operator') || '운영자'; } catch { return '운영자'; }
}
export function setOperatorName(name: string) {
  try { localStorage.setItem('aq.operator', name.trim() || '운영자'); } catch { /* noop */ }
}
