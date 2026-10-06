'use strict';
/* =========================================================================
   Digital Twin renderer — 3층 분해도(L3 Cleanroom / L2 Sub-fab / L1 Utility),
   공정별 설비 형상, 양방향 Interbay + Intrabay OHT (가감속·차간거리·호이스트)
   ========================================================================= */

// ---------------------------------------------------------------- domain
const STATE = {
  RUN: { color: '#36d98e', ko: '가동' },
  IDLE: { color: '#64748b', ko: '대기' },
  DOWN: { color: '#ff4d5e', ko: '다운' },
  PM: { color: '#4d8dff', ko: '예방정비' },
};
const AREAS = {
  PHOTO: { name: '포토', color: '#f5c542' },
  ETCH: { name: '식각', color: '#ff7a59' },
  DEPO: { name: '증착', color: '#4fd1c5' },
  DIFF: { name: '확산', color: '#ff5fa2' },
  CLEAN: { name: '세정', color: '#9be15d' },
  CMP: { name: 'CMP', color: '#7aa2ff' },
  IMP: { name: '이온주입', color: '#b48cff' },
  METRO: { name: '계측', color: '#c0c8d6' },
};
const LEVELS = [
  { id: 'L3', name: 'CLEANROOM', sub: 'Class 1 · 공정 설비 · OHT', color: '#3ee0ff' },
  { id: 'L2', name: 'SUB-FAB', sub: '진공펌프 · 스크러버 · 덕트', color: '#a98bff' },
  { id: 'L1', name: 'UTILITY', sub: 'UPW · 약품 · 냉각 · 전력', color: '#ffb020' },
];
const WORLD = { w: 84.5, h: 52 }, CX = WORLD.w / 2, CY = WORLD.h / 2, RZ = 6.3, GAP = 10.5;

// ---------------------------------------------------------------- color helpers
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const sh = (c, f) => `rgb(${Math.min(255, c[0] * f) | 0},${Math.min(255, c[1] * f) | 0},${Math.min(255, c[2] * f) | 0})`;
const C = {
  body: rgb('#34465c'), efem: rgb('#44576f'), ch: rgb('#55677f'), dark: rgb('#26334a'), track: rgb('#2f4157'),
  stk: rgb('#2a3c55'), pump: rgb('#2e3a4c'), euv: rgb('#4a3f70'), amber: rgb('#ffb020'), foup: rgb('#c9d6e6'),
  vEmpty: rgb('#7d8ea6'), vCarry: rgb('#dfe9f5'), platen: rgb('#5d7088'),
};
const tint = (area, base = C.body, k = .14) => area ? mixc(base, rgb(AREAS[area].color), k) : base;

// ---------------------------------------------------------------- model
const tools = [], stockers = [], utils2 = [], utils1 = [], byId = {}, counters = {};
let lotSeq = 2300;
const newLot = () => `L${++lotSeq}`;

function bboxOf(parts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, h = 0;
  for (const p of parts) {
    if (p.t === 'cyl' || p.t === 'head') { x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r); y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r); }
    else if (p.t === 'gantry') { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x1 + p.w); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + p.d); }
    else { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + p.w); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + p.d); }
    h = Math.max(h, p.z + p.h);
  }
  return { x: x0, y: y0, w: x1 - x0, d: y1 - y0, h };
}
function mk(area, kind, model, parts, o = {}) {
  const id = o.id || `${area}-${pad(counters[area] = (counters[area] || 0) + 1)}`;
  const b = bboxOf(parts);
  return Object.assign({ id, area, kind, model, parts, ...b, cx: b.x + b.w / 2, cy: b.y + b.d / 2, level: 'L3', state: 'RUN', util: 80, queue: 0, hot: false, lot: null, recipe: '', pmDue: 0, tag: null, flash: 0, ph: rnd() * 6 }, o);
}
function addTool(t) {
  const roll = rnd();
  t.state = roll < .06 ? 'DOWN' : roll < .13 ? 'PM' : roll < .26 ? 'IDLE' : 'RUN';
  t.util = t.state === 'RUN' ? R(68, 97) : t.state === 'IDLE' ? R(25, 60) : R(0, 15);
  t.queue = t.state === 'DOWN' ? RI(3, 6) : RI(0, 5);
  t.hot = rnd() < .09; t.lot = t.state === 'RUN' ? newLot() : null;
  t.recipe = `${t.area.slice(0, 2)}-M${RI(1, 9)}-${pad(RI(1, 140), 3)}`; t.pmDue = RI(2, 160);
  tools.push(t); byId[t.id] = t; return t;
}
const tower = (x, y, z) => ({ t: 'cyl', x, y, r: .11, z, h: .75, tower: true });

