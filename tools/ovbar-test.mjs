/* 选中元素后的浮动工具条回归。
   原 bug：工具条里的图标是 12.5px 的 Unicode 符号（✎ ⧉ ⇧ ⇩ ✕），
   而它位于被 transform:scale() 缩放的 .stage 内 —— 55% 缩放下
   26px 的按钮实测只剩 **14×14**，笔画细到看不出是什么。
   手柄早就用 counter-scale 治过这个病（.handle），工具条漏了。
   这里量的是**屏幕上真实渲染尺寸**，不是 CSS 里写的数字。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9490);
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
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('ws 失败')), { once: true });
});
let id = 0; const pend = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    pageErrors.push((d.exception && d.exception.description) || d.text);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 60000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result.value;
};
let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? '   ' + detail : '')); }
}
/* 工具条 + 画布的真实屏幕几何 */
const geom = () => ev(`(() => {
  const bar = document.getElementById('ov-toolbar');
  const stage = document.querySelector('.stage');
  const canvas = document.querySelector('.frame') || stage;
  if (!bar || bar.hidden) return { hidden: true };
  const br = bar.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const btns = Array.prototype.map.call(bar.querySelectorAll('button'), (b) => {
    const r = b.getBoundingClientRect();
    const svg = b.querySelector('svg');
    const ir = svg ? svg.getBoundingClientRect() : null;
    return { t: b.dataset.tb, w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             glyph: (b.textContent || '').trim(),
             isSvg: !!svg,
             iw: ir ? +ir.width.toFixed(1) : 0,
             stroke: svg ? getComputedStyle(svg).strokeWidth : null };
  });
  const lab = document.getElementById('ov-label');
  const lr = lab && !lab.hidden ? lab.getBoundingClientRect() : null;
  return { hidden: false,
           bar: { w: +br.width.toFixed(1), h: +br.height.toFixed(1),
                  left: br.left, right: br.right, top: br.top, bottom: br.bottom },
           stage: { left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom },
           btns,
           labelH: lr ? +lr.height.toFixed(1) : 0 };
})()`);
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(20);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(360);
}

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);
await ev('(async () => { await WD.app.loadSample(); return true; })()');
await ev('(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()');
await sleep(900);

