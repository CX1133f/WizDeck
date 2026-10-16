/* 复现「多边形闭合后从某一点继续绘图」的 bug。
   直接驱动 WD.drawTool 的处理器（帧内坐标 = 画布坐标），
   绕过缩放，精确观察一次「双击起点闭合」之后到底发生了什么。
   用法：node tools/poly-close-probe.mjs <port> */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9352);
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

// 载入一个空 deck，确保 drawBridge 已装上
await ev(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const body = '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff"></div>';
  WD.app.loadDeck({ title: 't', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 't', bodyHtml: body }) }
  ]}, 't.html');
  return { hasBridge: !!WD.drawBridge, hasTool: !!WD.drawTool, ready: !!WD.__drawReady };
})()`);

// 埋点：记录 create / hint 调用
await ev(`(() => {
  window.__probe = { creates: [], hints: [] };
  const b = WD.drawBridge;
  const oc = b.create, oh = b.hint;
  b.create = function (o) { window.__probe.creates.push({ kind: o.kind, n: (o.points||[]).length, pts: o.points }); return oc.apply(b, arguments); };
  b.hint = function (m, t, d) { window.__probe.hints.push(m + ' @' + t); return oh.apply(b, arguments); };
  return true;
})()`);

const fake = (x, y) => `({ button:0, clientX:${x}, clientY:${y}, preventDefault:function(){}, stopPropagation:function(){} })`;

// ── 场景 A：双击「起点」闭合 ──────────────────────────────────
await ev(`(() => {
  const T = WD.drawTool; T.stop(); T.start('poly');
  return { tool: T.tool, pts: T.pts.length };
})()`);

// 点三个顶点
await ev(`WD.drawTool.handleDown(${fake(200, 200)}); true;`);
await ev(`WD.drawTool.handleDown(${fake(700, 200)}); true;`);
await ev(`WD.drawTool.handleDown(${fake(450, 520)}); true;`);
console.log('三点之后 pts =', await ev(`WD.drawTool.pts.map(function(p){return [p[0],p[1]];})`));

// 双击起点：press1(闭合) → press2(可能重新锚定) → dblclick
await ev(`WD.drawTool.handleDown(${fake(205, 205)}); true;`);   // 近起点 → 应闭合
console.log('闭合1后: tool=', await ev(`WD.drawTool.tool`), 'pts=', await ev(`WD.drawTool.pts.length`));
await ev(`WD.drawTool.handleDown(${fake(205, 205)}); true;`);   // 双击第二下
console.log('press2后: tool=', await ev(`WD.drawTool.tool`), 'pts=', await ev(`WD.drawTool.pts.length`));
await ev(`WD.drawTool.handleDblClick({ preventDefault:function(){}, stopPropagation:function(){} }); true;`);
await sleep(60);
console.log('dblclick后: tool=', await ev(`WD.drawTool.tool`), 'pts=', await ev(`WD.drawTool.pts.length`));

const probe = await ev(`window.__probe`);
console.log('\n=== creates ===');
probe.creates.forEach((c, i) => console.log(`  #${i + 1} kind=${c.kind} n=${c.n}`));
console.log('=== hints ===');
probe.hints.forEach((h) => console.log('  ' + h));

// 画布里到底插了几个 poly
const polys = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  return [].slice.call(doc.querySelectorAll('[data-wd-added="poly"]')).map(function(n){
    return (n.getAttribute('data-wd-points')||'').length > 0 ? JSON.parse(n.getAttribute('data-wd-points')).length : 0;
  });
})()`);
console.log('\n画布内 poly 元素（各自主点数）:', JSON.stringify(polys));

ws.close();
