/* 多边形填充探针（Bug 4）。
   验证：给 poly 选「填充色」写入 data-wd-fill 而非 CSS 背景，
   内层 path 的 fill 随之生效；「边框颜色/粗细」写入 data-wd-stroke / data-wd-w；
   清空填充回退 none；盒子恒透明不受影响；检查器能回显。
   用法：node tools/poly-fill-probe.mjs <port> */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9361);
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

/* 读取 poly 状态的小工具（在浏览器里跑） */
const snap = () => ev(`(() => {
  const n = window.__poly;
  const path = n.querySelector(':scope > svg > path');
  const cs = n.ownerDocument.defaultView.getComputedStyle(n);
  return {
    fillAttr: n.getAttribute('data-wd-fill'),
    strokeAttr: n.getAttribute('data-wd-stroke'),
    wAttr: n.getAttribute('data-wd-w'),
    pathFill: path ? path.getAttribute('fill') : null,
    pathStroke: path ? path.getAttribute('stroke') : null,
    boxBg: cs.backgroundColor
  };
})()`);

/* ── 建一个多边形并选中 ── */
await ev(`(() => { window.__poly = WD.app._internal.addElement('poly'); WD.app._internal.setSelection([window.__poly]); return !!window.__poly; })()`);
const s0 = await snap();
check('新建多边形默认不填充(data-wd-fill 未设)', s0.fillAttr === null, s0);
check('新建多边形 path.fill=none', s0.pathFill === 'none', s0);

/* ── ① 选填充色 → 写入 data-wd-fill，path.fill 生效 ── */
console.log('\n① 选填充色 #e74c3c：');
await ev(`(() => { WD.app._internal.styleChanged('background-color', '#e74c3c', 'fill'); return true; })()`);
await sleep(80);
const s1 = await snap();
check('data-wd-fill = 选中的颜色', s1.fillAttr === '#e74c3c', s1);
check('内层 path.fill = 选中的颜色', s1.pathFill === '#e74c3c', s1);
check('盒子背景仍透明(填充没写进 CSS)', s1.boxBg === 'rgba(0, 0, 0, 0)', s1);

/* ── ② 边框颜色 → 写入 data-wd-stroke ── */
console.log('\n② 选描边色 #12b886：');
await ev(`(() => { WD.app._internal.styleChanged('border-color', '#12b886', 'border-color'); return true; })()`);
await sleep(80);
const s2 = await snap();
check('data-wd-stroke = 选中的描边色', s2.strokeAttr === '#12b886', s2);
check('内层 path.stroke = 选中的描边色', s2.pathStroke === '#12b886', s2);
check('填充不受描边影响', s2.fillAttr === '#e74c3c', s2);

/* ── ③ 边框粗细 → 写入 data-wd-w ── */
console.log('\n③ 描边粗细 6px：');
await ev(`(() => { WD.app._internal.styleChanged('border-width', '6', 'border-width'); return true; })()`);
await sleep(80);
const s3 = await snap();
check('data-wd-w = 6', s3.wAttr === '6', s3);

/* ── ④ 清空填充 → 回退 none ── */
console.log('\n④ 清空填充(transparent)：');
await ev(`(() => { WD.app._internal.styleChanged('background-color', '', 'fill'); return true; })()`);
await sleep(80);
const s4 = await snap();
check('清空后 data-wd-fill 移除', s4.fillAttr === null, s4);
check('清空后 path.fill = none', s4.pathFill === 'none', s4);

/* ── ⑤ 检查器回显 ── */
console.log('\n⑤ 检查器回显填充色：');
await ev(`(() => {
  WD.app._internal.styleChanged('background-color', '#f7a600', 'fill');
  WD.app._internal.updateInspectorValues();
  return true;
})()`);
await sleep(120);
const echo = await ev(`(() => {
  const inp = document.getElementById('f-fill');
  const txt = document.getElementById('f-fill-text');
  return { inp: inp ? inp.value.toLowerCase() : null, txt: txt ? txt.value : null };
})()`);
check('填充色回显到 #f-fill', echo.inp === '#f7a600', echo);

console.log('\n════ 结果：' + PASS + ' passed, ' + FAIL + ' failed ════');
ws.close();
process.exit(FAIL ? 1 : 0);