// ---- 설비 형상 빌더 (side: 'above' = 통로보다 위쪽(작은 y), 'below' = 아래쪽)
function clusterParts(xl, yEdge, side, n, big, area) {
  const hr = big ? 1.1 : .85, cr = big ? .85 : .72, reach = hr + cr + .08, ch = big ? 1.55 : 1.35;
  const ANG = { 3: [-150, -90, -30], 4: [-165, -115, -65, -15], 5: [-180, -135, -90, -45, 0] }[n];
  const half = Math.max(...ANG.map(a => Math.abs(Math.cos(a * Math.PI / 180)) * reach)) + cr;
  const cx = xl + half, up = side === 'above';
  const efemY = up ? yEdge - 1 : yEdge, hubY = up ? efemY - .15 - hr : yEdge + 1.15 + hr;
  const parts = [
    { t: 'box', x: cx - half + .3, y: efemY, w: 2 * half - .6, d: 1, z: 0, h: 1.55, c: tint(area, C.efem, .06), lamp: true },
    { t: 'cyl', x: cx, y: hubY, r: hr, z: 0, h: 1.05, c: tint(area, C.body) },
    tower(cx + half - .6, efemY + .5, 1.55),
  ];
  ANG.forEach(a => {
    const r = a * Math.PI / 180, px = cx + Math.cos(r) * reach, py = hubY + Math.sin(r) * reach * (up ? 1 : -1);
    parts.push({ t: 'cyl', x: px, y: py, r: cr, z: 0, h: ch, c: C.ch, plasma: true });
    parts.push({ t: 'box', x: px - .24, y: py - .24, w: .48, d: .48, z: ch, h: .38, c: C.dark });
  });
  return parts;
}
function photoParts(x, yEdge, side, euv) {
  const D = euv ? 5.8 : 4.6, SW = euv ? 4.2 : 3.4, H = euv ? 3.1 : 2.6, TW = euv ? 1.7 : 1.4, TH = euv ? 2.1 : 1.9, up = side === 'above';
  const y = up ? yEdge - D : yEdge, sx = x + TW + .15;
  const parts = [
    { t: 'box', x, y, w: TW, d: D, z: 0, h: TH, c: C.track },
    { t: 'box', x: sx, y, w: SW, d: D, z: 0, h: H, c: tint('PHOTO', C.body, .1) },
    { t: 'box', x: sx + .4, y: up ? y + .4 : y + D * .5 - .4, w: SW - .8, d: D * .5, z: H, h: .55, c: C.efem, lamp: true },
    tower(x + .3, up ? y + D - .3 : y + .3, TH),
  ];
  for (let k = 0; k < 3; k++) parts.push({ t: 'cyl', x: x + TW / 2, y: y + D * (k + .5) / 3, r: .3, z: TH, h: .08, c: C.dark });
  if (euv) parts.push({ t: 'cyl', x: sx + SW / 2, y: up ? y + 1 : y + D - 1, r: .82, z: 0, h: H + .9, c: C.euv, euv: true });
  return parts;
}
function furnaceParts(x, yEdge, side, h) {
  const D = 3, up = side === 'above', yT = up ? yEdge - .85 - D : yEdge + .85, yL = up ? yEdge - .85 : yEdge;
  return [
    { t: 'box', x, y: yT, w: 1.5, d: D, z: 0, h, c: tint('DIFF', C.body, .1) },
    { t: 'band', x: x - .05, y: yT - .05, w: 1.6, d: D + .1, z: h * .58, h: .26 },
    { t: 'cyl', x: x + .75, y: yT + D / 2, r: .36, z: h, h: .6, c: C.dark },
    { t: 'box', x: x + .1, y: yL, w: 1.3, d: .85, z: 0, h: 1.15, c: C.efem, lamp: true },
    tower(x + 1.2, yL + .4, 1.15),
  ];
}
function benchParts(x, y, w) {
  return [
    { t: 'box', x, y, w, d: 1.8, z: 0, h: 1.35, c: tint('CLEAN', C.body, .12), tanks: 7 },
    { t: 'gantry', x: x + .1, x1: x + w - .8, y: y - .08, w: .7, d: 1.96, z: 1.35, h: .5 },
    tower(x + w - .3, y + .3, 1.35),
  ];
}
function swCleanParts(x, y) {
  return [
    { t: 'box', x, y, w: 3.2, d: 2.4, z: 0, h: 1.8, c: tint('CLEAN', C.body, .1) },
    { t: 'box', x: x + .3, y: y + .3, w: 2.6, d: 1.1, z: 1.8, h: .42, c: C.efem, lamp: true },
    tower(x + 2.9, y + 2.1, 1.8),
  ];
}
function cmpParts(x, yEdge, side) {
  const up = side === 'above', yP = up ? yEdge - 1.3 - 3 : yEdge + 1.3, yC = up ? yEdge - 1.3 : yEdge;
  const parts = [
    { t: 'box', x, y: yP, w: 4.2, d: 3, z: 0, h: 1.25, c: tint('CMP', C.body, .12) },
    { t: 'box', x, y: yC, w: 4.2, d: 1.3, z: 0, h: 1.75, c: C.efem, lamp: true },
    tower(x + 3.9, yC + .65, 1.75),
  ];
  for (let k = 0; k < 3; k++) {
    parts.push({ t: 'cyl', x: x + .85 + k * 1.25, y: yP + 1.5, r: .55, z: 1.25, h: .1, c: C.platen, platen: true });
    parts.push({ t: 'head', x: x + .85 + k * 1.25, y: yP + 1.5, r: .2, z: 1.35, h: .4, ph: k * 2.1 });
  }
  return parts;
}
function impParts(x, yEdge, side) {
  const up = side === 'above';
  const yEnd = up ? yEdge - 1.8 : yEdge, yBeam = up ? yEdge - 4.8 : yEdge + 1.8, ySrc = up ? yEdge - 6.6 : yEdge + 4.8;
  return [
    { t: 'box', x, y: ySrc, w: 2.6, d: 1.8, z: 0, h: 2.2, c: tint('IMP', C.body, .14) },
    { t: 'box', x: x + .75, y: yBeam, w: 1.1, d: 3, z: 0, h: 1.3, c: C.dark },
    { t: 'cyl', x: x + 1.3, y: yBeam + 1.5, r: .82, z: 0, h: 1.75, c: C.euv },
    { t: 'box', x, y: yEnd, w: 2.6, d: 1.8, z: 0, h: 2, c: C.efem, lamp: true },
    tower(x + 2.3, yEnd + .9, 2),
  ];
}
function cvdParts(x, yEdge, side) {
  const up = side === 'above', yE = up ? yEdge - 1 : yEdge, yB = up ? yE - 3.2 : yEdge + 1;
  return [
    { t: 'box', x, y: yB, w: 3.4, d: 3.2, z: 0, h: 1.4, c: tint('DEPO', C.body, .12) },
    { t: 'cyl', x: x + .95, y: yB + 1.6, r: .72, z: 1.4, h: .6, c: C.ch, plasma: true },
    { t: 'cyl', x: x + 2.45, y: yB + 1.6, r: .72, z: 1.4, h: .6, c: C.ch, plasma: true },
    { t: 'box', x: x + .2, y: yE, w: 3, d: 1, z: 0, h: 1.55, c: C.efem, lamp: true },
    tower(x + 3, yE + .5, 1.55),
  ];
}
function metroParts(x, y) {
  return [
    { t: 'box', x, y, w: 1.7, d: 1.7, z: 0, h: 1.2, c: tint('METRO', C.body, .1), lamp: true },
    { t: 'cyl', x: x + .85, y: y + .85, r: .42, z: 1.2, h: .32, c: C.ch },
    tower(x + 1.5, y + .2, 1.2),
  ];
}

// ---- 레이아웃
const ZONES = [
  { area: 'PHOTO', x: 3.5, y: 2.5, w: 28, d: 17, aisle: 11, label: 'PHOTO · YELLOW ROOM' },
  { area: 'ETCH', x: 33.5, y: 2.5, w: 25.2, d: 17, aisle: 11, label: 'ETCH · A' },
  { area: 'DEPO', x: 60.5, y: 2.5, w: 22, d: 17, aisle: 11, label: 'DEPOSITION' },
  { area: 'DIFF', x: 3.5, y: 32.5, w: 17, d: 17, aisle: 41, label: 'DIFFUSION' },
  { area: 'CLEAN', x: 22, y: 32.5, w: 17, d: 17, aisle: 41, label: 'WET CLEAN' },
  { area: 'CMP', x: 40.5, y: 32.5, w: 16.2, d: 17, aisle: 41, label: 'CMP' },
  { area: 'IMP', x: 58, y: 32.5, w: 12.5, d: 17, aisle: 41, label: 'IMPLANT' },
  { area: 'ETCH', x: 72, y: 32.5, w: 10.5, d: 17, aisle: 41, label: 'ETCH · B' },
];
ZONES.forEach(z => { z.top = z.aisle < 26; z.eA = z.aisle - .8; z.eB = z.aisle + .8; });
const zoneOf = (x, y) => ZONES.find(z => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.d);
const place = (area, kind, model, parts, side, zone, extra = {}) => addTool(mk(area, kind, model, parts, { side, aisle: zone ? zone.aisle : null, ...extra }));

// 공용 계측 (Interbay 스파인)
[11.6, 14.2, 23.4, 26.0, 35.4, 38.0, 49.4, 52.0, 61.4, 73.6].forEach((x, i) => {
  const y = i % 2 ? 25.9 : 24.3;
  place('METRO', 'metro', pick(['CD-SEM', 'Overlay', 'Film Thickness', 'Defect Inspection']), metroParts(x, y), 'spine', null, { aisle: y + .85 });
});
{ // PHOTO
  const z = ZONES[0];
  [4.2, 10.95, 17.7, 24.45].forEach(x => place('PHOTO', 'photo', 'EUV Scanner + Track', photoParts(x, z.eA, 'above', true), 'above', z));
  [5.6, 11.9, 18.2, 24.5].forEach(x => place('PHOTO', 'photo', 'ArF-i Scanner + Track', photoParts(x, z.eB, 'below', false), 'below', z));
}
function row(z, side, x0, specs) {
  let x = x0;
  specs.forEach(([kind, n, big]) => {
    const yE = side === 'above' ? z.eA : z.eB;
    let parts, area = z.area, model;
    if (kind === 'etch') { parts = clusterParts(x, yE, side, n, big, area); model = pick(['Conductor Etch', 'Dielectric Etch', 'Poly Etch']); }
    else if (kind === 'pvd') { parts = clusterParts(x, yE, side, n, true, area); model = 'PVD Cluster'; }
    else if (kind === 'ald') { parts = clusterParts(x, yE, side, n, false, area); model = 'ALD'; }
    else if (kind === 'cvd') { parts = cvdParts(x, yE, side); model = 'PECVD'; }
    else if (kind === 'metro') { parts = metroParts(x, side === 'above' ? yE - 1.7 : yE); area = 'METRO'; model = 'Film Thickness'; }
    const t = place(area, kind, model, parts, side, z);
    x = t.x + t.w + .38;
  });
}
row(ZONES[1], 'above', 34.1, [['etch', 3], ['etch', 4], ['etch', 3], ['etch', 5], ['etch', 3]]);
row(ZONES[1], 'below', 34.1, [['etch', 4], ['etch', 3], ['etch', 5], ['etch', 3], ['etch', 4]]);
row(ZONES[2], 'above', 61.0, [['pvd', 5], ['cvd'], ['ald', 3], ['cvd'], ['metro']]);
row(ZONES[2], 'below', 61.3, [['cvd'], ['pvd', 4], ['cvd'], ['ald', 4]]);
{ // DIFF
  const z = ZONES[3];
  for (let i = 0; i < 8; i++) place('DIFF', 'furnace', i % 3 ? 'Vertical Furnace' : 'LP-CVD Furnace', furnaceParts(4.2 + i * 1.95, z.eA, 'above', R(4.3, 5.4)), 'above', z);
  for (let i = 0; i < 8; i++) place('DIFF', 'furnace', i % 4 ? 'Vertical Furnace' : 'RTP', furnaceParts(4.6 + i * 1.95, z.eB, 'below', R(4.1, 5.2)), 'below', z);
}
{ // CLEAN
  const z = ZONES[4];
  place('CLEAN', 'bench', 'Batch Wet Bench', benchParts(22.8, 34.1, 15.2), 'above', z);
  place('CLEAN', 'bench', 'Batch Wet Bench', benchParts(22.8, 37.7, 15.2), 'above', z);
  [22.8, 26.7, 30.6, 34.5].forEach(x => place('CLEAN', 'swclean', 'Single Wafer Clean', swCleanParts(x, 42.1), 'below', z));
  place('CLEAN', 'bench', 'Batch Wet Bench', benchParts(22.8, 46.6, 15.2), 'below', z);
}
{ // CMP
  const z = ZONES[5];
  [41.0, 46.0, 51.0].forEach(x => place('CMP', 'cmp', pick(['Cu CMP', 'Oxide CMP', 'W CMP']), cmpParts(x, z.eA, 'above'), 'above', z));
  [41.6, 46.6, 51.6].forEach(x => place('CMP', 'cmp', pick(['Cu CMP', 'Oxide CMP', 'W CMP']), cmpParts(x, z.eB, 'below'), 'below', z));
}
{ // IMP
  const z = ZONES[6];
  [58.5, 62.4, 66.3].forEach(x => place('IMP', 'imp', 'High-Current Implanter', impParts(x, z.eA, 'above'), 'above', z));
  [60.2, 64.4].forEach(x => place('IMP', 'imp', 'Medium-Current Implanter', impParts(x, z.eB, 'below'), 'below', z));
}
row(ZONES[7], 'above', 72.3, [['etch', 3], ['etch', 3]]);
row(ZONES[7], 'below', 72.6, [['etch', 3], ['etch', 3]]);