/* ── [1] 真实点击选中一个标题，量工具条 ───────────────────────── */
console.log('\n[1] 选中元素后的工具条（适合窗口缩放下）');
const spot = await ev(`(() => {
  const n = WD.app.E.stage.getDoc().querySelector('h1');
  if (!n) return { none: true };
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await clickAt(spot.x, spot.y);
const g1 = await geom();
if (g1.hidden) { check('选中后工具条出现', false, '工具条是隐藏的'); ws.close(); process.exit(1); }
check('选中后工具条出现', true);
/* 读 .stage 上真正生效的 transform 比例 —— stage.zoom 在「适合窗口」模式下
   并不等于实际比例，量错对象会得出「根本没缩放」的假结论 */
const applied = () => ev(`(() => {
  const st = document.querySelector('.stage');
  const t = getComputedStyle(st).transform;
  if (!t || t === 'none') return 1;
  const m = t.match(/matrix\\(([^)]+)\\)/);
  return m ? +parseFloat(m[1].split(',')[0]).toFixed(4) : 1;
})()`);
const s1 = await applied();
console.log('  （画布实际缩放 ' + Math.round(s1 * 100) + '%，下面是屏幕像素实测值）');
check('本轮确实处在「画布被缩小」的场景（实际缩放 < 0.9）', s1 < 0.9, String(s1));
check('工具条整体不小于 150×36', g1.bar.w >= 150 && g1.bar.h >= 36, g1.bar.w + '×' + g1.bar.h);
for (const b of g1.btns) {
  check('按钮 ' + b.t + ' 在屏幕上 ≥ 28×28（实测 ' + b.w + '×' + b.h + '）', b.w >= 28 && b.h >= 28);
}
check('5 个按钮一个都不少', g1.btns.length === 5, String(g1.btns.length));
check('图标已换成内联 SVG（不再是 Unicode 字形）', g1.btns.every((b) => b.isSvg && b.glyph === ''),
  JSON.stringify(g1.btns.map((b) => b.glyph)));
check('SVG 图标屏幕尺寸 ≥ 15px', g1.btns.every((b) => b.iw >= 15), JSON.stringify(g1.btns.map((b) => b.iw)));
check('SVG 描边宽度 ≥ 1.2px（笔画不能细到看不见）',
  g1.btns.every((b) => parseFloat(b.stroke) >= 1.2), JSON.stringify(g1.btns.map((b) => b.stroke)));
check('元素标签也没被缩到看不见（高度 ≥ 14px）', g1.labelH >= 14, String(g1.labelH));

/* ── [2] 换缩放级别：屏幕尺寸必须保持恒定 ────────────────────── */
console.log('\n[2] 改缩放后仍是恒定屏幕尺寸（counter-scale 生效）');
const sizes = [];
for (const z of [1, 0.75, 0.5, 0.35]) {
  await ev(`(async () => {
    if (typeof WD.app.E.stage.setZoom === 'function') { WD.app.E.stage.setZoom(${z}); return true; }
    return false;
  })()`);
  await sleep(380);
  const sc = await applied();
  const gb = await geom();
  const b0 = gb.btns[0] || { w: 0, h: 0 };
  sizes.push({ scale: sc, w: b0.w, h: b0.h });
  console.log('  实际缩放 ' + String(Math.round(sc * 100)).padStart(3) + '%  →  按钮 ' + b0.w + '×' + b0.h);
}
check('★ 缩放确实变了（至少有两个不同档位）',
  new Set(sizes.map((s) => s.scale)).size >= 2, JSON.stringify(sizes.map((s) => s.scale)));
check('★ 各缩放级别下按钮都保持 ≥ 28px（不跟着画布缩）',
  sizes.every((s) => s.w >= 28 && s.h >= 28), JSON.stringify(sizes));

/* 回到适合窗口 */
await ev('(async () => { WD.app.E.stage.fit(); return true; })()');
await sleep(400);
await clickAt(spot.x, spot.y);
await sleep(200);

/* ── [3] 贴边时不能被裁掉（工具条变宽了 22px，夹取必须跟上） ──── */
console.log('\n[3] 元素贴画布右缘时工具条不被裁剪');
const edge = await ev(`(async () => {
  const E = WD.app._internal;
  const n = WD.app.E.stage.getDoc().querySelector('h1');
  if (!n) return { none: true };
  /* 把元素推到画布最右边，再让内部逻辑重算一次覆盖层 */
  n.style.left = '1560px';
  n.style.top = '820px';
  E.refreshOverlay();
  await new Promise(r => setTimeout(r, 300));
  const bar = document.getElementById('ov-toolbar');
  const stage = document.querySelector('.stage');
  const br = bar.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  return { barRight: br.right, stageRight: sr.right, over: +(br.right - sr.right).toFixed(1),
           barLeft: br.left, stageLeft: sr.left };
})()`);
check('元素贴右缘时工具条也没超出画布', edge.over <= 1, '超出 ' + edge.over + 'px');

const topEdge = await ev(`(async () => {
  const E = WD.app._internal;
  const n = WD.app.E.stage.getDoc().querySelector('h1');
  if (!n) return { none: true };
  n.style.left = '700px';
  n.style.top = '30px';
  E.refreshOverlay();
  await new Promise(r => setTimeout(r, 300));
  const bar = document.getElementById('ov-toolbar');
  const stage = document.querySelector('.stage');
  const br = bar.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  return { overTop: +(sr.top - br.top).toFixed(1) };
})()`);
check('元素贴顶缘时工具条翻到下方且不出界', topEdge.overTop <= 1, '超出 ' + topEdge.overTop + 'px');

/* ── [4] 按钮真的还能用 ─────────────────────────────────────── */
console.log('\n[4] 按钮仍然可用');
/* 数画布上的元素总数：不能用 [data-wd-added]，
   那个属性只标记 addElement 新建的元素，示例课件里的元素没有 */
const countEls = () => `WD.app.E.stage.getDoc().querySelectorAll('*').length`;
const before = await ev(countEls());
const dup = await ev(`(() => {
  const bar = document.getElementById('ov-toolbar');
  const b = bar.querySelector('[data-tb="dup"]');
  if (!b) return { noBtn: true };
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await clickAt(dup.x, dup.y);
const after = await ev(countEls());
check('点「复制元素」画布上多了一个元素', after > before, before + ' → ' + after);
const del = await ev(`(() => {
  const b = document.querySelector('#ov-toolbar [data-tb="del"]');
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await clickAt(del.x, del.y);
const after2 = await ev(countEls());
check('点「删除元素」画布上少了一个元素', after2 < after, after + ' → ' + after2);

console.log('\n通过 ' + pass + '  失败 ' + fail);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
check('控制台零异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
ws.close();
process.exit(0);
