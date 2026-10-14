/* 拖动为什么无效：在页面里装监听器，记录 pointer / mouse 事件的实际流向。
   用法：node tools/drag-probe.mjs <port> */
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
    throw new Error(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 8).join(' | '));
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
    + '<div id="card" style="position:absolute;left:200px;top:200px;width:600px;height:360px;background:#eef2f7"></div></div>';
  WD.app.loadDeck({ title: 't', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 't', bodyHtml: body }) }
  ]}, 't.html');
  // 在父页与帧内都装监听器
  window.__log = [];
  const rec = (tag) => (e) => {
    window.__log.push(tag + ' target=' + (e.target && e.target.id ? '#' + e.target.id : (e.target && e.target.tagName)) +
      ' xy=' + Math.round(e.clientX) + ',' + Math.round(e.clientY) +
      ' buttons=' + (e.buttons === undefined ? '-' : e.buttons));
  };
  ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','click','pointercancel','lostpointercapture'].forEach(function (t) {
    window.addEventListener(t, rec('WIN:' + t), true);
    document.addEventListener(t, rec('DOC:' + t), true);
  });
  // 同时记录 beginDrag/onDragEnd 是否被调用（直接包一层）
  window.__hook = { begin: 0, move: 0, end: 0 };
  return true;
})()`);
await sleep(1500);

// 帧内也装
await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const rec = (tag) => (e) => {
    window.__log.push('FRAME:' + tag + ' target=' + (e.target && e.target.id ? '#' + e.target.id : (e.target && e.target.tagName)) +
      ' xy=' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' buttons=' + (e.buttons === undefined ? '-' : e.buttons));
  };
  ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','click'].forEach(function (t) {
    doc.addEventListener(t, rec(t), true);
  });
  // 检查帧的 pointer-events 与父元素的 CSS
  const st = WD.app.E.stage;
  window.__diag = {
    stageScale: st.scale,
    stageTransform: getComputedStyle(st.el).transform,
    framePE: getComputedStyle(st.frame).pointerEvents,
    frameRect: JSON.stringify(st.frame.getBoundingClientRect()),
    elRect: JSON.stringify(st.el.getBoundingClientRect()),
    overlayPE: getComputedStyle(document.getElementById('overlay')).pointerEvents,
    frameBoxPE: getComputedStyle(document.getElementById('frame-box')).pointerEvents,
    frameBoxRect: JSON.stringify(document.getElementById('frame-box').getBoundingClientRect()),
    frameBoxHidden: document.getElementById('frame-box').hidden,
  };
  return true;
})()`);

const diag = await ev(`window.__diag`);
console.log('=== 舞台与浮层诊断 ===');
console.log(JSON.stringify(diag, null, 1));

const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const toScreen = (x, y) => ({ x: Math.round(st.left + x * st.scale), y: Math.round(st.top + y * st.scale) });

// 清空日志，做一次拖动
await ev(`(() => { window.__log = []; return true; })()`);

const from = toScreen(500, 380);
const to = toScreen(660, 480);
console.log('\n拖动: 屏幕坐标', JSON.stringify(from), '->', JSON.stringify(to));

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
for (let i = 1; i <= 4; i++) {
  const x = from.x + (to.x - from.x) * i / 4;
  const y = from.y + (to.y - from.y) * i / 4;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  await sleep(15);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(200);

const log = await ev(`window.__log`);
console.log('\n=== 事件流 ===');
log.forEach((l) => console.log('  ' + l));

/* 手动模拟一次「父页收到 pointerup」看能否收尾 */
const manual = await ev(`(() => {
  const before = !!WD.app.E.drag;
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  const after = !!WD.app.E.drag;
  return { before, after };
})()`);
console.log('\n=== 手动派发 pointerup 到 window ===');
console.log(JSON.stringify(manual));

const after = await ev(`(() => {
  const cs = WD.app.E.stage.getDoc().defaultView.getComputedStyle(WD.app.E.stage.getDoc().querySelector('#card'));
  return { left: cs.left, top: cs.top, selection: (WD.app.E.selection || []).length,
           dragActive: !!WD.app.E.drag };
})()`);
console.log('\n=== 拖动结果 ===');
console.log(JSON.stringify(after, null, 1));

ws.close();