// Stocker (Interbay)
[6.4, 17.6, 29.6, 43.6, 56.4, 66.6, 77.4].forEach((x, i) => {
  const s = mk(null, 'stocker', 'Stocker · 240 FOUP', [
    { t: 'box', x, y: 24.5, w: 3.6, d: 3, z: 0, h: 5.4, c: C.stk, shelves: true },
    { t: 'box', x: x + .2, y: 24.7, w: 3.2, d: 2.6, z: 5.4, h: .3, c: C.efem },
    { t: 'box', x: x + .6, y: 24.05, w: 2.4, d: .45, z: 0, h: 1, c: C.efem },
    { t: 'box', x: x + .6, y: 27.5, w: 2.4, d: .45, z: 0, h: 1, c: C.efem },
  ], { id: `STK-${pad(i + 1)}`, stocker: true, fill: RI(55, 93) });
  stockers.push(s); byId[s.id] = s;
});

// 시나리오 고정 설비
Object.assign(byId['ETCH-03'], { state: 'RUN', util: 96.1, queue: 6, hot: true, lot: 'L2398', pmDue: 41 });
Object.assign(byId['ETCH-04'], { state: 'RUN', util: 71.8, queue: 2, hot: false });
Object.assign(byId['ETCH-05'], { state: 'RUN', util: 70.6, queue: 1, hot: false });
Object.assign(byId['CMP-02'], { state: 'RUN', util: 88.2, queue: 3 });
['PHOTO-01', 'PHOTO-02', 'PHOTO-03', 'PHOTO-04'].forEach(id => Object.assign(byId[id], { state: 'RUN', util: R(86, 95) }));

// ---- L2 Sub-fab
function addUtil(list, level, id, kind, parts, extra = {}) {
  const t = mk(null, kind, kind, parts, { id, level, util: R(55, 92), ...extra });
  list.push(t); byId[t.id] = t; return t;
}
tools.forEach(t => {
  const n = t.w > 4 ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const ox = n === 2 ? (k ? .7 : -1.6) : -.45;
    addUtil(utils2, 'L2', `VP-${t.id}${n === 2 ? '-' + (k + 1) : ''}`, 'Dry Vacuum Pump', [{ t: 'box', x: t.cx + ox, y: t.cy - .45, w: .9, d: .9, z: 0, h: .7, c: C.pump, led: true }], { owner: t.id });
  }
});
ZONES.forEach((z, zi) => {
  for (let k = 0; k < 4; k++) addUtil(utils2, 'L2', `SCR-${zi + 1}${k + 1}`, 'Local Scrubber', [{ t: 'cyl', x: z.x + 2 + k * (z.w - 4) / 3, y: z.top ? z.y + 1.2 : z.y + z.d - 1.2, r: .62, z: 0, h: 1.7, c: rgb('#3e4b5e') }]);
  addUtil(utils2, 'L2', `CHL-${zi + 1}`, 'Process Chiller', [{ t: 'box', x: z.x + z.w - 3.6, y: z.top ? z.aisle + 1.6 : z.aisle - 3.6, w: 2.6, d: 2, z: 0, h: 1.2, c: rgb('#2c4a60'), led: true }]);
  addUtil(utils2, 'L2', `DUCT-${zi + 1}`, 'Exhaust Branch Duct', [{ t: 'box', x: z.x + 1, y: z.aisle - .4, w: z.w - 2, d: .8, z: 0, h: .65, c: rgb('#384354') }]);
});
addUtil(utils2, 'L2', 'EXH-MAIN', 'Exhaust Main Trunk', [{ t: 'box', x: 2.5, y: 25.3, w: 79.5, d: 1.3, z: 0, h: 1.05, c: rgb('#3b4759') }]);
addUtil(utils2, 'L2', 'PCW-MAIN', 'PCW Supply Header', [{ t: 'box', x: 2.5, y: 27.3, w: 79.5, d: .5, z: 0, h: .5, c: rgb('#2b5a7c') }]);
addUtil(utils2, 'L2', 'N2-MAIN', 'N2 / CDA Header', [{ t: 'box', x: 2.5, y: 24.3, w: 79.5, d: .4, z: 0, h: .4, c: rgb('#2f6a52') }]);

// ---- L1 Utility
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) addUtil(utils1, 'L1', `CHEM-T${i * 3 + j + 1}`, 'Chemical Supply Tank', [{ t: 'cyl', x: 6.5 + i * 3.4, y: 6 + j * 3.6, r: 1.3, z: 0, h: 3.2, c: rgb('#3a4f63') }]);
addUtil(utils1, 'L1', 'UPW-01', 'UPW Plant · Polishing', [{ t: 'box', x: 20, y: 4, w: 7, d: 5, z: 0, h: 2.6, c: rgb('#2d4a63'), led: true }]);
addUtil(utils1, 'L1', 'UPW-02', 'UPW Plant · RO/EDI', [{ t: 'box', x: 28.5, y: 4, w: 6, d: 5, z: 0, h: 2.2, c: rgb('#2d4a63'), led: true }]);
addUtil(utils1, 'L1', 'UPW-03', 'UPW Storage', [{ t: 'box', x: 20, y: 11, w: 14.5, d: 4, z: 0, h: 1.8, c: rgb('#294259') }]);
for (let k = 0; k < 8; k++) addUtil(utils1, 'L1', `RO-${k + 1}`, 'RO Vessel', [{ t: 'cyl', x: 37 + k * 1.05, y: 6.5, r: .42, z: 0, h: 2.5, c: rgb('#3f5873') }]);
for (let k = 0; k < 4; k++) addUtil(utils1, 'L1', `CT-0${k + 1}`, 'Cooling Tower', [{ t: 'cyl', x: 52 + k * 7.6, y: 10, r: 2.6, z: 0, h: 3.3, c: rgb('#33465a'), fan: true }]);
for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) addUtil(utils1, 'L1', `SUB-${i * 2 + j + 1}`, 'Substation 22.9kV', [{ t: 'box', x: 5 + i * 5.6, y: 35 + j * 6.5, w: 4.2, d: 3.4, z: 0, h: 2.4, c: rgb('#3a3f4c'), led: true }]);
for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) addUtil(utils1, 'L1', `CH-${i * 2 + j + 1}`, 'Central Chiller', [{ t: 'box', x: 32 + i * 7, y: 35 + j * 6, w: 5.2, d: 3.2, z: 0, h: 2.1, c: rgb('#2c4a60'), led: true }]);
for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) addUtil(utils1, 'L1', `BG-${i * 2 + j + 1}`, 'Bulk Gas Tank (N2/O2/Ar)', [{ t: 'cyl', x: 61 + i * 3.6, y: 37 + j * 6, r: 1, z: 0, h: 5.4, c: rgb('#3d4b5e') }]);
addUtil(utils1, 'L1', 'MAIN-TRUNK', 'Utility Main Trunk', [{ t: 'box', x: 2.5, y: 25, w: 79.5, d: 2, z: 0, h: 1.2, c: rgb('#33404f') }]);
const L1_LABELS = [['CHEM SUPPLY', 9.9, 2.2], ['UPW PLANT', 27, 2.2], ['COOLING TOWER', 63.4, 5.6], ['SUBSTATION', 13, 33.2], ['CENTRAL CHILLER', 41, 33.2], ['BULK GAS', 68, 34.2]];

