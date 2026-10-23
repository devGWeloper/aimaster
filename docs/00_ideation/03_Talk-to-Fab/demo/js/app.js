'use strict';
// ---------------------------------------------------------------- tool card
const tc = $('#toolcard');
function showToolCard(t) {
  if (t.level !== 'L3') {
    tc.innerHTML = `<div class="tc-h"><div class="tc-id">${t.id}<span class="badge-st RUN">${t.level}</span></div><div class="tc-sub">${t.kind}${t.owner ? ' · ' + t.owner + ' 전용' : ''}</div><button class="x">${ic('x')}</button></div>
      <div class="tc-b"><div class="tc-grid"><div><span>부하</span><b>${t.util.toFixed(0)}%</b></div><div><span>상태</span><b>정상</b></div><div><span>최근 알람</span><b>없음</b></div><div><span>다음 점검</span><b>${RI(3, 40)}일 후</b></div></div>
      <div class="tc-jev"><b>TWIN ▸</b> 유틸리티 상태는 공정 설비 판단(Jev)의 제약으로 실시간 반영됩니다.</div></div>`;
  } else if (t.stocker) {
    tc.innerHTML = `<div class="tc-h"><div class="tc-id">${t.id}</div><div class="tc-sub">Stocker · Interbay</div><button class="x">${ic('x')}</button></div>
      <div class="tc-b"><div class="tc-grid"><div><span>적재율</span><b>${t.fill}%</b></div><div><span>용량</span><b>240 FOUP</b></div><div><span>입고 대기</span><b>${RI(0, 5)}</b></div><div><span>출고 대기</span><b>${RI(0, 5)}</b></div></div></div>`;
  } else {
    const q = Array.from({ length: t.queue }, (_, i) => (t.hot && i === 0) ? `<span class="hot">${t.id === 'ETCH-03' ? 'L2417' : newLot()} HOT</span>` : `<span>${newLot()}</span>`).join('') || '<span>대기 없음</span>';
    const chN = t.kind === 'etch' || t.kind === 'pvd' || t.kind === 'ald' ? t.parts.filter(p => p.plasma).length : 2;
    const ch = ['A', 'B', 'C', 'D', 'E'].slice(0, chN).map(c => { const s = t.state === 'DOWN' && c === 'B' ? 'DOWN' : t.state === 'PM' ? 'PM' : rnd() < .85 ? 'RUN' : 'IDLE'; return `<div><i style="background:${STATE[s].color}"></i>CH-${c}</div>`; }).join('');
    const jevMsg = t.state === 'DOWN' ? `대기 ${t.queue}랏을 동일 레시피 자격 설비로 재분배 중` : t.queue ? `다음 투입: 대기열 1순위 · 셋업 변경 최소화 기준` : `상위 공정 도착 예정 랏 선점 대기`;
    tc.innerHTML = `<div class="tc-h"><div class="tc-id">${t.id}<span class="badge-st ${t.state}">${t.state}</span></div><div class="tc-sub">${t.model} · ${AREAS[t.area].name} · L3</div><button class="x">${ic('x')}</button></div>
      <div class="tc-b">
        <div class="tc-grid">
          <div><span>가동률 (1h)</span><b>${t.util.toFixed(1)}%</b></div>
          <div><span>진행 랏</span><b>${t.lot || '—'}</b></div>
          <div><span>레시피</span><b>${t.recipe}</b></div>
          <div><span>다음 PM</span><b>${t.state === 'PM' ? '진행 중' : t.pmDue + 'h 후'}</b></div>
        </div>
        <div><div class="tc-label"><span>챔버</span><span class="mono">${chN} / ${chN}</span></div><div class="tc-ch">${ch}</div></div>
        <div><div class="tc-label"><span>대기열</span><span class="mono">${t.queue} lots</span></div><div class="tc-q">${q}</div></div>
        <div class="tc-jev"><b>JEV ▸</b> ${jevMsg}</div>
        <div class="tc-act"><button class="btn violet" data-a="ask">${ic('sparkle')}Copilot에 질문</button><button class="btn" data-a="sim">${ic('flask')}다운 What-if</button></div>
      </div>`;
    $('[data-a=ask]', tc).onclick = () => { input.value = `${t.id} 현재 상태랑 대기열 리스크 알려줘`; input.focus(); };
    $('[data-a=sim]', tc).onclick = () => send(`${t.id} 지금 다운되면 영향은?`);
  }
  $('.x', tc).onclick = hideToolCard;
  tc.classList.add('on');
}
function hideToolCard() { tc.classList.remove('on'); selected = null; }

// ---------------------------------------------------------------- left panel: areas
function renderAreas() {
  $('#areas').innerHTML = Object.entries(AREAS).map(([id, A]) => {
    const ts = tools.filter(t => t.area === id);
    const cnt = s => ts.filter(t => t.state === s).length;
    const util = ts.reduce((s, t) => s + t.util, 0) / ts.length;
    const wip = ts.reduce((s, t) => s + t.queue, 0) * 25;
    const down = cnt('DOWN');
    const bar = ['RUN', 'IDLE', 'PM', 'DOWN'].map(s => `<i style="width:${cnt(s) / ts.length * 100}%;background:${STATE[s].color}"></i>`).join('');
    return `<div class="area ${hoverArea === id ? 'on' : ''}" data-area="${id}">
      <div class="area-top"><i class="sw" style="background:${A.color}"></i><span class="an">${A.name}</span><span class="ae">${id}</span><span class="au">${util.toFixed(0)}%</span></div>
      <div class="area-bar">${bar}</div>
      <div class="area-meta"><span><b>${ts.length}</b> 설비</span><span>WIP <b>${fmt(wip)}</b></span>${down ? `<span class="bad">DOWN ${down}</span>` : ''}${ts.some(t => t.hot) ? `<span class="warn">HOT ${ts.filter(t => t.hot).length}</span>` : ''}</div>
    </div>`;
  }).join('');
  $$('.area').forEach(el => {
    el.onclick = () => { const a = el.dataset.area; setArea(hoverArea === a ? null : a); if (hoverArea) focusArea(a); else camT = fitCam(); };
  });
}
function setArea(a) { hoverArea = a; renderAreas(); }
renderAreas();

// nav rail
const RAIL = [['cube', '디지털트윈 FAB'], ['layers', '로트 추적'], ['cpu', '설비 상태'], ['truck', '반송 (AMHS)'], ['shield', '운영 정책'], ['flask', 'What-if 시나리오'], ['history', '감사 로그']];
$('#rail').innerHTML = RAIL.map(([i, t], k) => `<button class="${k ? '' : 'on'}" data-tip="${t}">${ic(i)}</button>`).join('') + `<div class="sp"></div><button data-tip="설정">${ic('gear')}</button>`;
$$('#rail button').forEach(b => b.onclick = () => { $$('#rail button').forEach(x => x.classList.remove('on')); b.classList.add('on'); });

// mode toggle
$$('#mode button').forEach(b => b.onclick = () => {
  $$('#mode button').forEach(x => x.classList.remove('on')); b.classList.add('on');
  sandbox = b.dataset.mode === 'sandbox'; mapEl.classList.toggle('sandbox', sandbox);
  if (!sandbox && typeof forecastSnap !== 'undefined' && forecastSnap) forecastRestore();
});

