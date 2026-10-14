/* 命中测试：在屏幕某个点上，到底是谁接收事件？
   同时检查缩放/旋转手柄是否被 iframe 盖住（frame-box 是否真的能点到）。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9350);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(((d.exception && (d.exception.description || d.exception.value)) || d.text || '').split('\n').slice(0, 6).join(' | '));
  }
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

await ev(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const body = '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff">'
    + '<div id="card" style="position:absolute;left:400px;top:300px;width:600px;height:360px;background:rgb(238,242,247)"></div>'
    + '<h1 id="head" style="position:absolute;left:400px;top:720px;margin:0;font-size:72px">标题</h1></div>';
  WD.app.loadDeck({ title: 't', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 't', bodyHtml: body }) }
  ]}, 't.html');
  return true;
})()`);
await sleep(1600);

/* 选中卡片 */
const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const sel = { x: Math.round(st.left + 700 * st.scale), y: Math.round(st.top + 480 * st.scale) };
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sel.x, y: sel.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sel.x, y: sel.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(250);

console.log('选中的元素:', JSON.stringify(await ev(`(WD.app.E.selection||[]).map(n=>n.tagName+(n.id?'#'+n.id:''))`)));

/* 手柄中心点的命中测试 */
console.log('\n=== 手柄中心 elementFromPoint 命中 ===');
console.log(JSON.stringify(await ev(`(() => {
  const out = [];
  document.querySelectorAll('#frame-box .handle').forEach(function (h) {
    const r = h.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    out.push({
      h: h.getAttribute('data-h'),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      topEl: topEl ? (topEl.tagName + (topEl.id ? '#' + topEl.id : '') + '.' + String(topEl.className).split(' ')[0]) : null,
      isHandle: topEl === h,
      isIgnored: topEl && topEl.id === 'wd-hit-ignore',
    });
  });
  const fb = document.getElementById('frame-box').getBoundingClientRect();
  return { handles: out, frameBox: [Math.round(fb.left), Math.round(fb.top), Math.round(fb.width), Math.round(fb.height)],
           hitIgnore: !!document.getElementById('wd-hit-ignore') };
})()`, null, 1)));

/* 重叠层诊断 */
console.log('\n=== 叠放层次（从顶到底） ===');
console.log(JSON.stringify(await ev(`(() => {
  const stack = document.getElementById('stage').parentElement;
  const out = [];
  document.querySelectorAll('#stage, #stage-frame, #overlay, #frame-box, #marquee, .stage-empty, #stage-empty').forEach(function (el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.push({ sel: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
      z: cs.zIndex, pos: cs.position, pe: cs.pointerEvents,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  return out;
})()`, null, 1)));

/* 模拟一次真实点击手柄中心 */
console.log('\n=== 真实点击「右下角手柄」中心 ===');
const hCenter = await ev(`(() => {
  const h = document.querySelector('#frame-box .handle.h-se');
  const r = h.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hCenter.x, y: hCenter.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hCenter.x, y: hCenter.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hCenter.x + 40, y: hCenter.y + 30, button: 'left', buttons: 1 });
await sleep(60);
console.log('拖动中 drag 状态:', JSON.stringify(await ev(`(() => ({
  mode: WD.app.E.drag ? WD.app.E.drag.mode : null,
  handle: WD.app.E.drag ? WD.app.E.drag.handle : null,
  width: WD.app.E.stage.getDoc().querySelector('#card').style.width,
}))()`)));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hCenter.x + 40, y: hCenter.y + 30, button: 'left', buttons: 0, clickCount: 1 });
await sleep(200);
console.log('拖动后:', JSON.stringify(await ev(`(() => {
  const el = WD.app.E.stage.getDoc().querySelector('#card');
  return { width: el.style.width, dragActive: !!WD.app.E.drag };
})()`)));

ws.close();