const OBJ = { L3: [...tools, ...stockers], L2: utils2, L1: utils1 };

// ---------------------------------------------------------------- OHT network
function rrect(x0, y0, x1, y1, r, rev = false, n = 6) {
  const pts = [], arc = (cx, cy, a0) => { for (let i = 0; i <= n; i++) { const a = (a0 + 90 * i / n) * Math.PI / 180; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  arc(x1 - r, y0 + r, -90); arc(x1 - r, y1 - r, 0); arc(x0 + r, y1 - r, 90); arc(x0 + r, y0 + r, 180);
  return rev ? pts.reverse() : pts;
}
function loopPath(pts, name) {
  const segs = []; let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    segs.push({ a, b, l, s: L }); L += l;
  }
  segs.forEach((g, i) => { const p = segs[(i + segs.length - 1) % segs.length]; const dot = ((g.b[0] - g.a[0]) * (p.b[0] - p.a[0]) + (g.b[1] - g.a[1]) * (p.b[1] - p.a[1])) / (g.l * p.l); g.curve = dot < .995; });
  return { pts, segs, L, name, veh: [], stops: [] };
}
function posOn(p, s) {
  s = ((s % p.L) + p.L) % p.L;
  for (const g of p.segs) if (s <= g.s + g.l) { const k = (s - g.s) / g.l; return [g.a[0] + (g.b[0] - g.a[0]) * k, g.a[1] + (g.b[1] - g.a[1]) * k]; }
  return p.pts[0];
}
function segAt(p, s) { for (const g of p.segs) if (s <= g.s + g.l) return g; return p.segs[0]; }
function nearestS(p, x, y) {
  let best = { d: 1e9, s: 0 };
  for (const g of p.segs) {
    const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], k = clamp(((x - g.a[0]) * dx + (y - g.a[1]) * dy) / (g.l * g.l), 0, 1);
    const px = g.a[0] + dx * k, py = g.a[1] + dy * k, d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, s: g.s + g.l * k };
  }
  return best;
}
const outer = loopPath(rrect(2, 21.6, 82.5, 30.4, 2.2), 'Interbay-Outer');
const inner = loopPath(rrect(2.8, 22.4, 81.7, 29.6, 1.6, true), 'Interbay-Inner');
const paths = [outer, inner], stubs = [];
ZONES.forEach(z => {
  const p = loopPath(rrect(z.x + .9, z.aisle - .55, z.x + z.w - .9, z.aisle + .55, .55), `Intrabay-${z.label}`);
  p.zone = z; paths.push(p);
  [z.x + 1.5, z.x + z.w - 1.5].forEach(x => stubs.push([[x, z.top ? z.aisle + .55 : z.aisle - .55], [x, z.top ? 21.6 : 30.4]]));
  tools.filter(t => t.aisle === z.aisle && zoneOf(t.cx, t.cy) === z).forEach(t => {
    const r = nearestS(p, t.cx, t.side === 'above' ? z.aisle - .55 : z.aisle + .55);
    p.stops.push({ s: r.s, tool: t });
  });
});
stockers.forEach(s => { outer.stops.push({ s: nearestS(outer, s.cx, 21.6).s, tool: s }); inner.stops.push({ s: nearestS(inner, s.cx, 29.6).s, tool: s }); });
tools.filter(t => t.side === 'spine').forEach(t => inner.stops.push({ s: nearestS(inner, t.cx, t.cy < 25 ? 22.4 : 29.6).s, tool: t }));

const vehicles = [];
let ohtSeq = 100;
function addVehicle(p, s, vmax) {
  const v = { id: `OHT-${++ohtSeq}`, path: p, s, v: vmax * .6, vmax, state: 'move', ht: 0, target: null, tool: null, carry: rnd() < .6, hot: rnd() < .07, trail: [], tt: 0 };
  p.veh.push(v); vehicles.push(v); pickTarget(v); return v;
}
function pickTarget(v) {
  const p = v.path;
  const cands = p.stops.filter(st => { const d = (st.s - v.s + p.L) % p.L; return d > 4 && d < p.L * .75; });
  if (cands.length && rnd() < (p === outer || p === inner ? .45 : .85)) { const st = pick(cands); v.target = st.s; v.tool = st.tool; }
  else { v.target = null; v.tool = null; }
}
for (let i = 0; i < 18; i++) addVehicle(outer, i * outer.L / 18, R(5.2, 6.4));
for (let i = 0; i < 14; i++) addVehicle(inner, i * inner.L / 14, R(4.6, 5.8));
paths.slice(2).forEach(p => { const n = p.zone.w > 15 ? 3 : 2; for (let k = 0; k < n; k++) addVehicle(p, k * p.L / n + R(0, 2), R(2.6, 3.6)); });
let jam = null; // { x0, x1, until }

function updateVehicles(dt, now) {
  const boost = sim.on ? 2.4 : 1;
  for (const p of paths) {
    const vs = p.veh; vs.sort((a, b) => a.s - b.s);
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i], ahead = vs[(i + 1) % vs.length];
      const gap = vs.length > 1 ? ((ahead.s - v.s + p.L) % p.L) : 1e9;
      if (v.state === 'hoist') {
        const pv = v.ht; v.ht += dt * boost;
        if (pv < 1 && v.ht >= 1 && v.tool) v.tool.flash = now;
        if (v.ht >= 2) { v.state = 'move'; v.carry = !v.carry; v.ht = 0; pickTarget(v); }
        continue;
      }
      let lim = v.vmax * (segAt(p, v.s).curve ? .42 : 1) * boost;
      if (jam && p === outer) { const [x, y] = posOn(p, v.s); if (y < 23 && x > jam.x0 && x < jam.x1) lim *= .05; }
      let dist = 1e9, tLim = 1e9;
      if (v.target != null) { dist = (v.target - v.s + p.L) % p.L; tLim = Math.sqrt(2 * 7 * Math.max(0, dist - .01)); }
      const want = Math.min(lim, Math.max(0, gap - 1.15) * 2.4, tLim);
      const dv = want - v.v;
      v.v = Math.max(0, v.v + (dv > 0 ? Math.min(dv, 3.4 * dt * boost) : Math.max(dv, -14 * dt)));
      let step = Math.min(v.v * dt, Math.max(0, gap - 1));
      if (v.target != null) step = Math.min(step, dist);
      v.s = (v.s + step) % p.L;
      if (v.target != null && dist - step < .06 && v.v < .8) {
        v.v = 0; v.s = v.target; v.target = null;
        if (v.tool) { v.state = 'hoist'; v.ht = 0; } else pickTarget(v);
      }
      v.tt += dt;
      if (v.tt > .05) { v.tt = 0; v.trail.push(posOn(p, v.s)); if (v.trail.length > 18) v.trail.shift(); }
    }
  }
}

// ---------------------------------------------------------------- camera / projection
const mapEl = $('#map'), canvas = $('#fab'), ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = 1, userMoved = false;
const cam = { z: 8, ox: 0, oy: 0 }; let camT = null;
let rot = 0, rotT = 0, rc = 1, rs = 0, autoOrbit = false;
const NX = [0, 0, 0, 0], NY = [0, 0, 0, 0], N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
function setRot(a) { rot = a; rc = Math.cos(a); rs = Math.sin(a); N4.forEach((n, i) => { NX[i] = n[0] * rc - n[1] * rs; NY[i] = n[0] * rs + n[1] * rc; }); }
setRot(0);
const layers = { oht: true, lots: true, utility: true, heat: false, alarm: true, labels: true };
let hover = null, selected = null, hoverArea = null, route = null, sandbox = false;
const lv = { L3: { z: 0, a: 1, tz: 0, ta: 1 }, L2: { z: -GAP, a: 1, tz: -GAP, ta: 1 }, L1: { z: -GAP * 2, a: 1, tz: -GAP * 2, ta: 1 } };
let levelMode = 'ALL';