// ---------------------------------------------------------------- toasts / events
function toast(kind, icon, title, body, ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = `<div class="ti">${ic(icon)}</div><div><b>${title}</b><span>${body}</span></div>`;
  $('#toasts').prepend(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}
const simStart = new Date('2026-10-02T17:24:00');
const t0 = performance.now();
const simNow = () => new Date(simStart.getTime() + (performance.now() - t0));
const hms = (d = simNow()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const events = [];
function addEvent(sev, src, msg, ack = '미확인', isNew = true) {
  events.unshift({ t: hms(), sev, src, msg, ack });
  $('#evList').insertAdjacentHTML('afterbegin', `<div class="ev ${isNew ? 'new' : ''}"><span class="t">${events[0].t}</span><span class="sev ${sev}">${sev}</span><span class="src">${src}</span><span>${msg}</span><span class="ack">${ack}</span></div>`);
  $('#evCnt').textContent = events.length;
}
[
  ['INFO', 'POL-0139', 'PM_WINDOW 정책 적용 — PHOTO 베이 PM 02~06시 집중', '자동'],
  ['WARN', 'STK-05', '적재율 91% — 반송 우선순위 상향 (Jev)', '자동 처리'],
  ['WARN', 'L2288', 'Q-time 잔여 38분 · CLEAN→CMP 구간', 'Jev 모니터링'],
  ['CRIT', tools.find(t => t.state === 'DOWN').id, '챔버 압력 이상 · 비계획 다운 · MTTR 예상 3.4h', '엔지니어 배정'],
  ['AI', 'Jev→LLM', '정책 충돌(HOT 우선 vs Q-time) 에스컬레이션 → Q-time 우선 판정', '자동 해결'],
].forEach(e => addEvent(...e, false));

// ---------------------------------------------------------------- policies
const policies = [
  { id: 'POL-0139', type: 'PM_WINDOW', src: 'PHOTO 베이 PM은 새벽 2시~6시에 몰아서 해줘', status: 'ACTIVE', at: '15:21', impact: 'Moves +0.6%' },
  { id: 'POL-0131', type: 'TRANSPORT_PRIORITY', src: 'Q-time 4시간 이하 공정은 반송 우선 처리', status: 'ACTIVE', at: '09:02', impact: 'Q-time 위반 −42%' },
];
function renderPolicies(newId) {
  $('#polList').innerHTML = policies.map(p => `<div class="pcard ${p.id === newId ? 'new' : ''}">
    <div class="pc-h"><span class="ty2">${p.type}</span><span class="id">${p.id}</span><span class="st ${p.status}">${p.status}</span></div>
    <div class="src">“${esc(p.src)}”</div>
    <div class="foot"><span>적용 ${p.at}</span><span>${p.impact}</span><span>LLM→Typed→Jev</span></div></div>`).join('');
  $('#polCnt').textContent = policies.length;
}
renderPolicies();

$$('.tab').forEach(b => b.onclick = () => {
  $$('.tab').forEach(x => x.classList.remove('on')); b.classList.add('on');
  ['jev', 'events', 'policies'].forEach(k => $(`#tab-${k}`).hidden = k !== b.dataset.tab);
});
$('#maxbtn').onclick = () => { $('.center').classList.toggle('max'); };
const openTab = k => $(`.tab[data-tab=${k}]`).click();

// ---------------------------------------------------------------- KPIs
const KPIS = [
  { id: 'moves', label: 'Moves', unit: '/h', v: 4812, j: 28, spark: true },
  { id: 'wip', label: 'WIP', unit: 'wfr', v: 24382, j: 22, spark: true },
  { id: 'util', label: '설비 가동률', unit: '%', v: 87.4, j: .25, dec: 1, spark: true },
  { id: 'ct', label: '평균 CT', unit: 'days', v: 46.2, j: .03, dec: 1, spark: true },
  { id: 'hot', label: 'Hot Lot', unit: '', v: 12, cls: 'amber' },
  { id: 'hold', label: 'Hold', unit: '', v: 37 },
  { id: 'qt', label: 'Q-time 위험', unit: '', v: 6, cls: 'red' },
];
KPIS.forEach(k => { k.hist = Array.from({ length: 40 }, () => k.v + (rnd() - .5) * k.j * 6); k.base = k.v; });
$('#kpis').innerHTML = KPIS.map(k => `<div class="kpi ${k.cls || ''}" id="k-${k.id}"><div><div class="kl">${k.label}</div><div class="kv"><span>--</span><small>${k.unit}</small></div></div>${k.spark ? '<svg class="spark" viewBox="0 0 64 24"><path class="a" fill="rgba(62,224,255,.1)"/><path class="l" fill="none" stroke="#3ee0ff" stroke-width="1.4"/></svg>' : ''}</div>`).join('');
function renderKpis() {
  KPIS.forEach(k => {
    const el = $(`#k-${k.id}`);
    $('.kv span', el).textContent = k.dec ? k.v.toFixed(k.dec) : fmt(k.v);
    if (k.spark) {
      const mn = Math.min(...k.hist), mx = Math.max(...k.hist), rg = mx - mn || 1;
      const pts = k.hist.map((v, i) => [i / (k.hist.length - 1) * 64, 22 - (v - mn) / rg * 18]);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      $('.l', el).setAttribute('d', d); $('.a', el).setAttribute('d', d + 'L64,24L0,24Z');
    }
  });
}
function tickKpis() {
  KPIS.forEach(k => {
    if (k.spark) { k.v += (rnd() - .5) * k.j + (k.base - k.v) * .08; k.hist.push(k.v); k.hist.shift(); }
  });
  renderKpis();
}
renderKpis(); setInterval(tickKpis, 1200);
setInterval(() => { const d = simNow(); $('#clock').textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms(d)}`; $('#sync').textContent = RI(96, 142) + 'ms'; }, 500);

// ---------------------------------------------------------------- tool state drift
setInterval(() => {
  const t = pick(tools); if (['ETCH-03', 'ETCH-04', 'ETCH-05', 'CMP-02'].includes(t.id) || t.forced) return;
  if (t.state === 'IDLE' && rnd() < .7) { t.state = 'RUN'; t.lot = newLot(); t.util = R(70, 92); }
  else if (t.state === 'RUN' && rnd() < .5) { t.state = 'IDLE'; t.lot = null; }
  else if (t.state === 'DOWN' && rnd() < .3) { t.state = 'RUN'; t.lot = newLot(); addEvent('INFO', t.id, '복구 완료 · Jev 디스패칭 재개', '자동'); }
  t.queue = clamp(t.queue + RI(-1, 1), 0, 7);
  tools.forEach(x => { if (x.state === 'RUN') x.util = clamp(x.util + (rnd() - .5) * 1.2, 55, 99); });
}, 1500);
setInterval(renderAreas, 3000);

// ---------------------------------------------------------------- Jev stream
const jevList = $('#jevList');
let jevBoost = 0, policyLive = false, decTotal = 0;
const jev = { rate: 2841, esc: .7 };
const RECIPES = () => `${pick(['ET', 'PH', 'DE', 'CM', 'CL', 'IM'])}-M${RI(1, 9)}-${pad(RI(1, 140), 3)}`;
function jevRow() {
  const r = rnd();
  const t = pick(tools.filter(x => x.state === 'RUN' || x.state === 'IDLE'));
  let type, msg, conf = R(.86, .995), escR = false;
  if (policyLive && rnd() < .3) {
    const pm = pick([
      ['DISPATCH', `<b>ETCH-04</b> ← <b class="hot">L2417</b> HOT · 선점 투입<span class="pol">POL-0142</span>`],
      ['DISPATCH', `<b>ETCH-05</b> ← <b>${newLot()}</b> · ETCH-03 overflow 재분배<span class="pol">POL-0143</span>`],
      ['REROUTE', `<b>${newLot()}</b> · ETCH-03 → ETCH-04 (부하 ${R(78, 80).toFixed(1)}% 도달)<span class="pol">POL-0143</span>`],
      ['TRANSPORT', `<b>OHT-1${RI(10, 48)}</b> · <b class="hot">L2417</b> 우선 반송 · STK-03 → METRO-02<span class="pol">POL-0142</span>`],
    ]);
    [type, msg] = pm;
  } else if (r < .42) {
    type = 'DISPATCH'; msg = `<b>${t.id}</b> ← <b>${newLot()}</b> · P${RI(1, 4)} · ${RECIPES()} · 셋업 변경 없음`;
  } else if (r < .72) {
    type = 'TRANSPORT'; msg = `<b>OHT-1${pad(RI(1, 48))}</b> · ${pick(stockers).id} → <b>${t.id}</b> · ETA ${RI(18, 95)}s`;
  } else if (r < .84) {
    type = 'HOLD'; msg = `<b>${newLot()}</b> · Q-time 잔여 ${RI(12, 50)}분 · 하위 설비 부족 → 선행 홀드`;
  } else if (r < .94) {
    type = 'RELEASE'; msg = `<b>${newLot()}</b> · ${pick(['계측 결과 정상', 'Q-time 창 확보', 'SPC OOC 해제'])} → 릴리즈`;
  } else {
    type = 'REROUTE'; msg = `<b>${newLot()}</b> · ${t.id} 대기 과다 → ${pick(tools.filter(x => x.area === t.area)).id}`;
  }
  if (rnd() < .05 + jevBoost) { conf = R(.48, .68); escR = true; msg += ` · <span class="muted">${pick(['정책 충돌: HOT 우선 vs Q-time', '전례 없는 상태 조합', '레시피 자격 불확실', '복수 PM 겹침'])}</span>`; }
  const lat = escR ? '—' : (R(.18, .62)).toFixed(2) + 'ms';
  const el = document.createElement('div');
  el.className = 'jrow' + (escR ? ' escalated' : '');
  el.innerHTML = `<span class="t">${hms()}.${pad(RI(0, 999), 3)}</span><span class="ty ${type}">${type}</span><span class="m">${msg}</span>
    <span class="conf"><span class="bar"><i class="${conf < .7 ? 'low' : ''}" style="width:${conf * 100}%"></i></span><span>${conf.toFixed(2)}</span></span>
    <span class="lat">${lat}</span><span class="route ${escR ? 'esc' : ''}">${escR ? 'LLM 에스컬레이션' : 'JEV LOCAL'}</span>`;
  jevList.prepend(el);
  while (jevList.children.length > 40) jevList.lastChild.remove();
  decTotal++;
  if (escR) {
    setLLM(true);
    setTimeout(() => {
      const rt = $('.route', el); rt.className = 'route res'; rt.textContent = `LLM ✓ ${RI(380, 900)}ms`;
      $('.lat', el).textContent = (R(400, 900) | 0) + 'ms';
      if (!busy) setLLM(false);
    }, R(900, 1600));
  }
}
setInterval(jevRow, 280);
function renderJevStats() {
  jev.rate = 2841 + RI(-140, 160);
  $('#jevstats').innerHTML = `<span>판단 <b class="c">${fmt(jev.rate)}</b>/s</span><span>p50 <b>0.31</b>ms</span><span>p99 <b>1.8</b>ms</span><span>LLM 에스컬레이션 <b class="v">${jev.esc.toFixed(1)}%</b></span><span>정책 <b>${$('#polVer').textContent}</b></span>`;
  $('#jevRate').textContent = fmt(jev.rate) + '/s';
}
setInterval(renderJevStats, 1000); renderJevStats();

let llmBusyByFlow = false;
function setLLM(on) { const el = $('#llmState'); el.textContent = on ? 'REASONING' : 'STANDBY'; el.classList.toggle('busy', on); }

// ---------------------------------------------------------------- scenario injection
const SCEN = [
  { k: 'r', icon: 'power', t: '설비 다운', d: '랜덤 설비 비계획 다운', run: injectDown },
  { k: 'a', icon: 'flame', t: '핫랏 투입', d: '긴급 고객 샘플 랏', run: injectHot },
  { k: 'v', icon: 'traffic', t: 'OHT 정체', d: 'Interbay 구간 혼잡', run: injectJam },
  { k: 'b', icon: 'pause', t: '레시피 홀드', d: 'SPC OOC 발생', run: injectHold },
];
$('#scen').innerHTML = SCEN.map((s, i) => `<button class="${s.k}" data-i="${i}">${ic(s.icon)}<b>${s.t}</b><span>${s.d}</span></button>`).join('');
$$('#scen button').forEach(b => b.onclick = () => SCEN[b.dataset.i].run());

function burst(n, fn) { let i = 0; const iv = setInterval(() => { fn(i); if (++i >= n) clearInterval(iv); }, 160); }
function injectDown() {
  const t = pick(tools.filter(x => x.state === 'RUN' && !['ETCH-03', 'CMP-02'].includes(x.id)));
  t.state = 'DOWN'; t.forced = true; t.lot = null; t.queue = Math.max(t.queue, 4);
  setTimeout(() => t.forced = false, 20000);
  toast('red', 'power', `${t.id} 비계획 다운`, `대기 ${t.queue}랏 · Jev가 동일 레시피 설비로 재분배 중`);
  addEvent('CRIT', t.id, '[주입] 비계획 다운 · Jev 재분배 시작', '시나리오');
  const alts = tools.filter(x => x.area === t.area && x.state === 'RUN' && x !== t);
  burst(4, () => {
    const a = pick(alts);
    const el = document.createElement('div'); el.className = 'jrow';
    el.innerHTML = `<span class="t">${hms()}.${pad(RI(0, 999), 3)}</span><span class="ty REROUTE">REROUTE</span><span class="m"><b>${newLot()}</b> · ${t.id} DOWN → <b>${a.id}</b> · 레시피 자격 확인</span><span class="conf"><span class="bar"><i style="width:94%"></i></span><span>0.94</span></span><span class="lat">0.4${RI(0, 9)}ms</span><span class="route">JEV LOCAL</span>`;
    jevList.prepend(el);
  });
  focusTools([t.id], 20); selected = t; showToolCard(t); renderAreas();
}
function injectHot() {
  const lot = newLot(), t = pick(tools.filter(x => x.area === 'PHOTO' && x.state === 'RUN'));
  t.hot = true; t.queue = Math.max(1, t.queue); KPIS[4].v++;
  toast('amber', 'flame', `핫랏 ${lot} 투입`, `고객 샘플 · 납기 D-3 · Jev가 ${t.id} 대기열 선두로 배치`);
  addEvent('WARN', lot, `[주입] 핫랏 투입 · ${t.id} 선점 배치`, '시나리오');
  vehicles.filter(v => v.path === outer).slice(0, 3).forEach(v => v.hot = true);
  focusTools([t.id], 20); renderKpis();
}
function injectJam() {
  jam = { x0: 18, x1: 34, until: performance.now() + 15000 };
  jevBoost = .12; setTimeout(() => jevBoost = 0, 6000);
  toast('violet', 'traffic', 'Interbay OHT 정체', '구간 x18–34 · Jev 반송 경로 재계산 · 판단 확신도 하락 → LLM 에스컬레이션 증가');
  addEvent('WARN', 'AMHS', '[주입] Interbay 정체 · 우회 경로 활성화', '시나리오');
  jev.esc = 3.4; setTimeout(() => jev.esc = .7, 8000);
  camT = camFor(26, 22, 13);
}
function injectHold() {
  const n = RI(4, 7); KPIS[5].v += n;
  toast('cyan', 'pause', `레시피 홀드 · ${n}랏`, 'CD-SEM SPC OOC → DE-M3-071 레시피 사용 랏 자동 홀드');
  addEvent('WARN', 'DE-M3-071', `[주입] SPC OOC · ${n}랏 홀드`, '시나리오');
  burst(n, () => {
    const el = document.createElement('div'); el.className = 'jrow';
    el.innerHTML = `<span class="t">${hms()}.${pad(RI(0, 999), 3)}</span><span class="ty HOLD">HOLD</span><span class="m"><b>${newLot()}</b> · 레시피 DE-M3-071 · SPC OOC 연계 홀드</span><span class="conf"><span class="bar"><i style="width:99%"></i></span><span>0.99</span></span><span class="lat">0.2${RI(0, 9)}ms</span><span class="route">JEV LOCAL</span>`;
    jevList.prepend(el);
  });
  renderKpis();
}

// ---------------------------------------------------------------- What-if sim overlay
const sim = { on: false };
function runSim(ms = 3400) {
  return new Promise(res => {
    sim.on = true; mapEl.classList.add('simulating'); $('#simbar').classList.add('on');
    const st = performance.now();
    const iv = setInterval(() => {
      const k = Math.min(1, (performance.now() - st) / ms);
      $('#sbFill').style.width = (k * 100) + '%';
      const mins = Math.floor(k * 24 * 60);
      $('#sbTime').textContent = `T+${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
      if (k >= 1) { clearInterval(iv); sim.on = false; mapEl.classList.remove('simulating'); $('#simbar').classList.remove('on'); res(); }
    }, 40);
  });
}

