/* 曲线三次贝塞尔 + 多边形顶点编辑 的综合探针。
   全部通过官方 addElement / setSelection 入口，用全局引用操作元素，
   避免依赖内部 findRoot。用法：node tools/curve-poly-edit-probe.mjs <port> */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9354);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PASS = 0, FAIL = 0;
function check(name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS  ' + name); }
  else { FAIL++; console.log('  FAIL  ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}

async function resolvePageWs(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chromium');
}
const ws = new WebSocket(await resolvePageWs(PORT));
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { const d = r.exceptionDetails; throw new Error(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 8).join(' | ')); }
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);
await ev(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const body = '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff"></div>';
  WD.app.loadDeck({ title: 't', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 't', bodyHtml: body }) }
  ]}, 't.html');
  return true;
})()`);
await sleep(700);

/* ── ① 旧 bend 曲线迁移：先正常加曲线，再抹成「只有 bend」的旧样子 ── */
console.log('\n① 旧曲线（仅 bend）迁移出 c1/c2：');
const mig = await ev(`(() => {
  const n = WD.app._internal.addElement('curve');
  window.__curve = n;
  if (!n) return { err: 'addElement(curve) 返回空' };
  // 抹成旧工程形态：删掉 c1/c2，只留 p1/p2/bend
  n.removeAttribute('data-wd-c1'); n.removeAttribute('data-wd-c2');
  n.setAttribute('data-wd-p1', JSON.stringify([0,100]));
  n.setAttribute('data-wd-p2', JSON.stringify([100,100]));
  n.setAttribute('data-wd-bend', JSON.stringify([50,0]));
  const hadBefore = !!(n.getAttribute('data-wd-c1'));
  const lp = WD.elements.linePointsOf(n);           // 应触发迁移
  const wroteAfter = !!(n.getAttribute('data-wd-c1') && n.getAttribute('data-wd-c2'));
  return { hadBefore, wroteAfter, c1: lp.c1, c2: lp.c2, bend: lp.bend, p1: lp.p1, p2: lp.p2 };
})()`);
check('迁移前无 c1 属性', mig.hadBefore === false, mig);
check('linePointsOf 计算出 c1/c2', Array.isArray(mig.c1) && Array.isArray(mig.c2), mig);
check('迁移后落盘 c1/c2 属性', mig.wroteAfter === true, mig.wroteAfter);
const expC1 = [ (0 + (50-0)*2/3), (100 + (0-100)*2/3) ];
check('c1 符合二次→三次等价(2/3)', mig.c1 && Math.abs(mig.c1[0]-expC1[0]) < 0.6 && Math.abs(mig.c1[1]-expC1[1]) < 0.6, { got: mig.c1, want: expC1 });

/* ── ② 曲线渲染成 cubic ── */
console.log('\n② 曲线 SVG 路径使用 cubic(M..C..)：');
const cubic = await ev(`(() => {
  const n = window.__curve;
  n.setAttribute('data-wd-c1', JSON.stringify([33,20]));
  n.setAttribute('data-wd-c2', JSON.stringify([66,20]));
  WD.elements.syncLine(n);
  const p = n.querySelector('svg path');
  const d = p ? p.getAttribute('d') : '';
  return { d: d, hasC: d.indexOf('C') > 0, startsM: /^M/.test(d) };
})()`);
check('路径含 C（三次贝塞尔）', cubic.hasC === true, cubic.d);
check('路径以 M 开头', cubic.startsM === true, cubic.d);

/* ── ③ 选中曲线 → 4 手柄 + 切线指引线，肘拐点隐藏 ── */
console.log('\n③ 选中曲线：4 手柄 + 指引线，隐藏 bend：');
const ovC = await ev(`(() => {
  WD.app._internal.setSelection([window.__curve]);
  const fb = document.getElementById('frame-box');
  const shown = (sel) => { const e = fb.querySelector(sel); return !!(e && e.classList.contains('shown') && getComputedStyle(e).display !== 'none'); };
  const tg = fb.querySelector('.tangent-guide');
  const s1 = fb.querySelector('.t-spoke-1');
  const c1e = fb.querySelector('.h-ep-c1'); const r = c1e && c1e.getBoundingClientRect();
  return {
    start: shown('.h-ep-start'), end: shown('.h-ep-end'), c1: shown('.h-ep-c1'), c2: shown('.h-ep-c2'), bend: shown('.h-ep-bend'),
    guideDisplay: tg ? getComputedStyle(tg).display : 'missing',
    spokeHasCoords: !!(s1 && s1.getAttribute('x2') && parseFloat(s1.getAttribute('x2')) !== parseFloat(s1.getAttribute('x1'))),
    c1Box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
  };
})()`);
check('起点手柄显示', ovC.start === true, ovC);
check('终点手柄显示', ovC.end === true, ovC);
check('切线手柄 c1 显示', ovC.c1 === true, ovC);
check('切线手柄 c2 显示', ovC.c2 === true, ovC);
check('肘形拐点手柄隐藏', ovC.bend === false, ovC);
check('切线指引线可见', ovC.guideDisplay === 'block', ovC.guideDisplay);
check('指引线画了斜向 spoke', ovC.spokeHasCoords === true, ovC);
check('c1 手柄有可见尺寸', ovC.c1Box && ovC.c1Box.w > 4 && ovC.c1Box.h > 4, ovC.c1Box);

/* ── ④ 拖切线手柄 c1：改弯曲但不改尺寸 ── */
console.log('\n④ 拖切线手柄 ep-c1：只改弯曲、不改元素尺寸：');
const before = await ev(`(() => { const n = window.__curve; return { w:n.style.width, h:n.style.height, l:n.style.left, t:n.style.top, c1:n.getAttribute('data-wd-c1') }; })()`);
const dragC1 = await ev(`(() => {
  const fb = document.getElementById('frame-box');
  const h = fb.querySelector('.h-ep-c1');
  const r = h.getBoundingClientRect();
  const ox = r.x + r.width/2, oy = r.y + r.height/2;
  const mk = (type, x, y, bub) => new PointerEvent(type, { type, clientX:x, clientY:y, bubbles:!!bub, button:0 });
  h.dispatchEvent(mk('pointerdown', ox, oy, true));
  window.dispatchEvent(mk('pointermove', ox+70, oy-40, true));
  window.dispatchEvent(mk('pointermove', ox+130, oy-60, true));
  window.dispatchEvent(mk('pointerup', ox+130, oy-60, true));
  return !!WD.app.E.drag ? 'drag-stuck' : 'clean';
})()`);
await sleep(60);
const after = await ev(`(() => { const n = window.__curve; return { w:n.style.width, h:n.style.height, l:n.style.left, t:n.style.top, c1:n.getAttribute('data-wd-c1') }; })()`);
check('拖拽收尾 E.drag 清空', dragC1 === 'clean', dragC1);
check('尺寸 width 不变', before.w === after.w, { before: before.w, after: after.w });
check('尺寸 height 不变', before.h === after.h, { before: before.h, after: after.h });
check('位置 top 不变', before.t === after.t, { before: before.t, after: after.t });
check('c1 被改写（弯曲变化）', before.c1 !== after.c1, { before: before.c1, after: after.c1 });

/* ── ⑤ 选中多边形 → 逐顶点手柄 ── */
console.log('\n⑤ 选中多边形：逐顶点手柄：');
await ev(`(() => { window.__poly = WD.app._internal.addElement('poly'); return !!window.__poly; })()`);
const ovP = await ev(`(() => {
  const n = window.__poly;
  WD.app._internal.setSelection([n]);
  const fb = document.getElementById('frame-box');
  const vtx = fb.querySelectorAll('.vtx-layer .h-vtx.shown');
  const verts = WD.elements.verticesOf(n);
  const shown = (sel) => { const e = fb.querySelector(sel); return !!(e && e.classList.contains('shown')); };
  const r0 = vtx[0] && vtx[0].getBoundingClientRect();
  return { nVtx: vtx.length, nVerts: verts.length,
           lineHandlesHidden: !shown('.h-ep-start') && !shown('.h-ep-c1'),
           first: r0 ? { w: Math.round(r0.width) } : null };
})()`);
check('顶点手柄数量 == 顶点数(6)', ovP.nVtx === 6 && ovP.nVtx === ovP.nVerts, ovP);
check('多边形下线条手柄隐藏', ovP.lineHandlesHidden === true, ovP);
check('首个顶点手柄有可见尺寸', ovP.first && ovP.first.w > 4, ovP.first);

/* ── ⑥ 拖一个顶点 reshape ── */
console.log('\n⑥ 拖多边形顶点 0：点集与包围盒随之改变：');
const pBefore = await ev(`(() => { const n = window.__poly; return { pts: n.getAttribute('data-wd-points'), w:n.style.width, l:n.style.left }; })()`);
const dragV = await ev(`(() => {
  const fb = document.getElementById('frame-box');
  const h = fb.querySelector('.vtx-layer .h-vtx');
  const r = h.getBoundingClientRect();
  const ox = r.x + r.width/2, oy = r.y + r.height/2;
  const mk = (type, x, y, bub) => new PointerEvent(type, { type, clientX:x, clientY:y, bubbles:!!bub, button:0 });
  h.dispatchEvent(mk('pointerdown', ox, oy, true));
  window.dispatchEvent(mk('pointermove', ox-60, oy-90, true));
  window.dispatchEvent(mk('pointermove', ox-120, oy-150, true));
  window.dispatchEvent(mk('pointerup', ox-120, oy-150, true));
  return !!WD.app.E.drag ? 'drag-stuck' : 'clean';
})()`);
await sleep(60);
const pAfter = await ev(`(() => { const n = window.__poly; return { pts: n.getAttribute('data-wd-points'), w:n.style.width, l:n.style.left }; })()`);
check('顶点拖拽收尾干净', dragV === 'clean', dragV);
check('点集已改变', pBefore.pts !== pAfter.pts, { before: pBefore.pts, after: pAfter.pts });
check('包围盒已重算', pAfter.l !== pBefore.l || pAfter.w !== pBefore.w, { beforeL: pBefore.l, afterL: pAfter.l, beforeW: pBefore.w, afterW: pAfter.w });

console.log('\n════ 结果：' + PASS + ' passed, ' + FAIL + ' failed ════');
ws.close();
process.exit(FAIL ? 1 : 0);