const P = (x, y, z = 0) => { const dx = x - CX, dy = y - CY, rx = dx * rc - dy * rs, ry = dx * rs + dy * rc; return [(rx - ry) * .866 * cam.z + cam.ox, (rx + ry) * .5 * cam.z - z * cam.z * .82 + cam.oy]; };
const depth = (x, y) => { const dx = x - CX, dy = y - CY; return dx * (rc + rs) + dy * (rc - rs); };

function camFor(cx, cy, z) { const dx = cx - CX, dy = cy - CY, rx = dx * rc - dy * rs, ry = dx * rs + dy * rc; return { z, ox: W / 2 - (rx - ry) * .866 * z, oy: H / 2 + 20 - (rx + ry) * .5 * z }; }
function fitCam() {
  const zs = levelMode === 'ALL' ? [lv.L1.tz - .5, RZ + 1] : [-.5, RZ + 1];
  let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
  for (const [x, y] of [[0, 0], [WORLD.w, 0], [0, WORLD.h], [WORLD.w, WORLD.h]]) for (const z of zs) {
    const dx = x - CX, dy = y - CY, rx = dx * rc - dy * rs, ry = dx * rs + dy * rc, sx = (rx - ry) * .866, sy = (rx + ry) * .5 - z * .82;
    a = Math.min(a, sx); b = Math.max(b, sx); c = Math.min(c, sy); d = Math.max(d, sy);
  }
  const z = Math.max(3, Math.min((W - 30) / (b - a), (H - 50) / (d - c)) * (levelMode === 'ALL' ? 1.12 : 1.02));
  return { z, ox: W / 2 - (a + b) / 2 * z, oy: H / 2 - (c + d) / 2 * z + 12 };
}
function resize() {
  const r = mapEl.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1; W = r.width; H = r.height;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  if (!userMoved && W > 100 && H > 100) { Object.assign(cam, fitCam()); camT = null; }
}
new ResizeObserver(resize).observe(mapEl);

function setLevel(m) {
  levelMode = m;
  const order = ['L3', 'L2', 'L1'];
  order.forEach((id, i) => {
    if (m === 'ALL') { lv[id].tz = -GAP * i; lv[id].ta = 1; }
    else { const mi = order.indexOf(m); lv[id].tz = i === mi ? 0 : (i < mi ? 16 : -16); lv[id].ta = i === mi ? 1 : 0; }
  });
  $$('#levels button').forEach(b => b.classList.toggle('on', b.dataset.level === m));
  camT = fitCam(); hideToolCard?.();
}

// ---------------------------------------------------------------- primitives
function poly(pts, fill, stroke, lw = 1) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
const rect = (x, y, w, d, z = 0) => [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)];
function box(x, y, w, d, z, h, c, k = 1, edge = true) {
  const Cn = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
  const lo = Cn.map(q => P(q[0], q[1], z)), hi = Cn.map(q => P(q[0], q[1], z + h));
  for (let i = 0; i < 4; i++) {
    const s = NX[i] + NY[i]; if (s <= 1e-3) continue;
    const f = (.5 + .34 * ((NX[i] - NY[i]) / 1.4142 * .5 + .5)) * k;
    poly([lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i]], sh(c, f));
  }
  poly(hi, sh(c, 1.14 * k), edge ? 'rgba(200,225,255,.12)' : null);
  return hi;
}
function cyl(cx, cy, r, z, h, c, top, k = 1) {
  const [bx, by] = P(cx, cy, z), [tx, ty] = P(cx, cy, z + h), rx = r * 1.2247 * cam.z, ry = r * .7071 * cam.z;
  if (rx < .4) return [tx, ty, rx, ry];
  ctx.beginPath(); ctx.moveTo(bx + rx, by); ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI); ctx.lineTo(tx - rx, ty); ctx.ellipse(tx, ty, rx, ry, 0, Math.PI, 0, true); ctx.closePath();
  const g = ctx.createLinearGradient(tx - rx, 0, tx + rx, 0);
  g.addColorStop(0, sh(c, .5 * k)); g.addColorStop(.55, sh(c, .82 * k)); g.addColorStop(1, sh(c, .6 * k));
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = top || sh(c, 1.15 * k); ctx.fill();
  ctx.strokeStyle = 'rgba(200,225,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
  return [tx, ty, rx, ry];
}
const partDepth = p => p.t === 'gantry' ? depth(p.x + (p.x1 - p.x) / 2, p.y + p.d / 2) : (p.t === 'cyl' || p.t === 'head') ? depth(p.x, p.y) : depth(p.x + p.w / 2, p.y + p.d / 2);

// ---------------------------------------------------------------- drawing
function drawPart(p, t, now, zl, k) {
  const st = STATE[t.state], run = t.state === 'RUN';
  if (p.t === 'box') {
    const hi = box(p.x, p.y, p.w, p.d, zl + p.z, p.h, p.c, k);
    if (p.lamp && t.level === 'L3') {
      let a = .9; if (t.state === 'DOWN') a = .45 + .55 * Math.abs(Math.sin(now / 260));
      const ix = Math.min(.35, p.w * .2), iy = Math.min(.25, p.d * .2);
      poly(rect(p.x + ix, p.y + iy, p.w - ix * 2, p.d - iy * 2, zl + p.z + p.h), hexA(st.color, a * .85));
    }
    if (p.led) poly(rect(p.x + p.w * .15, p.y + p.d * .15, Math.min(.3, p.w * .2), Math.min(.3, p.d * .2), zl + p.z + p.h), `rgba(54,217,142,${.5 + .5 * Math.sin(now / 300 + t.ph)})`);
    if (p.tanks) for (let i = 0; i < p.tanks; i++) {
      const tw = (p.w - .6) / p.tanks;
      poly(rect(p.x + .3 + i * tw + .08, p.y + .35, tw - .16, p.d - .7, zl + p.z + p.h), `rgba(${i % 2 ? '80,200,230' : '120,230,190'},${.35 + .15 * Math.sin(now / 500 + i)})`);
    }
    if (p.shelves && cam.z > 6) {
      ctx.strokeStyle = 'rgba(120,165,215,.2)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let j = 1; j < 7; j++) { const z = zl + p.h * j / 7; const pts = rect(p.x, p.y, p.w, p.d, z); ctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(q => ctx.lineTo(q[0], q[1])); ctx.closePath(); }
      ctx.stroke();
      const cz = zl + .3 + (Math.sin(now / 900 + t.ph) * .5 + .5) * (p.h - .8);
      poly(rect(p.x - .02, p.y - .02, p.w + .04, p.d + .04, cz), null, 'rgba(62,224,255,.8)', 1.5);
    }
  } else if (p.t === 'band') {
    const a = run ? .55 + .35 * Math.sin(now / 420 + t.ph) : t.state === 'IDLE' ? .25 : .08;
    box(p.x, p.y, p.w, p.d, zl + p.z, p.h, mixc([60, 30, 20], [255, 120, 40], a), 1, false);
  } else if (p.t === 'cyl') {
    let top = null;
    if (p.tower) { const a = t.state === 'DOWN' ? .4 + .6 * Math.abs(Math.sin(now / 200)) : 1; const c = rgb(st.color); cyl(p.x, p.y, p.r, zl + p.z, p.h, c.map(v => v * a), hexA(st.color, a)); return; }
    if (p.plasma && run) top = `rgba(${190 + 50 * Math.sin(now / 300 + t.ph) | 0},120,255,${.55 + .3 * Math.sin(now / 240 + p.x)})`;
    if (p.euv && run) top = `rgba(169,139,255,${.6 + .3 * Math.sin(now / 500)})`;
    const [tx, ty, rx, ry] = cyl(p.x, p.y, p.r, zl + p.z, p.h, p.c, top, k);
    if (p.platen && rx > 2) { const a = now / (run ? 300 : 3000) + p.x; ctx.strokeStyle = 'rgba(220,235,255,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + Math.cos(a) * rx * .9, ty + Math.sin(a) * ry * .9); ctx.stroke(); }
    if (p.fan && rx > 3) { ctx.strokeStyle = 'rgba(180,210,240,.35)'; ctx.lineWidth = 1.5; for (let b = 0; b < 3; b++) { const a = now / 260 + b * 2.094; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + Math.cos(a) * rx * .85, ty + Math.sin(a) * ry * .85); ctx.stroke(); } }
  } else if (p.t === 'head') {
    const a = now / (run ? 450 : 4000) + p.ph, hx = p.x + Math.cos(a) * .25, hy = p.y + Math.sin(a) * .25;
    cyl(hx, hy, p.r, zl + p.z, p.h, C.efem, null, k);
  } else if (p.t === 'gantry') {
    const u = run ? (Math.sin(now / 1700 + t.ph) * .5 + .5) : .1;
    box(p.x + (p.x1 - p.x) * u, p.y, p.w, p.d, zl + p.z, p.h, C.efem, k);
  }
}