// ---------------------------------------------------------------- Copilot chat
const chatEl = $('#chat'), input = $('#input'), sendBtn = $('#send');
let busy = false, sentAt = 0;
function scrollChat() { chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' }); }
function msg(role, html, cls = '') {
  const el = document.createElement('div');
  el.className = `msg ${role} ${cls}`;
  el.innerHTML = role === 'ai' ? `<div class="av">${ic('sparkle')}</div><div class="bubble">${html}</div>` : `<div class="bubble">${html}</div>`;
  chatEl.appendChild(el); scrollChat(); return el;
}
async function aiText(html, cont = false) {
  const el = msg('ai', '', cont ? 'cont' : '');
  const b = $('.bubble', el), plain = html.replace(/<[^>]+>/g, '');
  b.classList.add('caret');
  for (let i = 0; i <= plain.length; i += 3) { b.textContent = plain.slice(0, i); if (i % 30 === 0) scrollChat(); await sleep(12); }
  b.classList.remove('caret'); b.innerHTML = html; scrollChat();
  return el;
}
function aiBlock(html) { return msg('ai', html, 'cont'); }

function think(steps, title = '지시 처리 중') {
  const el = msg('ai', `<div class="think"><div class="think-h"><span class="spin"></span><span class="tl">${title}</span><span class="tt mono">0.0s</span></div><ol>${steps.map(s => `<li><span class="sd"></span><div><div class="st"><b>${s.t}</b><span class="who ${s.who.toLowerCase()}">${s.who}</span><span class="ms mono"></span></div><div class="sdet">${s.d}</div></div></li>`).join('')}</ol></div>`);
  const lis = $$('li', el), st0 = performance.now();
  const timer = setInterval(() => $('.tt', el).textContent = ((performance.now() - st0) / 1000).toFixed(1) + 's', 100);
  return {
    async run() {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i], st = performance.now();
        lis[i].classList.add('active'); scrollChat();
        if (s.sim) await runSim(s.ms || 3400); else await sleep(s.ms || R(700, 1100));
        lis[i].classList.remove('active'); lis[i].classList.add(s.warn ? 'warn' : s.issue ? 'issue' : 'done');
        $('.ms', lis[i]).textContent = s.sim ? `${((performance.now() - st) / 1000).toFixed(1)}s · 24h` : ((performance.now() - st) / 1000).toFixed(1) + 's';
      }
      clearInterval(timer);
      $('.think', el).classList.add('finished'); $('.tl', el).textContent = steps.some(s => s.warn) ? '안전 검증에서 차단됨' : '처리 완료';
      if (steps.some(s => s.warn)) { const sp = $('.spin', el); sp.style.background = 'var(--red)'; sp.style.borderColor = 'var(--red)'; }
    }
  };
}

function policyCard(p) {
  return `<div class="pol"><div class="pol-h"><span class="pol-type">${p.type}</span><span class="pol-id mono">${p.id}</span><span class="pol-conf">해석 확신도 <b class="mono">${p.conf}</b></span></div>
    <div class="pol-src">“${p.src}”</div>
    <div class="pol-kv">${Object.entries(p.kv).map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div></div>`;
}

function lineChart(a, b, opts = {}) {
  const w = 360, h = 112, pl = 30, pr = 6, pt = 8, pb = 18;
  const all = [...a, ...b], mn = Math.min(...all), mx = Math.max(...all), pad0 = (mx - mn) * .15 || 1;
  const lo = mn - pad0, hi = mx + pad0;
  const X = i => pl + i / (a.length - 1) * (w - pl - pr), Y = v => pt + (1 - (v - lo) / (hi - lo)) * (h - pt - pb);
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const grid = [0, .5, 1].map(k => { const v = lo + (hi - lo) * k; return `<line x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(140,175,220,.08)"/><text x="${pl - 5}" y="${Y(v) + 3}" fill="#5c6b80" font-size="9" text-anchor="end" font-family="JetBrains Mono">${v.toFixed(opts.dec ?? 0)}</text>`; }).join('');
  const xl = (opts.xl || ['0h', '6h', '12h', '18h', '24h']).map((t, i) => `<text x="${X(i / 4 * (a.length - 1))}" y="${h - 4}" fill="#5c6b80" font-size="9" text-anchor="middle" font-family="JetBrains Mono">${t}</text>`).join('');
  const lim = opts.limit != null ? `<line x1="${pl}" x2="${w - pr}" y1="${Y(opts.limit)}" y2="${Y(opts.limit)}" stroke="#3ee0ff" stroke-dasharray="3 3" opacity=".6"/><text x="${w - pr}" y="${Y(opts.limit) - 4}" fill="#3ee0ff" font-size="9" text-anchor="end" font-family="JetBrains Mono">${opts.limitLabel || 'LIMIT ' + opts.limit}</text>` : '';
  return `<svg viewBox="0 0 ${w} ${h}">${grid}${xl}${lim}
    <path d="${path(b)}L${X(b.length - 1)},${h - pb}L${pl},${h - pb}Z" fill="${hexA(opts.color || '#a98bff', .12)}"/>
    <path d="${path(a)}" fill="none" stroke="#6f7e94" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${path(b)}" fill="none" stroke="${opts.color || '#a98bff'}" stroke-width="2"/></svg>`;
}
const series = (n, f) => Array.from({ length: n }, (_, i) => f(i / (n - 1), i));