function drawObj(t, now) {
  const L = lv[t.level], zl = L.z;
  const dim = t.level === 'L3' && hoverArea && hoverArea !== t.area && !t.stocker;
  ctx.globalAlpha = L.a * (dim ? .22 : 1);
  const k = (hover === t || selected === t) ? 1.35 : 1;
  if (t.level === 'L3' && !t.stocker) {
    const st = STATE[t.state];
    poly(rect(t.x - .15, t.y - .15, t.w + .3, t.d + .3, zl), t.state === 'DOWN' ? hexA(st.color, .1 + .08 * Math.sin(now / 200)) : 'rgba(0,0,0,.28)', hexA(st.color, .3));
    if (now - t.flash < 700) { const a = 1 - (now - t.flash) / 700; poly(rect(t.x - .3, t.y - .3, t.w + .6, t.d + .6, zl), null, `rgba(62,224,255,${a})`, 2); }
  } else poly(rect(t.x - .1, t.y - .1, t.w + .2, t.d + .2, zl), 'rgba(0,0,0,.3)');
  t.parts.sort((a, b) => partDepth(a) - partDepth(b));
  for (const p of t.parts) drawPart(p, t, now, zl, k);
  ctx.globalAlpha = 1;
}

function drawPlate(L, now) {
  const s = lv[L.id]; if (s.a < .02) return;
  ctx.globalAlpha = s.a;
  const col = rgb(L.color);
  if (levelMode !== 'ALL' || L.id === 'L1') box(-.5, -.5, WORLD.w + 1, WORLD.h + 1, s.z - .45, .45, L.id === 'L3' ? [14, 22, 34] : [12, 18, 28], 1, false);
  else poly(rect(-.5, -.5, WORLD.w + 1, WORLD.h + 1, s.z - .45), null, hexA(L.color, .18));
  const top = rect(-.5, -.5, WORLD.w + 1, WORLD.h + 1, s.z);
  poly(top, levelMode === 'ALL' ? (L.id === 'L1' ? 'rgba(9,14,22,.9)' : 'rgba(10,16,26,.66)') : 'rgba(10,16,26,.92)', hexA(L.color, .45), 1.2);
  ctx.strokeStyle = hexA(L.color, .045); ctx.lineWidth = 1; ctx.beginPath();
  for (let x = 0; x <= WORLD.w; x += 2.5) { const a = P(x, 0, s.z), b = P(x, WORLD.h, s.z); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  for (let y = 0; y <= WORLD.h; y += 2.5) { const a = P(0, y, s.z), b = P(WORLD.w, y, s.z); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  ctx.stroke();
  // 층 라벨 — 화면 기준 가장 왼쪽 모서리
  const corners = [[-.5, -.5], [WORLD.w + .5, -.5], [WORLD.w + .5, WORLD.h + .5], [-.5, WORLD.h + .5]].map(c => P(c[0], c[1], s.z));
  const lc = corners.reduce((m, c) => c[0] < m[0] ? c : m);
  ctx.textAlign = 'left';
  ctx.font = `800 ${clamp(cam.z * 1.3, 12, 22)}px "JetBrains Mono"`; ctx.fillStyle = hexA(L.color, .95);
  ctx.fillText(L.id, lc[0] + 4, lc[1] - 8);
  const w = ctx.measureText(L.id).width;
  ctx.font = `700 ${clamp(cam.z * .62, 9, 12)}px "JetBrains Mono"`; ctx.fillStyle = hexA(L.color, .7);
  ctx.fillText(L.name, lc[0] + w + 12, lc[1] - 14);
  ctx.font = `500 ${clamp(cam.z * .55, 9, 11)}px Pretendard, sans-serif`; ctx.fillStyle = 'rgba(160,180,210,.55)';
  ctx.fillText(L.sub, lc[0] + w + 12, lc[1] - 2);
  ctx.globalAlpha = 1;
}

function drawL3Floor(now) {
  const s = lv.L3; if (s.a < .02) return;
  ctx.globalAlpha = s.a;
  poly(rect(1.2, 20.8, 82.1, 10.4, s.z), 'rgba(62,224,255,.025)', 'rgba(62,224,255,.14)');
  ZONES.forEach(z => {
    const A = AREAS[z.area], dim = hoverArea && hoverArea !== z.area, on = hoverArea === z.area;
    poly(rect(z.x, z.y, z.w, z.d, s.z), hexA(A.color, dim ? .012 : on ? .09 : .04), hexA(A.color, dim ? .08 : on ? .7 : .28), on ? 1.6 : 1);
    poly(rect(z.x + .9, z.aisle - .7, z.w - 1.8, 1.4, s.z), 'rgba(255,255,255,.014)');
    if (z.area === 'PHOTO') { // yellow room 유리벽
      const wh = 2.2, e = [[z.x, z.y], [z.x + z.w, z.y], [z.x + z.w, z.y + z.d], [z.x, z.y + z.d]];
      for (let i = 0; i < 4; i++) { const a = e[i], b = e[(i + 1) % 4]; poly([P(a[0], a[1], s.z), P(b[0], b[1], s.z), P(b[0], b[1], s.z + wh), P(a[0], a[1], s.z + wh)], 'rgba(245,197,66,.035)', 'rgba(245,197,66,.18)'); }
    }
    if (cam.z > 4.5) {
      const corner = P(z.x + .6, z.top ? z.y + .6 : z.y + z.d - .6, s.z);
      ctx.globalAlpha = s.a * (dim ? .3 : 1);
      ctx.font = `800 ${clamp(cam.z * .58, 9, 14)}px "JetBrains Mono"`; ctx.textAlign = 'left'; ctx.fillStyle = hexA(A.color, .95);
      ctx.fillText(z.label, corner[0], corner[1]);
      const ts = tools.filter(t => zoneOf(t.cx, t.cy) === z);
      ctx.font = `500 ${clamp(cam.z * .45, 8, 11)}px "JetBrains Mono"`; ctx.fillStyle = 'rgba(160,185,215,.6)';
      ctx.fillText(`${ts.length} tools · ${ts.filter(t => t.state === 'RUN').length} run`, corner[0], corner[1] + clamp(cam.z * .62, 10, 15));
      ctx.globalAlpha = s.a;
    }
  });
  ctx.globalAlpha = 1;
}

function drawRisers(now) {
  if (!layers.utility || levelMode !== 'ALL' || lv.L2.a < .3) return;
  const z3 = lv.L3.z - .45, z2 = lv.L2.z;
  ctx.save();
  ctx.beginPath();
  tools.forEach(t => { const a = P(t.cx, t.cy, z2 + .7), b = P(t.cx, t.cy, z3); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
  ctx.strokeStyle = 'rgba(140,170,255,.1)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.setLineDash([2, 12]); ctx.lineDashOffset = now / 40; ctx.strokeStyle = 'rgba(169,139,255,.55)'; ctx.lineWidth = 1.4; ctx.stroke();
  // L1 → L2 메인 라이저
  const z1 = lv.L1.z;
  [[10, 26, '#3ee0ff'], [30, 26, '#4d8dff'], [50, 26, '#36d98e'], [70, 26, '#ffb020']].forEach(([x, y, c]) => {
    const a = P(x, y, z1 + 1.2), b = P(x, y, z3);
    ctx.setLineDash([]); ctx.strokeStyle = hexA(c, .18); ctx.lineWidth = Math.max(2, cam.z * .35); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([4, 10]); ctx.lineDashOffset = now / 25; ctx.strokeStyle = hexA(c, .8); ctx.lineWidth = 1.6; ctx.stroke();
  });
  ctx.restore();
}

function drawL1Labels() {
  if (lv.L1.a < .2 || cam.z < 4) return;
  ctx.globalAlpha = lv.L1.a * .9; ctx.textAlign = 'center';
  ctx.font = `700 ${clamp(cam.z * .5, 8, 12)}px "JetBrains Mono"`; ctx.fillStyle = 'rgba(255,176,32,.8)';
  L1_LABELS.forEach(([t, x, y]) => { const p = P(x, y, lv.L1.z); ctx.fillText(t, p[0], p[1]); });
  ctx.globalAlpha = 1;
}

function drawHeat() {
  const z = lv.L3.z;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = lv.L3.a;
  tools.forEach(t => {
    const [cx, cy] = P(t.cx, t.cy, z), r = Math.max(2, cam.z * (1.6 + t.w * .35)), u = t.util;
    const col = u > 90 ? '#ff4a2e' : u > 78 ? '#ffa020' : u > 55 ? '#2fb7a0' : '#2a6aa0';
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, hexA(col, .36)); g.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, r, r * .58, 0, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
}

function drawLots() {
  if (cam.z < 7 || lv.L3.a < .3) return;
  const z = lv.L3.z;
  ctx.globalAlpha = lv.L3.a;
  tools.forEach(t => {
    if (hoverArea && hoverArea !== t.area) return;
    const n = Math.min(t.queue, 6); if (!n) return;
    const y = t.side === 'below' ? t.y - .55 : t.y + t.d + .2;
    for (let i = 0; i < n; i++) {
      const hot = t.hot && i === 0;
      box(t.x + .15 + i * .44, y, .34, .34, z, .32, hot ? C.amber : [130, 150, 178], 1, false);
    }
  });
  ctx.globalAlpha = 1;
}

function drawRoute(now) {
  if (!route || lv.L3.a < .3) return;
  const z = lv.L3.z + .05;
  ctx.save();
  ctx.beginPath(); route.pts.forEach((p, i) => { const s = P(p[0], p[1], z); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
  ctx.strokeStyle = 'rgba(255,176,32,.16)'; ctx.lineWidth = cam.z * .55; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.setLineDash([cam.z * .55, cam.z * .3]); ctx.lineDashOffset = -now / 22;
  ctx.strokeStyle = '#ffb020'; ctx.lineWidth = Math.max(1.6, cam.z * .12); ctx.stroke();
  ctx.restore();
}

function drawRails(now) {
  const z = lv.L3.z + RZ; ctx.globalAlpha = lv.L3.a; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const stroke = (pts, closed, w, c) => {
    ctx.beginPath(); pts.forEach((q, k) => { const s = P(q[0], q[1], z); k ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
    if (closed) ctx.closePath();
    ctx.strokeStyle = 'rgba(2,6,12,.55)'; ctx.lineWidth = w + 2; ctx.stroke();
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke();
  };
  stubs.forEach(s => stroke(s, false, Math.max(1, cam.z * .08), 'rgba(120,170,230,.3)'));
  paths.forEach((p, i) => stroke(p.pts, true, Math.max(1, cam.z * (i < 2 ? .13 : .09)), i < 2 ? 'rgba(120,190,250,.5)' : 'rgba(120,170,230,.32)'));
  if (jam) {
    ctx.beginPath(); const a = P(jam.x0, 21.6, z), b = P(jam.x1, 21.6, z); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = `rgba(255,77,94,${.5 + .4 * Math.sin(now / 150)})`; ctx.lineWidth = Math.max(3, cam.z * .35); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawVehicles(now) {
  const z = lv.L3.z, zr = z + RZ;
  ctx.globalAlpha = lv.L3.a;
  // trails
  vehicles.forEach(v => {
    if (v.trail.length < 2) return;
    ctx.beginPath(); v.trail.forEach((q, i) => { const s = P(q[0], q[1], zr - .25); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
    const [x, y] = posOn(v.path, v.s), s = P(x, y, zr - .25); ctx.lineTo(s[0], s[1]);
    ctx.strokeStyle = v.hot ? 'rgba(255,176,32,.6)' : 'rgba(150,210,255,.22)'; ctx.lineWidth = v.hot ? 2.4 : 1.6; ctx.stroke();
  });
  const list = vehicles.map(v => { const [x, y] = posOn(v.path, v.s); return { v, x, y, d: depth(x, y) }; }).sort((a, b) => a.d - b.d);
  list.forEach(({ v, x, y }) => {
    const body = v.hot ? C.amber : v.carry ? C.vCarry : C.vEmpty, bz = zr - .55;
    if (v.state === 'hoist') {
      const k = v.ht < .9 ? v.ht / .9 : v.ht < 1.1 ? 1 : (2 - v.ht) / .9, port = z + 1.15, fz = bz - (bz - port) * k;
      const a = P(x - .12, y, bz), b = P(x - .12, y, fz + .32), c = P(x + .12, y, bz), d = P(x + .12, y, fz + .32);
      ctx.strokeStyle = 'rgba(200,225,255,.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
      if ((v.carry && v.ht < 1) || (!v.carry && v.ht >= 1)) box(x - .19, y - .19, .38, .38, fz, .34, v.hot ? C.amber : C.foup, 1.1);
      box(x - .24, y - .24, .48, .48, fz + .34, .06, C.dark, 1, false);
    } else if (v.carry) box(x - .18, y - .18, .36, .36, bz - .34, .32, v.hot ? C.amber : C.foup, 1);
    box(x - .32, y - .32, .64, .64, bz, .44, body, 1);
    if ((v.hot || v.state === 'hoist') && cam.z > 4) {
      const [gx, gy] = P(x, y, bz + .44), r = Math.max(1, cam.z * 1.1);
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, v.hot ? 'rgba(255,176,32,.5)' : 'rgba(62,224,255,.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
    }
  });
  ctx.globalAlpha = 1;
}

function pill(x, y, text, color, bg = 'rgba(8,13,21,.92)') {
  ctx.font = '700 10.5px "JetBrains Mono"';
  const w = ctx.measureText(text).width + 14, h = 19;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h, w, h, 5); ctx.fillStyle = bg; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x + 4, y); ctx.fillStyle = color; ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, x, y - 5.5);
}

function hullOf(t) {
  const zl = lv[t.level].z, pts = [];
  for (const [x, y] of [[t.x, t.y], [t.x + t.w, t.y], [t.x + t.w, t.y + t.d], [t.x, t.y + t.d]]) { pts.push(P(x, y, zl), P(x, y, zl + t.h)); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function drawOverlays(now) {
  const z = lv.L3.z;
  if (lv.L3.a > .3) {
    ctx.globalAlpha = lv.L3.a;
    if (layers.alarm) tools.forEach(t => {
      if (t.state !== 'DOWN') return;
      const [x, y] = P(t.cx, t.cy, z);
      for (let k = 0; k < 2; k++) {
        const ph = ((now / 1400) + k * .5) % 1, r = cam.z * (1.2 + ph * 2.6);
        ctx.beginPath(); ctx.ellipse(x, y, r, r * .58, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,77,94,${.7 * (1 - ph)})`; ctx.lineWidth = 1.5; ctx.stroke();
      }
    });
    if (layers.labels && cam.z > 13) {
      ctx.font = `600 ${clamp(cam.z * .4, 9, 12)}px "JetBrains Mono"`; ctx.textAlign = 'center';
      [...tools, ...stockers].forEach(t => {
        if (hoverArea && hoverArea !== t.area) return;
        const [x, y] = P(t.cx, t.cy, z + t.h);
        ctx.fillStyle = 'rgba(215,228,246,.75)'; ctx.fillText(t.id, x, y - 6);
      });
    }
    tools.forEach(t => { if (t.tag) { const [x, y] = P(t.cx, t.cy, z + t.h + .4); pill(x, y - 4, t.tag.text, t.tag.color); } });
    if (route) { const t = byId[route.nodes[0]], [x, y] = P(t.cx, t.cy, z + t.h + .4); pill(x, y - 30, route.label, '#ffb020', 'rgba(40,26,0,.92)'); }
    ctx.globalAlpha = 1;
  }
  [hover, selected].forEach((o, i) => { if (o && lv[o.level].a > .3) poly(hullOf(o), null, i ? '#3ee0ff' : 'rgba(62,224,255,.6)', i ? 2 : 1.2); });
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  const k = 1 - Math.pow(.002, dt);
  if (camT) {
    cam.z += (camT.z - cam.z) * k; cam.ox += (camT.ox - cam.ox) * k; cam.oy += (camT.oy - cam.oy) * k;
    if (Math.abs(camT.z - cam.z) < .005 && Math.abs(camT.ox - cam.ox) < .3 && Math.abs(camT.oy - cam.oy) < .3) camT = null;
  }
  if (autoOrbit) rotT += dt * .1;
  if (Math.abs(rotT - rot) > 1e-4) setRot(rot + (rotT - rot) * k);
  for (const id in lv) { const s = lv[id]; s.z += (s.tz - s.z) * k; s.a += (s.ta - s.a) * k; }
  updateVehicles(dt, now);
  if (jam && now > jam.until) jam = null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const sorted = id => OBJ[id].slice().sort((a, b) => depth(a.cx, a.cy) - depth(b.cx, b.cy));
  // 아래층부터
  ['L1', 'L2'].forEach(id => {
    if (lv[id].a < .02) return;
    drawPlate(LEVELS.find(l => l.id === id), now);
    if (id === 'L1') drawL1Labels();
    sorted(id).forEach(o => drawObj(o, now));
  });
  drawRisers(now);
  if (lv.L3.a > .02) {
    drawPlate(LEVELS[0], now);
    drawL3Floor(now);
    if (layers.heat) drawHeat();
    drawRoute(now);
    if (layers.lots) drawLots();
    sorted('L3').forEach(o => drawObj(o, now));
    if (layers.oht) { drawRails(now); drawVehicles(now); }
  }
  drawOverlays(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- interaction
function inPoly(pt, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1], xj = vs[j][0], yj = vs[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function hit(mx, my) {
  for (const id of ['L3', 'L2', 'L1']) {
    if (lv[id].a < .5) continue;
    const list = OBJ[id].slice().sort((a, b) => depth(b.cx, b.cy) - depth(a.cx, a.cy));
    for (const o of list) if (inPoly([mx, my], hullOf(o))) return o;
  }
  return null;
}

let drag = null;
const tip = $('#tip');
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => {
  userMoved = true; camT = null;
  drag = { x: e.clientX, y: e.clientY, ox: cam.ox, oy: cam.oy, rot, rotate: e.button === 2 || e.shiftKey, moved: false };
});
window.addEventListener('mouseup', e => {
  if (drag && !drag.moved && e.target === canvas && e.button === 0) {
    const r = canvas.getBoundingClientRect(), o = hit(e.clientX - r.left, e.clientY - r.top);
    selected = o; o ? showToolCard(o) : hideToolCard();
  }
  drag = null; canvas.classList.remove('drag');
});
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; canvas.classList.add('drag'); }
    if (drag.moved) {
      if (drag.rotate) { autoOrbit = false; $('#orbit')?.classList.remove('on'); rotT = drag.rot + dx * .008; setRot(rotT); }
      else { cam.ox = drag.ox + dx; cam.oy = drag.oy + dy; }
      tip.style.display = 'none'; return;
    }
  }
  hover = hit(mx, my);
  canvas.classList.toggle('pointer', !!hover);
  if (hover) {
    tip.style.display = 'block';
    tip.style.left = Math.min(mx + 16, W - 210) + 'px'; tip.style.top = Math.min(my + 14, H - 130) + 'px';
    const h = hover;
    tip.innerHTML = h.level !== 'L3'
      ? `<div class="tt-h">${h.id}<span class="badge-st RUN">${h.level}</span></div><div class="tt-r">${h.kind}<b></b></div><div class="tt-r">부하<b>${h.util.toFixed(0)}%</b></div><div class="tt-r">상태<b>정상</b></div>${h.owner ? `<div class="tt-r">연결 설비<b>${h.owner}</b></div>` : ''}`
      : h.stocker
        ? `<div class="tt-h">${h.id}</div><div class="tt-r">Stocker<b>Interbay</b></div><div class="tt-r">적재율<b>${h.fill}%</b></div><div class="tt-r">크레인<b>가동</b></div>`
        : `<div class="tt-h">${h.id}<span class="badge-st ${h.state}">${h.state}</span></div>
           <div class="tt-r">${h.model}<b>${AREAS[h.area].name}</b></div>
           <div class="tt-r">가동률<b>${h.util.toFixed(1)}%</b></div>
           <div class="tt-r">대기열<b>${h.queue} lots${h.hot ? ' · HOT' : ''}</b></div>
           <div class="tt-r">진행 랏<b>${h.lot || '—'}</b></div>`;
  } else tip.style.display = 'none';
});
canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; });
canvas.addEventListener('wheel', e => {
  e.preventDefault(); camT = null; userMoved = true;
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const nz = clamp(cam.z * Math.exp(-e.deltaY * .0015), 3, 48), k = nz / cam.z;
  cam.ox = mx - (mx - cam.ox) * k; cam.oy = my - (my - cam.oy) * k; cam.z = nz;
}, { passive: false });
function zoomBy(f) { const nz = clamp(cam.z * f, 3, 48), k = nz / cam.z; camT = { z: nz, ox: W / 2 - (W / 2 - cam.ox) * k, oy: H / 2 - (H / 2 - cam.oy) * k }; }
$('#zin').onclick = () => zoomBy(1.35); $('#zout').onclick = () => zoomBy(1 / 1.35);
$('#zfit').onclick = () => { camT = fitCam(); setArea(null); };
$('#rotl').onclick = () => { rotT -= Math.PI / 4; setTimeout(() => camT = fitCam(), 350); };
$('#rotr').onclick = () => { rotT += Math.PI / 4; setTimeout(() => camT = fitCam(), 350); };
$('#orbit').onclick = e => { autoOrbit = !autoOrbit; e.currentTarget.classList.toggle('on', autoOrbit); };
$$('#levels button').forEach(b => b.onclick = () => setLevel(b.dataset.level));
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'q' || e.key === 'Q') $('#rotl').click();
  if (e.key === 'e' || e.key === 'E') $('#rotr').click();
});

function ensureL3() { if (levelMode === 'L2' || levelMode === 'L1') setLevel('ALL'); }
function focusTools(ids, z = 18) {
  ensureL3();
  const ts = ids.map(i => byId[i]);
  camT = camFor(ts.reduce((s, t) => s + t.cx, 0) / ts.length, ts.reduce((s, t) => s + t.cy, 0) / ts.length, z);
}
function focusArea(areaId) {
  ensureL3();
  const zs = ZONES.filter(z => z.area === areaId), ts = tools.filter(t => t.area === areaId);
  const xs = zs.length ? zs.flatMap(z => [z.x, z.x + z.w]) : ts.flatMap(t => [t.x, t.x + t.w]);
  const ys = zs.length ? zs.flatMap(z => [z.y, z.y + z.d]) : ts.flatMap(t => [t.y, t.y + t.d]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  camT = camFor(cx, cy, clamp(W / (span * 1.15 + 10), 6, 22));
}
function routeVia(nodes) {
  const pts = [];
  nodes.forEach((id, i) => {
    const t = byId[id];
    if (i) { const p = byId[nodes[i - 1]]; pts.push([p.cx, p.aisle], [p.cx, 26], [t.cx, 26], [t.cx, t.aisle]); }
    pts.push([t.cx, t.cy]);
  });
  return pts;
}

// layer toggles
const LAYER_LABEL = { oht: 'OHT', lots: 'FOUP', utility: '유틸리티', heat: '히트맵', alarm: '알람', labels: '라벨' };
$('#layers').innerHTML = Object.keys(layers).map(k => `<button data-l="${k}" class="${layers[k] ? 'on' : ''}"><i></i>${LAYER_LABEL[k]}</button>`).join('');
$$('#layers button').forEach(b => b.onclick = () => { layers[b.dataset.l] = !layers[b.dataset.l]; b.classList.toggle('on'); });
$('#mapChips').innerHTML = `<span class="chip"><i class="sw run"></i>${tools.length} 공정 설비</span><span class="chip">${vehicles.length} OHT · ${paths.length} 루프</span><span class="chip">${stockers.length} STK</span><span class="chip">${utils2.length + utils1.length} 유틸리티</span>`;