function whatifCard(o) {
  const el = aiBlock(`<div class="card">
    <div class="card-h"><span class="tagb v">WHAT-IF</span>${o.title}<span class="sub">${o.sub}</span></div>
    <div class="wf-rows"><div class="wf-head"><span>지표</span><span>${o.cols[0]}</span><span></span><span>${o.cols[1]}</span><span>Δ</span></div>
      ${o.rows.map(r => `<div class="wf-row"><span class="wf-k">${r.k}</span><span class="wf-a mono">${r.a}</span><span class="wf-arrow">→</span><span class="wf-b mono">${r.b}</span><span class="wf-d mono ${r.g === 1 ? 'good' : r.g === -1 ? 'bad' : 'neu'}">${r.d}</span></div>`).join('')}
    </div>
    <div class="chartbox"><div class="cl"><b style="color:var(--text2);font-weight:600">${o.chart.label}</b><span><i style="background:#6f7e94"></i>${o.cols[0]}<i style="background:${o.chart.color || '#a98bff'};margin-left:8px"></i>${o.cols[1]}</span></div>${lineChart(o.chart.a, o.chart.b, o.chart)}</div>
    <div class="verdict ${o.verdict.kind}">${ic(o.verdict.kind === 'good' ? 'check' : 'alert')}<div>${o.verdict.text}</div></div>
    <div class="actions">${o.actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-act="${i}">${a.icon ? ic(a.icon) : ''}${a.label}</button>`).join('')}</div>
  </div>`);
  $$('[data-act]', el).forEach(b => b.onclick = () => o.actions[b.dataset.act].on(b, el));
  return el;
}
const lockActions = (el, keep, label) => $$('[data-act]', el).forEach(b => { b.disabled = true; if (b === keep && label) b.innerHTML = label; });

// ---- flow: 핫랏 우선 + 설비 부하 제한
async function flowHot() {
  await think([
    { t: '의도 파싱', who: 'LLM', d: '지시 2건 인식 · ① 랏 우선순위 상향 (L2417) ② 설비 처리 용량 제한 (ETCH-03, 80%)' },
    { t: '정책 스키마 매핑', who: 'LLM', d: 'PRIORITY_OVERRIDE · CAPACITY_CAP → typed policy schema v2 검증 통과' },
    { t: '제약 · 안전 검증', who: 'Guard', d: 'Q-time 4건 · PM 일정 · 레시피 자격(ETCH-04/05 qualified) · 위험도 LOW (0.18)' },
    { t: '디지털트윈 What-if', who: 'Twin', d: '현재 FAB 상태 스냅샷 복제 → 24h 선행 시뮬레이션 · 5 seeds 평균', sim: true },
  ]).run();
  await aiText('지시 2건을 <strong>타입 정책</strong>으로 변환하고 트윈에서 24시간을 선행 시뮬레이션했습니다. <strong>L2417 잔여 TAT −40%</strong>, 전체 Moves 영향은 −0.5%로 미미합니다.', true);
  aiBlock(policyCard({
    type: 'PRIORITY_OVERRIDE', id: 'POL-0142', conf: '0.97', src: 'L2417 핫랏 최우선 처리',
    kv: { target: '"lot:L2417"  <em>// N3-AP7 · step 38/62</em>', priority: 'P0 <em>// 최상위</em>', scope: 'remaining_steps (24)', preempt: 'queue_only <em>// 진행 중 랏 중단 금지</em>', expires: 'on_ship' },
  }) + policyCard({
    type: 'CAPACITY_CAP', id: 'POL-0143', conf: '0.94', src: 'ETCH-03 부하 80% 이하로 제한',
    kv: { target: '"tool:ETCH-03"', metric: 'utilization.rolling_1h', limit: '≤ 0.80', overflow: '["ETCH-04","ETCH-05"] <em>// 레시피 자격 일치</em>', expires: 'null → 24h 후 재확인 요청' },
  }));
  await sleep(300);
  whatifCard({
    title: '정책 적용 영향 비교', sub: '24h · 5 seeds · 3.4s', cols: ['현재', '적용 시'],
    rows: [
      { k: 'Moves / h', a: '4,812', b: '4,789', d: '−0.5%', g: 0 },
      { k: 'L2417 잔여 TAT', a: '31.2h', b: '18.6h', d: '−40%', g: 1 },
      { k: 'ETCH-03 가동률', a: '96.1%', b: '79.6%', d: '−16.5p', g: 1 },
      { k: 'ETCH-04/05 가동률', a: '71.2%', b: '84.0%', d: '+12.8p', g: 0 },
      { k: 'ETCH 베이 대기 WIP', a: '412', b: '437', d: '+6.1%', g: -1 },
      { k: 'Q-time 위반 예상', a: '6', b: '2', d: '−4', g: 1 },
    ],
    chart: { label: 'ETCH-03 가동률 예측 (%)', a: series(25, (k) => 95 + Math.sin(k * 9) * 1.6 + k * 1.2), b: series(25, (k, i) => i < 2 ? 95 - i * 8 : 78.4 + Math.sin(k * 11) * 1.1), limit: 80, color: '#3ee0ff' },
    verdict: { kind: 'good', text: '<b>권장</b> — 핫랏 납기(D-2) 확보, Q-time 위반 감소. 부작용은 ETCH 베이 대기 +6% 수준으로 허용 범위 내입니다.' },
    actions: [
      { label: '승인하고 적용', cls: 'primary', icon: 'check', on: (b, el) => { lockActions(el, b, `${ic('check')}적용됨`); applyHot(); } },
      { label: '조건 수정', on: () => { input.value = 'ETCH-03 부하 제한을 85%로 바꿔서 다시 시뮬레이션해줘'; input.focus(); } },
      { label: '반려', cls: 'ghost', on: async (b, el) => { lockActions(el); await aiText('반려했습니다. 현재 운영 정책을 그대로 유지합니다.'); } },
    ],
  });
}
async function applyHot() {
  setLLM(true);
  await sleep(500);
  const secs = ((performance.now() - sentAt) / 1000).toFixed(1);
  aiBlock(`<div class="applied"><div class="applied-h"><span class="ok">${ic('check')}</span>정책 2건 적용 완료<span class="sub">지시→반영 ${secs}s · 목표 60s ✓</span></div>
    <ul><li>Jev 정책 테이블 hot-swap <b>v2.41 → v2.42</b> · 판단 경로 재컴파일 0.8ms</li>
    <li><b>L2417</b> 잔여 24 steps에 P0 적용 · 반송 우선권 부여</li>
    <li><b>ETCH-03</b> 초과 물량 → ETCH-04/05 실시간 재분배 시작</li>
    <li>24h 후 CAPACITY_CAP 재확인 요청 예약 · 감사 로그 기록</li></ul></div>`);
  setLLM(false);
  $('#polVer').textContent = 'v2.42';
  policies.unshift(
    { id: 'POL-0143', type: 'CAPACITY_CAP', src: 'ETCH-03 부하 80% 이하로 제한', status: 'ACTIVE', at: hms().slice(0, 5), impact: 'ETCH-03 96→80%' },
    { id: 'POL-0142', type: 'PRIORITY_OVERRIDE', src: 'L2417 핫랏 최우선 처리', status: 'ACTIVE', at: hms().slice(0, 5), impact: 'TAT −40%' },
  );
  renderPolicies('POL-0142');
  addEvent('AI', 'POL-0142/0143', '자연어 지시 → 정책 2건 승인·적용 (운영담당 L2)', '승인됨');
  policyLive = true;
  const e3 = byId['ETCH-03'];
  e3.tag = { text: 'CAP ≤80%', color: '#3ee0ff', keep: true };
  byId['ETCH-04'].tag = { text: '+재분배', color: '#36d98e', keep: true }; byId['ETCH-05'].tag = { text: '+재분배', color: '#36d98e', keep: true };
  const nodes = ['ETCH-03', 'METRO-02', 'CLEAN-02', 'DEPO-03', 'PHOTO-05'];
  const pts = routeVia(nodes);
  route = { nodes, pts, label: 'L2417 · HOT P0' };
  vehicles.filter(v => v.path === outer).slice(0, 2).forEach(v => v.hot = true);
  toast('green', 'check', '정책 적용 · v2.42', 'POL-0142 PRIORITY_OVERRIDE · POL-0143 CAPACITY_CAP');
  focusTools(['ETCH-03', 'ETCH-04', 'ETCH-05'], 18);
  // 효과 연출
  let k = 0; const iv = setInterval(() => {
    e3.util = Math.max(79.6, e3.util - 2.2); e3.queue = Math.max(3, e3.queue - (k % 3 === 0 ? 1 : 0));
    byId['ETCH-04'].util = Math.min(84, byId['ETCH-04'].util + 1.5); byId['ETCH-05'].util = Math.min(84, byId['ETCH-05'].util + 1.6);
    if (++k > 10) clearInterval(iv);
  }, 700);
  KPIS[6].v = 4; renderKpis();
  await sleep(1200);
  await aiText('트윈 맵에 <strong>L2417 예상 경로</strong>와 재분배 대상을 표시했습니다. 하단 Jev 스트림에서 새 정책(POL-0142/0143)이 적용된 판단을 실시간으로 확인할 수 있습니다.');
  openTab('jev');
}

// ---- flow: 설비 다운 what-if
async function flowDown(text) {
  const id = (text.match(/[A-Z]+-\d{2}/i) || ['CMP-02'])[0].toUpperCase();
  const t = byId[id] || byId['CMP-02'];
  await think([
    { t: '의도 파싱', who: 'LLM', d: `What-if 질의 · 시나리오: ${t.id} 비계획 다운 · <b>실제 반영 없음</b>` },
    { t: '시나리오 구성', who: 'Twin', d: `MTTR 분포(평균 4.2h) 적용 · 영향 랏 ${t.queue + 11} · 하위 공정 3개 추적` },
    { t: '디지털트윈 What-if', who: 'Twin', d: 'Baseline vs 다운 시나리오 · 24h 선행 · 5 seeds', sim: true },
    { t: '완화 정책 탐색', who: 'LLM', d: '완화 정책 후보 3건 생성 → 트윈 재검증 → 2건 유효' },
  ], 'What-if 분석 중').run();
  await aiText(`${t.id} 다운 시 <strong>${AREAS[t.area].name} 베이 대기가 급증</strong>하고, 특히 <strong>Q-time 위반이 주 리스크</strong>입니다. 아래는 트윈 시뮬레이션 결과입니다.`, true);
  focusTools([t.id], 19); selected = t;
  whatifCard({
    title: `${t.id} 다운 시나리오`, sub: '24h · 5 seeds · MTTR 4.2h', cols: ['현재', '다운 시'],
    rows: [
      { k: 'Moves / h', a: '4,812', b: '4,655', d: '−3.3%', g: -1 },
      { k: `${t.area} 베이 대기 WIP`, a: '186', b: '291', d: '+56%', g: -1 },
      { k: 'Q-time 위반 예상', a: '6', b: '19', d: '+13', g: -1 },
      { k: 'Hot lot 지연', a: '0', b: '2 lots', d: '+2', g: -1 },
      { k: `동일 공정 설비 가동률`, a: '78.0%', b: '96.4%', d: '+18.4p', g: 0 },
    ],
    chart: { label: `${t.area} 베이 대기 WIP 예측 (wfr)`, a: series(25, k => 186 + Math.sin(k * 8) * 9), b: series(25, k => 186 + 120 * Math.min(1, k * 4) - Math.max(0, k - .4) * 60 + Math.sin(k * 10) * 7), color: '#ff7a59' },
    verdict: { kind: 'warn', text: '<b>영향 큼</b> — 완화 정책 A 사전 등록 시 Q-time 위반 19 → 7 로 감소 예상' },
    actions: [],
  });
  aiBlock(`<div class="card"><div class="card-h"><span class="tagb v">LLM</span>완화 정책 후보<span class="sub">트윈 재검증 완료</span></div>
    <div class="alts">
      <div class="alt"><div class="alt-h"><span class="n">A</span>상위 공정 투입 게이팅 (Q-time 2h 구간 선행 홀드)</div><p>Q-time 위반 <b>19 → 7</b> · Moves −0.8%p · 위험도 LOW</p></div>
      <div class="alt"><div class="alt-h"><span class="n">B</span>인접 설비 PM 이연 + 레시피 공유</div><p>Q-time 위반 <b>19 → 11</b> · PM 이연 리스크 MEDIUM</p></div>
    </div>
    <div class="actions"><button class="btn primary" data-x="a">${ic('shield')}A를 대기 정책으로 등록</button><button class="btn violet" data-x="inj">${ic('flask')}샌드박스에 주입</button></div></div>`);
  const last = chatEl.lastElementChild;
  $('[data-x=a]', last).onclick = e => {
    e.currentTarget.disabled = true; e.currentTarget.innerHTML = ic('check') + '등록됨';
    policies.unshift({ id: 'POL-0144', type: 'CONDITIONAL_GATE', src: `${t.id} DOWN 시 상위 공정 투입 게이팅 자동 활성`, status: 'STANDBY', at: hms().slice(0, 5), impact: '트리거 대기' });
    renderPolicies('POL-0144');
    toast('amber', 'shield', 'POL-0144 대기 정책 등록', `트리거: ${t.id} 상태 = DOWN → Jev 자동 활성화`);
  };
  $('[data-x=inj]', last).onclick = e => {
    e.currentTarget.disabled = true;
    $('#mode [data-mode=sandbox]').click();
    t.state = 'DOWN'; t.forced = true; showToolCard(t);
    toast('violet', 'flask', `샌드박스: ${t.id} DOWN`, '트윈 복제본에만 적용 · 실제 운영 영향 없음');
    setTimeout(() => { t.state = 'RUN'; t.forced = false; }, 15000);
  };
}

// ---- flow: 위험 지시
async function flowRisky() {
  await think([
    { t: '의도 파싱', who: 'LLM', d: 'PM_RESCHEDULE · 대상: ETCH 전체 14대 · +1 day' },
    { t: '정책 스키마 매핑', who: 'LLM', d: 'PM_RESCHEDULE × 14 (bulk) · 영향 범위 = 공정 전체 → 위험 검사 필수' },
    { t: '디지털트윈 What-if', who: 'Twin', d: 'PM 연기 시 설비 상태 열화 모델 포함 24h 시뮬레이션', sim: true, ms: 2600 },
    { t: '안전 가드레일', who: 'Guard', d: '위험 규칙 3건 위반 감지 → 자동 적용 차단 · 확인 요청', warn: true },
  ]).run();
  await aiText('이 지시는 <strong>위험 지시로 분류되어 자동 적용이 차단</strong>되었습니다. 근거와 안전한 대안을 함께 드립니다.', true);
  aiBlock(`<div class="card"><div class="card-h"><span class="tagb r">BLOCKED</span>고위험 지시 · 확인 필요<span class="sub">risk 0.82</span></div>
    <div class="riskmeter"><div class="rm"><i style="left:82%"></i></div><span>HIGH</span></div>
    <ul class="risk-list">
      <li><span><b>ETCH-07 · ETCH-10</b> PM 한계 RF 시간 97% · 99% 도달 — 연기 시 한계 초과</span></li>
      <li><span><b>ETCH-13</b> 챔버 파티클 추세 3σ 상승 (최근 48h) — 수율 리스크</span></li>
      <li><span>14대 동시 연기 → 내일 PM 집중, ETCH 가용 설비 <b>45%</b>로 급감</span></li>
      <li><span>트윈 예측: 비계획 다운 확률 <b>4% → 31%</b></span></li>
    </ul>
    <div class="alts">
      <div class="alt"><div class="alt-h"><span class="n">1</span>여유 있는 8대만 연기 (위험·임박 6대 제외)</div><p>비계획 다운 확률 <b>6%</b> · Moves +1.1%</p></div>
      <div class="alt"><div class="alt-h"><span class="n">2</span>PM을 3일간 야간 슬롯으로 분산</div><p>비계획 다운 확률 <b>4%</b> · Moves −0.4%</p></div>
    </div>
    <div class="actions"><button class="btn primary" data-x="1">${ic('flask')}대안 1 시뮬레이션</button><button class="btn" data-x="2">대안 2 시뮬레이션</button><button class="btn danger" data-x="force">원 지시 진행 (2단계 승인)</button></div></div>`);
  const card = chatEl.lastElementChild;
  addEvent('AI', 'Guard', '위험 지시 차단 · PM_RESCHEDULE bulk(14) · risk 0.82', '확인 요청');
  toast('red', 'shield', '위험 지시 자동 차단', 'PM_RESCHEDULE × 14 · risk 0.82 · 대안 2건 제시');
  focusArea('ETCH');
  ['ETCH-07', 'ETCH-10', 'ETCH-13'].forEach(id => { byId[id].tag = { text: id === 'ETCH-13' ? '파티클 3σ' : 'PM 한계', color: '#ff4d5e' }; });
  setTimeout(() => ['ETCH-07', 'ETCH-10', 'ETCH-13'].forEach(id => { if (byId[id].tag?.color === '#ff4d5e') byId[id].tag = null; }), 16000);
  const disable = () => $$('[data-x]', card).forEach(b => b.disabled = true);
  $('[data-x="1"]', card).onclick = async () => { disable(); await altFlow(1); };
  $('[data-x="2"]', card).onclick = async () => { disable(); await altFlow(2); };
  $('[data-x=force]', card).onclick = async () => {
    disable();
    msg('user', '원 지시대로 진행해줘');
    await aiText('원 지시는 위험도 HIGH로 <strong>생산관리자 2단계 승인</strong>이 필요합니다. 근거 리포트와 함께 승인 요청을 보냈습니다. <span class="mono">(APR-0388)</span>');
    addEvent('AI', 'APR-0388', '2단계 승인 요청 · 생산관리자', '대기');
  };
}
async function altFlow(n) {
  busy = true; sendBtn.classList.add('busy');
  msg('user', `대안 ${n}로 시뮬레이션해줘`);
  await think([
    { t: '정책 재구성', who: 'LLM', d: n === 1 ? 'PM_RESCHEDULE × 8 · 제외: ETCH-07/10/13 외 3대' : 'PM_RESCHEDULE × 14 → 야간 슬롯 3일 분산' },
    { t: '디지털트윈 What-if', who: 'Twin', d: '72h 선행 · 5 seeds', sim: true, ms: 2600 },
    { t: '안전 가드레일', who: 'Guard', d: '위험 규칙 위반 없음 · risk 0.21 LOW' },
  ]).run();
  whatifCard({
    title: `대안 ${n} 영향`, sub: '72h · 5 seeds', cols: ['원 지시', `대안 ${n}`],
    rows: [
      { k: '비계획 다운 확률', a: '31%', b: n === 1 ? '6%' : '4%', d: n === 1 ? '−25p' : '−27p', g: 1 },
      { k: 'ETCH 최저 가용 설비', a: '45%', b: n === 1 ? '80%' : '90%', d: n === 1 ? '+35p' : '+45p', g: 1 },
      { k: 'Moves / h', a: '4,951', b: n === 1 ? '4,865' : '4,793', d: n === 1 ? '−1.7%' : '−3.2%', g: 0 },
    ],
    chart: { label: 'ETCH 가용 설비 비율 (%)', a: series(25, k => k > .35 && k < .6 ? 45 : 96 - Math.sin(k * 7) * 2), b: series(25, k => n === 1 ? (k > .35 && k < .6 ? 80 : 94) : 90 + Math.sin(k * 20) * 3), color: '#36d98e' },
    verdict: { kind: 'good', text: `<b>안전</b> — 위험 설비를 제외해 원 지시의 의도(PM 부담 완화)는 유지하면서 리스크를 제거했습니다.` },
    actions: [
      { label: '승인하고 적용', cls: 'primary', icon: 'check', on: (b, el) => {
        lockActions(el, b, `${ic('check')}적용됨`);
        policies.unshift({ id: 'POL-0145', type: 'PM_RESCHEDULE', src: n === 1 ? 'ETCH PM 14대 +1일 연기 (위험 6대 제외)' : 'ETCH PM 3일 야간 분산', status: 'ACTIVE', at: hms().slice(0, 5), impact: n === 1 ? '다운 확률 6%' : '다운 확률 4%' });
        renderPolicies('POL-0145'); $('#polVer').textContent = 'v2.43';
        toast('green', 'check', 'POL-0145 적용', '안전 대안 승인 · Jev 정책 테이블 v2.43');
        aiBlock(`<div class="applied compact"><div class="applied-h"><span class="ok">${ic('check')}</span>대안 ${n} 적용 완료<span class="sub">POL-0145 · v2.43</span></div></div>`);
      } },
      { label: '취소', cls: 'ghost', on: (b, el) => lockActions(el) },
    ],
  });
  busy = false; sendBtn.classList.remove('busy'); setLLM(false);
}

// ---- flow: 질의 (병목)
async function flowAsk(text) {
  const tm = text.match(/[A-Z]+-\d{2}/i);
  if (tm && byId[tm[0].toUpperCase()]) return flowToolAsk(byId[tm[0].toUpperCase()]);
  await think([
    { t: '질의 해석', who: 'LLM', d: '분석 질의 · 지표: 공정별 대기시간 · 범위: FAB 전체 최근 4h' },
    { t: '트윈 텔레메트리 조회', who: 'Jev', d: '이벤트 로그 1.2M건 집계 · 설비 160대 · 랏 1,284개' },
    { t: '원인 분석', who: 'LLM', d: '병목 후보 3곳 → 처리 용량·대기열·핫랏 영향 비교' },
  ], '분석 중').run();
  await aiText('현재 병목은 <strong>식각(ETCH)</strong>입니다. 특히 <strong>ETCH-03</strong> 한 대가 가동률 96%로 대기열 6랏(핫랏 L2417 포함)을 쌓고 있고, 동일 레시피 자격을 가진 ETCH-04/05는 70%대로 여유가 있습니다.', true);
  const data = [['ETCH', 3.8, '#ff7a59'], ['PHOTO', 3.1, '#f5c542'], ['CMP', 2.4, '#7aa2ff'], ['DEPO', 1.7, '#4fd1c5'], ['DIFF', 1.5, '#ff5fa2'], ['CLEAN', 0.9, '#9be15d']];
  aiBlock(`<div class="card"><div class="card-h"><span class="tagb c">TWIN</span>공정별 평균 대기시간<span class="sub">최근 4h · hours</span></div>
    <div class="bars">${data.map(([n, v, c]) => `<div class="brow"><span class="bn mono">${n}</span><span class="bt"><i style="width:${v / 4 * 100}%;background:${c}"></i></span><span class="bv">${v.toFixed(1)}h</span></div>`).join('')}</div></div>
    <div class="sugg"><button data-s="L2417 핫랏 최우선으로 처리하고 ETCH-03 부하는 80% 이하로 제한해줘">ETCH-03 부하 분산 정책 만들기</button><button data-s="ETCH-03 지금 다운되면 영향은?">ETCH-03 다운 What-if</button></div>`);
  $$('.sugg button', chatEl.lastElementChild).forEach(b => b.onclick = () => send(b.dataset.s));
  setArea('ETCH'); focusArea('ETCH');
  layers.heat = true; $('#layers [data-l=heat]').classList.add('on');
}
async function flowToolAsk(t) {
  await think([
    { t: '질의 해석', who: 'LLM', d: `설비 상태 질의 · 대상 ${t.id}` },
    { t: '트윈 텔레메트리 조회', who: 'Jev', d: '설비 이벤트 · 대기열 · Q-time 잔여 · PM 이력' },
  ], '분석 중').run();
  focusTools([t.id], 22); selected = t; showToolCard(t);
  await aiText(`<strong>${t.id}</strong>(${t.model})는 현재 <strong>${STATE[t.state].ko}</strong> 상태, 1h 가동률 ${t.util.toFixed(1)}%, 대기열 ${t.queue}랏입니다. ${t.queue >= 4 ? `대기 랏 중 <strong>${Math.min(2, t.queue - 2)}건이 Q-time 잔여 1h 미만</strong>으로 리스크가 있습니다. 동일 레시피 자격 설비로 일부 분산을 권장합니다.` : 'Q-time 위험 랏은 없으며 현 상태 유지를 권장합니다.'} 다음 PM은 ${t.pmDue}시간 후입니다.`, true);
}

// ---- flow: 고객 수요 변경 → FAB Planning 재계획
async function flowPlan() {
  await think([
    { t: '의도 파싱', who: 'LLM', d: '수요 변경 · 고객: 엔비디아 · 제품군 N3 GPU (N3-AP7, N3-AP9) · 물량 +20% · 적용 W42–W52' },
    { t: '계획 · 제약 로딩', who: 'Plan', d: 'MPS v4.12 · 주간 투입 15,500 wspw · 제품 7종 · 레시피 경로 1,840 steps · 설비 Capa 매트릭스 · 고객 계약 최소 물량' },
    { t: 'Capa 시뮬레이션', who: 'Twin', d: '투입 시나리오 3안 × 12주 선행 시뮬레이션 · 공정별 병목 탐지', sim: true, ms: 3800 },
    { t: '계획 재최적화', who: 'Solver', d: 'MILP · 목적: 납기 충족 + CT 최소 · 제약: 계약 최소 물량, Q-time, PM 창, 레시피 자격' },
    { t: '정책 · 계약 검증', who: 'Guard', d: '규칙 위반 없음 · 이해관계자 합의 필요 2건 (영업 · 공정기술)', issue: true },
  ], 'Planning 재계산 중').run();
  layers.heat = true; $('#layers [data-l=heat]').classList.add('on');
  ['PHOTO-01', 'PHOTO-02', 'PHOTO-03', 'PHOTO-04'].forEach(id => byId[id].tag = { text: 'EUV 99%', color: '#ff4d5e' });
  ['ETCH-07', 'ETCH-10'].forEach(id => byId[id].tag = { text: '+레시피 자격', color: '#3ee0ff' });
  setArea(null); camT = fitCam();
  await aiText('엔비디아 +20%는 <strong>현재 Capa만으로는 +14%가 한계</strong>입니다. 병목은 <strong>EUV 노광</strong>과 <strong>ETCH</strong>이고, 아래 3가지 조건을 적용하면 <strong>W47부터 +20% 출하</strong>가 가능합니다 (투입→출하 리드타임 약 5주).', true);
  aiBlock(`<div class="card"><div class="card-h"><span class="tagb g">PLAN</span>FAB Planning 변경안<span class="sub">MPS v4.12 → v4.13 draft</span></div>
    <div class="wf-rows"><div class="wf-head"><span>제품 · 고객</span><span>현재</span><span></span><span>변경</span><span>Δ wspw</span></div>
      ${[['N3-AP7 GPU', '엔비디아', '4,200', '5,040', '+840', 1], ['N3-AP9 GPU', '엔비디아', '1,800', '2,160', '+360', 1], ['N4-MB2 AP', '고객 B', '6,400', '6,100', '−300', -1], ['N5-HP1', '고객 C', '3,100', '3,100', '0', 0], ['합계', '', '15,500', '16,400', '+5.8%', 0]]
        .map(([k, c, a, b, d, g]) => `<div class="wf-row"><span class="wf-k">${k}<em>${c}</em></span><span class="wf-a mono">${a}</span><span class="wf-arrow">→</span><span class="wf-b mono">${b}</span><span class="wf-d mono ${g === 1 ? 'good' : g === -1 ? 'bad' : 'neu'}">${d}</span></div>`).join('')}
    </div>
    <div class="cap"><div class="cap-h"><b>공정별 Capa 부하</b><span><i class="c"></i>현재 <i class="n"></i>변경안</span></div>
      ${[['EUV', 88, 99, '#f5c542'], ['ETCH', 84, 93, '#ff7a59'], ['DEPO', 77, 82, '#4fd1c5'], ['CMP', 71, 76, '#7aa2ff'], ['DIFF', 69, 72, '#ff5fa2'], ['CLEAN', 63, 66, '#9be15d']]
        .map(([n, a, b, c]) => `<div class="cap-row"><span class="mono">${n}</span><span class="tr"><i class="n" style="width:${b}%;background:${hexA(c, .35)}"></i><i class="c" style="width:${a}%;background:${c}"></i><i class="lim"></i></span><span class="v ${b >= 95 ? 'hi' : ''}">${a}→${b}%</span></div>`).join('')}
    </div>
    <div class="chartbox"><div class="cl"><b style="color:var(--text2);font-weight:600">엔비디아 주간 출하 (wafers)</b><span><i style="background:#6f7e94"></i>현재 계획<i style="background:#36d98e;margin-left:8px"></i>v4.13</span></div>
      ${lineChart(series(12, k => 6000 + Math.sin(k * 9) * 60), series(12, (k, i) => i < 5 ? 6000 + Math.sin(k * 9) * 60 : Math.min(7200, 6000 + (i - 4) * 420) + Math.sin(k * 7) * 40), { limit: 7200, limitLabel: 'TARGET +20%', color: '#36d98e', xl: ['W41', 'W44', 'W47', 'W50', 'W52'] })}</div>
  </div>`);
  await sleep(250);
  const card = aiBlock(`<div class="card"><div class="card-h"><span class="tagb v">LLM</span>+20% 달성 조건<span class="sub">트윈 검증 완료</span></div>
    <div class="alts">
      <div class="alt"><div class="alt-h"><span class="n">1</span>EUV PM 주기 최적화 (부품 수명 기반)</div><p>EUV Capa <b>+3.1%</b> · 트윈 12주 검증 · 리스크 LOW</p></div>
      <div class="alt"><div class="alt-h"><span class="n">2</span>ETCH-07 · ETCH-10에 N3-AP9 식각 레시피 자격 추가</div><p>ETCH 병목 <b>93% → 88%</b> · 공정기술 승인 필요 (자격 평가 3일)</p></div>
      <div class="alt"><div class="alt-h"><span class="n">3</span>고객 B N4-MB2 −300 wspw (W44–W48 한시)</div><p>계약 최소 물량 <b>6,000</b> 유지 · 납기 영향 없음 · 영업 합의 필요</p></div>
    </div>
    <div class="verdict warn">${ic('alert')}<div><b>조건부 가능</b> — 3가지 적용 시 +20% 달성 · 평균 CT +0.8일 · 핫랏 정책 영향 없음</div></div>
    <div class="actions"><button class="btn primary" data-x="req">${ic('check')}v4.13 승인 요청</button><button class="btn" data-x="nob">고객 B 감량 없이 재계획</button><button class="btn ghost" data-x="rep">리포트 생성</button></div></div>`);
  $('[data-x=req]', card).onclick = async e => {
    e.currentTarget.disabled = true; e.currentTarget.innerHTML = ic('check') + '요청됨';
    policies.unshift({ id: 'PLN-0413', type: 'PLAN_UPDATE', src: '엔비디아 N3 GPU +20% · MPS v4.13 (조건 3건)', status: 'STANDBY', at: hms().slice(0, 5), impact: '승인 대기 3/3' });
    renderPolicies('PLN-0413');
    addEvent('AI', 'PLN-0413', 'MPS v4.13 승인 요청 · 생산관리 / 영업 / 공정기술', '대기');
    toast('green', 'check', 'MPS v4.13 승인 요청', '승인 완료 시 Jev 투입 정책(Release Rule)에 자동 반영');
    aiBlock(`<div class="applied"><div class="applied-h"><span class="ok">${ic('check')}</span>승인 요청 발송 · PLN-0413<span class="sub">승인 0 / 3</span></div>
      <ul><li><b>생산관리</b> 투입 계획 v4.13 — 대기</li><li><b>영업</b> 고객 B N4-MB2 한시 감량 합의 — 대기</li><li><b>공정기술</b> ETCH-07/10 레시피 자격 평가 — 대기</li>
      <li>승인 완료 시 <b>W42 투입분</b>부터 Release Rule 자동 교체 · 감사 로그 기록</li></ul></div>`);
  };
  $('[data-x=nob]', card).onclick = async e => {
    e.currentTarget.disabled = true;
    msg('user', '고객 B 물량은 건드리지 말고 다시 짜줘');
    await aiText('고객 B 물량을 유지하면 엔비디아는 <strong>최대 +16% (W48~)</strong>까지 가능합니다. 나머지 4%는 <strong>W49 EUV 추가 PM 슬롯을 야간으로 이동</strong>하면 W51부터 회복 가능하며, 이 경우 Q-time 위반이 주당 2건 늘어날 것으로 예측됩니다.');
  };
  $('[data-x=rep]', card).onclick = () => toast('cyan', 'info', '리포트 생성 (데모)', 'FAB_Plan_v4.13_draft.pdf · 시나리오 3안 비교 · 12주 Capa 표 포함');
}

// ---- flow: PM 하루 앞당김 사전 점검
const PM_ROWS = [
  { id: 'ETCH-03', hod: 19, dur: 6, v: 'crit', rec: 22.67 - 16 },
  { id: 'PHOTO-06', hod: 18, dur: 7, v: 'warn', rec: 2 },
  { id: 'PHOTO-07', hod: 20, dur: 7, v: 'warn', rec: 10 },
  { id: 'CMP-05', hod: 18, dur: 5, v: 'warn', rec: 3 },
  { id: 'DEPO-04', hod: 21, dur: 4, v: 'ok' },
  { id: 'DEPO-07', hod: 22, dur: 5, v: 'ok' },
  { id: 'IMP-02', hod: 18.5, dur: 6, v: 'ok' },
  { id: 'CLEAN-07', hod: 23, dur: 3, v: 'ok' },
  { id: 'METRO-05', hod: 20, dur: 2, v: 'ok' },
];
function ganttHtml() {
  const SPAN = 40, pct = h => (h / SPAN * 100).toFixed(2) + '%', now = 1.4;
  const ticks = [0, 8, 16, 24, 32, 40].map(t => `<i class="${t === 8 || t === 32 ? 'day' : ''}" style="left:${pct(t)}">${t === 8 ? '10/03' : t === 32 ? '10/04' : pad((16 + t) % 24) + 'h'}</i>`).join('');
  return `<div class="gantt"><div class="g-axis"><span></span><div class="g-ticks">${ticks}</div></div>
    ${PM_ROWS.map(r => { const o = r.hod + 8, p = r.hod - 16; return `<div class="g-row" data-id="${r.id}"><span class="g-id mono">${r.id}</span><div class="g-track">
      <i class="g-day" style="left:${pct(8)}"></i><i class="g-day" style="left:${pct(32)}"></i><i class="g-now" style="left:${pct(now)}"></i>
      <b class="g-bar orig" style="left:${pct(o)};width:${pct(r.dur)}"></b>
      <b class="g-bar prop ${r.v}" data-rec="${r.rec ?? p}" style="left:${pct(p)};width:${pct(r.dur)}"></b></div></div>`; }).join('')}
    <div class="g-legend"><span><i class="orig"></i>원래 일정 (10/03)</span><span><i class="ok"></i>−1일 이상 없음</span><span><i class="warn"></i>주의</span><span><i class="crit"></i>위험</span><span><i class="rec"></i>권장 조정</span><span><i class="nowl"></i>지금</span></div></div>`;
}
async function flowPmPull() {
  await think([
    { t: '의도 파싱', who: 'LLM', d: 'PM 일정 조정 검토 · 대상: 10/03 예정 PM 9대 → 10/02(오늘)로 −1일 · <b>검토만, 반영 없음</b>' },
    { t: '영향 데이터 수집', who: 'Jev', d: '대상 설비 대기열 41랏 · Q-time 걸린 랏 7 · 핫랏 경로 1 · PM 인력 2교대 · 파트 재고' },
    { t: '디지털트윈 What-if', who: 'Twin', d: '오늘 17:24 → 내일 17:24 · PM 9대 이동 반영 · 5 seeds', sim: true },
    { t: '리스크 판정', who: 'Guard', d: '이슈 3건 (Critical 1 · Warning 2) · 나머지 5대 이상 없음', issue: true },
  ], 'PM 일정 점검 중').run();
  PM_ROWS.forEach(r => byId[r.id].tag = { text: r.v === 'crit' ? 'PM 충돌' : r.v === 'warn' ? 'PM 주의' : 'PM OK', color: r.v === 'crit' ? '#ff4d5e' : r.v === 'warn' ? '#ffb020' : '#36d98e' });
  setArea(null); camT = fitCam();
  await aiText('앞당기는 것 자체는 가능하지만 <strong>이슈 3건</strong>이 있습니다. 특히 <strong>ETCH-03</strong>은 핫랏 L2417이 대기 중이라 그대로 당기면 <strong>납기(D-2)를 놓칩니다</strong>. 시간대만 살짝 조정하면 9대 모두 24시간 안에 끝낼 수 있어요.', true);
  const card = aiBlock(`<div class="card"><div class="card-h"><span class="tagb a">PM CHECK</span>PM 앞당김 사전 점검<span class="sub">9대 · 10/03 → 10/02</span></div>
    ${ganttHtml()}
    <div class="iss"><span class="sev CRIT">CRITICAL</span><span><b>ETCH-03</b> 핫랏 L2417 포함 대기 6랏 · 대체 설비 ETCH-04/05 가동률 96%↑ → L2417 TAT <b>+9.4h</b>, 납기 D-2 위반</span></div>
    <div class="iss"><span class="sev WARN">WARN</span><span><b>PHOTO-06 · 07</b> 동시 PM → 18~01시 EUV 가용 2/4대, PHOTO 대기 WIP <b>+38%</b></span></div>
    <div class="iss"><span class="sev WARN">WARN</span><span><b>CMP-05</b> 패드 컨디셔너 재고 0 · 입고 예정 18:40 → 18:00 착수 불가</span></div>
    <div class="iss"><span class="sev OK">OK</span><span><b>DEPO-04 · DEPO-07 · IMP-02 · CLEAN-07 · METRO-05</b> 이상 없음</span></div>
    <div class="wf-rows"><div class="wf-head"><span>오늘 영향 (24h)</span><span>단순 −1일</span><span></span><span>권장안</span><span>Δ</span></div>
      <div class="wf-row"><span class="wf-k">Moves / h</span><span class="wf-a mono">−2.5%</span><span class="wf-arrow">→</span><span class="wf-b mono">−0.7%</span><span class="wf-d mono good">+1.8p</span></div>
      <div class="wf-row"><span class="wf-k">Q-time 위반 예상</span><span class="wf-a mono">11</span><span class="wf-arrow">→</span><span class="wf-b mono">7</span><span class="wf-d mono good">−4</span></div>
      <div class="wf-row"><span class="wf-k">핫랏 납기 위반</span><span class="wf-a mono">1</span><span class="wf-arrow">→</span><span class="wf-b mono">0</span><span class="wf-d mono good">−1</span></div>
      <div class="wf-row"><span class="wf-k">24h 내 PM 완료</span><span class="wf-a mono">9 / 9</span><span class="wf-arrow">→</span><span class="wf-b mono">9 / 9</span><span class="wf-d mono neu">유지</span></div>
    </div>
    <div class="verdict good">${ic('check')}<div><b>권장안</b> — ETCH-03은 L2417 통과 후 <b>22:40</b> 착수, PHOTO-07은 야간 슬롯 <b>02:00</b>, CMP-05는 파트 입고 후 <b>19:00</b> 착수</div></div>
    <div class="actions"><button class="btn primary" data-x="rec">${ic('check')}권장안으로 PM 일정 반영</button><button class="btn" data-x="show">권장안 미리보기</button><button class="btn danger" data-x="raw">단순 −1일 그대로</button></div></div>`);
  const preview = () => $$('.g-bar.prop', card).forEach(b => { if (!b.classList.contains('ok')) { b.style.left = (b.dataset.rec / 40 * 100) + '%'; b.className = 'g-bar prop rec'; } });
  $('[data-x=show]', card).onclick = e => { preview(); e.currentTarget.disabled = true; };
  $('[data-x=rec]', card).onclick = async e => {
    preview(); $$('[data-x]', card).forEach(b => b.disabled = true); e.currentTarget.innerHTML = ic('check') + '반영됨';
    PM_ROWS.forEach(r => byId[r.id].tag = { text: r.v === 'ok' ? `PM ${pad(r.hod | 0)}:${r.hod % 1 ? '30' : '00'}` : r.id === 'ETCH-03' ? 'PM 22:40' : r.id === 'PHOTO-07' ? 'PM 02:00' : r.id === 'CMP-05' ? 'PM 19:00' : 'PM 18:00', color: '#4d8dff' });
    setTimeout(() => PM_ROWS.forEach(r => { if (byId[r.id].tag?.color === '#4d8dff') byId[r.id].tag = null; }), 20000);
    policies.unshift({ id: 'POL-0146', type: 'PM_RESCHEDULE', src: '10/03 PM 9대 하루 앞당김 (권장안: 3대 시간 조정)', status: 'ACTIVE', at: hms().slice(0, 5), impact: 'Moves −0.7%' });
    renderPolicies('POL-0146'); $('#polVer').textContent = 'v2.43';
    addEvent('AI', 'POL-0146', 'PM 일정 9대 −1일 반영 · MES PM 캘린더 동기화', '승인됨');
    toast('green', 'check', 'PM 일정 반영 · 9대', 'MES PM 캘린더 동기화 · Jev가 PM 전 대기열 선제 분산 시작');
    aiBlock(`<div class="applied"><div class="applied-h"><span class="ok">${ic('check')}</span>PM 일정 반영 완료<span class="sub">POL-0146 · v2.43</span></div>
      <ul><li>MES PM 캘린더 9건 갱신 · 정비팀 작업 지시 발행</li><li>Jev: PM 2h 전부터 대상 설비 <b>신규 투입 중단</b> → 동일 자격 설비로 분산</li><li><b>ETCH-03</b>은 L2417 완료 이벤트 수신 시 PM 자동 착수</li></ul></div>`);
  };
  $('[data-x=raw]', card).onclick = async () => {
    $$('[data-x]', card).forEach(b => b.disabled = true);
    msg('user', '그냥 하루씩 다 당겨');
    await aiText('CRITICAL 이슈(핫랏 납기 위반)가 포함되어 있어 <strong>생산관리자 승인</strong>이 필요합니다. 근거 리포트와 함께 승인 요청을 보냈습니다. <span class="mono">(APR-0391)</span>');
    addEvent('AI', 'APR-0391', 'PM −1일 원안 승인 요청 · CRITICAL 1건 포함', '대기');
  };
}

// ---- flow: 내일 08시 FAB 예측
let forecastSnap = null;
function forecastRestore() {
  if (!forecastSnap) return;
  forecastSnap.forEach(([t, s, q, tag]) => { t.state = s; t.queue = q; t.tag = tag; t.forced = false; });
  forecastSnap = null; mapEl.classList.remove('forecast');
  $('.sandbox-badge').textContent = 'SANDBOX · 실제 운영과 분리된 트윈 복제본';
  $('#mode [data-mode=live]').click();
}
async function flowForecast() {
  await think([
    { t: '의도 파싱', who: 'LLM', d: '예측 질의 · 시점 10/03 08:00 (T+14.6h) · 범위 FAB 전체' },
    { t: '상태 스냅샷', who: 'Twin', d: `설비 ${tools.length} · 랏 1,284 · OHT ${vehicles.length} · 예정 PM 9 · 투입 계획 MPS v4.12` },
    { t: '선행 시뮬레이션', who: 'Twin', d: 'T+14.6h · 10 seeds · 교대(07:00) · PM 일정 · 투입 계획 반영', sim: true, ms: 3800 },
    { t: '위험 요약', who: 'LLM', d: '08:00 기준 위험 3건 추출 · 선제 조치 2건 생성' },
  ], '미래 상태 예측 중').run();
  forecastSnap = tools.map(t => [t, t.state, t.queue, t.tag]);
  $('#mode [data-mode=sandbox]').click();
  mapEl.classList.add('forecast');
  $('.sandbox-badge').textContent = 'FORECAST · 10/03 08:00 예측 상태 (T+14.6h)';
  ['PHOTO-06', 'PHOTO-07', 'DEPO-04', 'IMP-02'].forEach(id => { byId[id].state = 'PM'; byId[id].forced = true; });
  ['CMP-02', 'ETCH-09'].forEach(id => { byId[id].state = 'DOWN'; byId[id].forced = true; byId[id].tag = { text: '다운 확률 34%', color: '#ff4d5e' }; });
  tools.filter(t => t.area === 'PHOTO' || t.area === 'CMP').forEach(t => t.queue = Math.min(6, t.queue + 2));
  byId['PHOTO-05'].tag = { text: '08시 병목', color: '#ffb020' };
  layers.heat = true; $('#layers [data-l=heat]').classList.add('on');
  setArea(null); camT = fitCam();
  await aiText('지금 맵은 <strong>내일 08:00 예측 상태</strong>입니다. <strong>07:00 교대 직후 + PHOTO PM 겹침</strong>으로 06–08시에 Moves 저점이 예상되고, <strong>CMP-02</strong>는 패드 수명 추세상 다운 확률이 34%까지 올라갑니다.', true);
  whatifCard({
    title: '내일 08:00 예측', sub: 'T+14.6h · 10 seeds', cols: ['지금', '08:00'],
    rows: [
      { k: 'Moves / h', a: '4,812', b: '4,655', d: '−3.3%', g: -1 },
      { k: 'WIP', a: '24,382', b: '24,910', d: '+2.2%', g: -1 },
      { k: '설비 가동률', a: '87.4%', b: '84.1%', d: '−3.3p', g: -1 },
      { k: 'Q-time 위험', a: '6', b: '11', d: '+5', g: -1 },
      { k: '핫랏 정상 진행', a: '12/12', b: '11/12', d: '−1', g: -1 },
    ],
    chart: { label: 'Moves / h 예측', a: series(25, k => 4812 + Math.sin(k * 8) * 25), b: series(25, k => 4812 - 160 * Math.exp(-Math.pow((k - .88) * 5, 2)) - 40 * k + Math.sin(k * 13) * 20), color: '#a98bff', xl: ['지금', '21시', '01시', '05시', '08시'] },
    verdict: { kind: 'warn', text: '<b>선제 조치 권장</b> — PHOTO PM 분산 + CMP-02 패드 교체를 오늘 야간에 당기면 08:00 Moves 4,655 → <b>4,790</b> 회복 예상' },
    actions: [
      { label: 'PM 일정 조정 검토', cls: 'primary', icon: 'flask', on: () => { forecastRestore(); send('PM 일정 하루 앞당길건데 이슈 없는지 알려줘'); } },
      { label: '현재 상태로 돌아가기', on: (b, el) => { lockActions(el); forecastRestore(); camT = fitCam(); } },
    ],
  });
}

// ---- router
async function send(text) {
  text = (text ?? input.value).trim();
  if (!text || busy) return;
  input.value = ''; busy = true; sentAt = performance.now();
  sendBtn.classList.add('busy'); setLLM(true);
  msg('user', esc(text));
  if (forecastSnap) forecastRestore();
  tools.forEach(t => { if (t.tag && !t.tag.keep) t.tag = null; });
  await sleep(350);
  try {
    if (/물량|수요|planning|플래닝|엔비디아|nvidia|고객/i.test(text)) await flowPlan(text);
    else if (/예측|내일 아침|미리 보/i.test(text)) await flowForecast(text);
    else if (/앞당|당겨|당기|당길|조정|겹치/i.test(text)) await flowPmPull(text);
    else if (/PM|미뤄|미루|연기|스킵|skip/i.test(text)) await flowRisky(text);
    else if (/다운|고장|멈추|down/i.test(text)) await flowDown(text);
    else if (/핫|hot|우선|제한|부하|분산/i.test(text)) await flowHot(text);
    else if (/어디|병목|왜|\?|알려|상태|어때/i.test(text)) await flowAsk(text);
    else await flowHot(text);
  } finally {
    busy = false; sendBtn.classList.remove('busy'); setLLM(false);
  }
}
sendBtn.onclick = () => send();
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

const CHIPS = [
  ['k5', 'PLANNING', '엔비디아 물량 +20% → FAB Planning 수정', '엔비디아 고객에서 물량 20% 요구사항 올렸는데 FAB Planning 수정해줘'],
  ['k6', 'PM CHECK', 'PM 하루 앞당길 건데 이슈 없어?', 'PM 일정 하루 앞당길건데 이슈 없는지 알려줘'],
  ['k7', 'FORECAST', '내일 아침 8시 FAB 상황 미리 보기', '내일 아침 8시 FAB 상황 예측해서 보여줘'],
  ['k1', 'POLICY', 'L2417 핫랏 최우선 + ETCH-03 부하 80% 제한', 'L2417 핫랏 최우선으로 처리하고 ETCH-03 부하는 80% 이하로 제한해줘'],
  ['k2', 'WHAT-IF', 'CMP-02 지금 다운되면 영향은?', 'CMP-02 지금 다운되면 영향은?'],
  ['k3', 'RISKY', 'ETCH 베이 PM 전부 내일로 미뤄', 'ETCH 베이 PM 전부 내일로 미뤄줘'],
  ['k4', 'ASK', '지금 병목 공정 어디야?', '지금 병목 공정 어디야?'],
];
$('#chips').innerHTML = CHIPS.map(([k, tag, label], i) => `<button class="${k}" data-i="${i}"><i>${tag}</i>${label}</button>`).join('');
$('#chips').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); e.currentTarget.scrollLeft += e.deltaY; } }, { passive: false });
$$('#chips button').forEach(b => b.onclick = () => send(CHIPS[b.dataset.i][3]));

// seed conversation
chatEl.innerHTML = `<div class="divider">오늘 15:20</div>`;
msg('user', 'PHOTO 베이 PM은 새벽 2시~6시에 몰아서 해줘');
aiBlock(`<div class="applied compact"><div class="applied-h"><span class="ok">${ic('check')}</span>PM_WINDOW 정책 적용됨<span class="sub">POL-0139 · 지시→반영 41s</span></div></div>`).classList.remove('cont');
chatEl.insertAdjacentHTML('beforeend', `<div class="divider">지금</div>`);
msg('ai', `안녕하세요, <strong>FAB-M1 운영 Copilot</strong>입니다.<p>자연어로 지시하면 <strong>LLM</strong>이 타입 정책으로 변환하고, <strong>디지털트윈</strong>에서 영향을 먼저 검증한 뒤, 승인 시 <strong>Jev</strong>가 이벤트 단위 실시간 판단에 반영합니다. 아래 예시를 눌러보세요.</p>`);

