/* ============================================================================
   WizDeck 选区浮层回归 —— 「选中元素后画布上不该有任何东西压在元素上面」

   背景：原先选中元素后会浮出一条 5 键工具条（编辑文字 / 复制 / 置顶 / 置底 /
   删除）。用户反馈它「会遮挡相关操作」：它贴在元素上方，正好盖住要读的内容，
   而且贴着元素那一块区域点不到底下的元素。这条工具条已经整条删除，
   5 个键改由等价路径承担（双击 / Ctrl+D / Ctrl+] / Ctrl+[ / Delete）。

   所以本套件的断言方向整个反过来了：
     · 不是「工具条的尺寸够不够」，而是「画布上**一个**覆盖元素的东西都不该有」；
     · 不是「点按钮能不能用」，而是「删掉按钮后，那些操作还能不能做」。

   遮挡探针不认 id、不认 class：遍历 body 下所有可见元素，凡是矩形和
   选中元素相交、又不在选区框（#frame-box）和舞台（.stage）内部的，
   一律算遮挡。选择框与手柄是选中态本身，不算。
   ========================================================================== */
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

async function clickAt(x, y, opts = {}) {
  const modifiers = opts.modifiers || 0;
  const clickCount = opts.clickCount || 1;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1, modifiers });
  await sleep(20);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount, modifiers });
  await sleep(360);
}
const KEYCODES = { Delete: 46, d: 68, D: 68, ']': 221, '[': 219 };
async function keyCombo(key, code, modifiers = 0) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code, windowsVirtualKeyCode: KEYCODES[key] || 0, modifiers,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: KEYCODES[key] || 0, modifiers,
  });
  await sleep(260);
}

/* 遮挡探针：在选中元素内部取 3×3 共 9 个采样点，看每一点**最顶层**是谁。
   ⚠ 两个坑：
   ① 元素 getBoundingClientRect() 拿到的是 **iframe 视口坐标**（1920×1080 那个空间），
      直接拿去和顶层页面的元素比矩形，会把左栏、整个 app 容器全算成「遮挡」。
      必须按 iframe 在页面上的位置和实际缩放换算成页面坐标。
   ② 不能遍历 body 找相交元素 —— 祖先容器（#app / #workspace / .stage-wrap）
      天生就「包含」被选中元素，把它们算成遮挡是自欺欺人。
   elementsFromPoint 只返回命中点上真正压在最前面的那一串，祖先自然不会出现。 */
const occluders = () => ev(`(() => {
  const sel = WD.app.E.selection && WD.app.E.selection[0];
  if (!sel) return { noSel: true, list: [] };
  const fr = document.getElementById('stage-frame').getBoundingClientRect();
  const r = sel.getBoundingClientRect();
  const s = fr.width / 1920;            /* iframe 视口 → 页面 的缩放系数 */
  const L = fr.left + r.left * s, R = fr.left + r.right * s;
  const T = fr.top + r.top * s, B = fr.top + r.bottom * s;
  const list = [];
  for (let i = 0; i < 9; i++) {
    const x = L + (R - L) * ((i % 3) + 0.5) / 3;
    const y = T + (B - T) * (Math.floor(i / 3) + 0.5) / 3;
    const stack = document.elementsFromPoint(x, y);
    const top = stack[0];
    const name = top ? (top.id || (top.tagName + '.' + (top.className || ''))) : '(null)';
    /* 白名单：画布本身，以及选区框里的八个缩放手柄。
       手柄压在元素边角上是有意为之 —— 它就是让人抓着改大小的，
       把它算成「遮挡」等于要求选中态不许显示手柄。 */
    const isHandle = !!(top && top.closest && top.closest('#frame-box'));
    if (name !== 'stage-frame' && !isHandle) {
      list.push({ x: Math.round(x), y: Math.round(y), top: name,
                  area: Math.round((R - L) * (B - T)),
                  depth: Array.prototype.map.call(stack.slice(0, 3), (e) => e.id || e.tagName) });
    }
  }
  return { noSel: false, selRect: { w: Math.round(r.width), h: Math.round(r.height) }, list };
})()`);

/* 元素在画布坐标系里的屏幕位置（CDP 发的是顶层页面坐标） */
const spotOf = (sel) => ev(`(() => {
  const n = WD.app.E.selection[${sel}];
  if (!n) return null;
  const b = n.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);
await ev('(async () => { await WD.app.loadSample(); return true; })()');
await ev('(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()');
await sleep(900);

/* ── [1] 工具条彻底不存在 ─────────────────────────────────────── */
console.log('\n[1] 浮动工具条已整条删除');
const gone = await ev(`(() => ({
  dom: !document.getElementById('ov-toolbar'),
  css: Array.from(document.styleSheets).some((s) => {
    try { return Array.from(s.cssRules).some((r) => /ov-toolbar/.test(r.cssText)); }
    catch (e) { return false; }
  }),
  symbols: ['ic-edit-text','ic-dup','ic-front','ic-back','ic-del']
    .filter((s) => document.getElementById(s)).length,
}))()`);
check('DOM 里没有 #ov-toolbar', gone.dom === true);
check('样式表里没有 .ov-toolbar 规则', gone.css === false);
check('配套的 5 个图标 symbol 已一并清掉', gone.symbols === 0, String(gone.symbols));

/* ── [2] 选中元素后画布上没有任何东西压住它 ─────────────────────── */
console.log('\n[2] 选中元素后画布零遮挡');
const spot = await ev(`(() => {
  const n = WD.app.E.stage.getDoc().querySelector('h1');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await clickAt(spot.x, spot.y);
const sel0 = await ev(`(() => ({
  n: (WD.app.E.selection || []).length,
  box: !document.getElementById('frame-box').hidden,
}))()`);
check('元素确实被选中了（选区功能没被误删）', sel0.n === 1, JSON.stringify(sel0));
check('选择框仍然可见', sel0.box === true);
const oc1 = await occluders();
check('★ 选中元素上面没有任何外来元素（手柄属选中态，不算）', oc1.list.length === 0, JSON.stringify(oc1.list));

/* 右栏各段的「隐藏」必须是真隐藏。
   坑：`.insp-sec` 是 display:flex，作者样式会盖掉浏览器默认的 [hidden]{display:none}，
   于是 el.hidden === true 而屏幕上照样显示 —— 只查属性的断言抓不到。 */
const secVis = await ev(`(() => Array.from(document.querySelectorAll('.insp-sec')).map((s) => ({
  id: s.id, hidden: s.hidden, display: getComputedStyle(s).display,
})))()`);
check('右栏所有标了 hidden 的段在屏幕上真的不显示',
  secVis.every((s) => !(s.hidden && s.display !== 'none')), JSON.stringify(secVis));

/* ── [3] 换缩放级别：各档位都零遮挡，手柄仍是恒定屏幕尺寸 ────────── */
console.log('\n[3] 缩放各档位下依然零遮挡');
const applied = () => ev(`(() => {
  const t = getComputedStyle(document.querySelector('.stage')).transform;
  if (!t || t === 'none') return 1;
  const m = t.match(/matrix\\(([^)]+)\\)/);
  return m ? +parseFloat(m[1].split(',')[0]).toFixed(4) : 1;
})()`);
const scales = [];
for (const z of [1, 0.75, 0.5, 0.35]) {
  await ev(`(async () => {
    if (typeof WD.app.E.stage.setZoom === 'function') { WD.app.E.stage.setZoom(${z}); return true; }
    return false;
  })()`);
  await sleep(420);
  const sc = await applied();
  const oc = await occluders();
  const h = await ev(`(() => {
    const b = document.querySelector('#frame-box .handle');
    if (!b) return 0;
    const r = b.getBoundingClientRect();
    return +Math.min(r.width, r.height).toFixed(1);
  })()`);
  scales.push({ z, scale: sc, occ: oc.list.length, handle: h });
  console.log('  缩放档位 ' + z + '（实际 ' + Math.round(sc * 100) + '%）→ 遮挡 ' + oc.list.length + ' 处，手柄 ' + h + 'px');
}
check('★ 缩放确实变了（至少两个不同档位）',
  new Set(scales.map((s) => s.scale)).size >= 2, JSON.stringify(scales.map((s) => s.scale)));
check('★ 每个缩放档位下都是零遮挡', scales.every((s) => s.occ === 0),
  JSON.stringify(scales.filter((s) => s.occ)));
check('手柄在各档位仍是可点的屏幕尺寸（≥ 10px，counter-scale 没丢）',
  scales.every((s) => s.handle >= 10), JSON.stringify(scales.map((s) => s.handle)));

/* ── [4] 元素贴画布边缘：选择框不出界，且依然零遮挡 ─────────────── */
console.log('\n[4] 贴边元素');
await ev('(async () => { WD.app.E.stage.fit(); return true; })()');
await sleep(420);
await clickAt(spot.x, spot.y);
const edge = await ev(`(async () => {
  const E = WD.app._internal;
  const n = WD.app.E.stage.getDoc().querySelector('h1');
  n.style.left = '1600px'; n.style.top = '30px';
  E.refreshOverlay();
  await new Promise(r => setTimeout(r, 320));
  const stage = document.querySelector('.stage');
  const sr = stage.getBoundingClientRect();
  const b = document.getElementById('frame-box').getBoundingClientRect();
  return { overR: +(b.right - sr.right).toFixed(1), overT: +(sr.top - b.top).toFixed(1) };
})()`);
check('元素贴右缘时选择框不超出画布', edge.overR <= 1, '超出 ' + edge.overR + 'px');
check('元素贴顶缘时选择框不超出画布', edge.overT <= 1, '超出 ' + edge.overT + 'px');
const ocEdge = await occluders();
check('贴边时也是零遮挡', ocEdge.list.length === 0, JSON.stringify(ocEdge.list));

/* ── [5] 删掉工具条后，那 5 件事仍然做得成 ───────────────────────── */
console.log('\n[5] 原工具条的 5 个功能仍有等价路径（真实事件驱动）');
const countEls = () => ev(`WD.app.E.stage.getDoc().querySelectorAll('*').length`);

/* 5.1 复制 = Ctrl+D */
const c0 = await countEls();
await keyCombo('d', 'KeyD', 2);
const c1 = await countEls();
check('Ctrl+D 能复制元素（原「复制」键的等价路径）', c1 > c0, c0 + ' → ' + c1);

/* 5.2 删除 = Delete 键 */
await clickAt(spot.x, spot.y);
const c2 = await countEls();
await keyCombo('Delete', 'Delete', 0);
const c3 = await countEls();
check('Delete 键能删除元素（原「删除」键的等价路径）', c3 < c2, c2 + ' → ' + c3);

/* 5.3 层级 = Ctrl+] / Ctrl+[ （上移 / 下移一层）
   观测的是**DOM 兄弟顺序**而不是 z-index：layerAction('up'/'down') 做的是
   与相邻同级元素交换绘制顺序，本来没有 z-index 的元素 z 值一直是 0，
   拿 z-index 当判据会得出「没生效」的假结论。 */
await clickAt(spot.x, spot.y);
const domIdx = () => ev(`(() => {
  const n = WD.app.E.selection[0];
  if (!n) return -1;
  return Array.prototype.indexOf.call(n.parentNode.children, n);
})()`);
const i0 = await domIdx();
let iUp = i0;
for (let i = 0; i < 3 && iUp === i0; i++) { await keyCombo(']', 'BracketRight', 2); iUp = await domIdx(); }
check('Ctrl+] 能上移一层（原层级键的等价路径）', iUp > i0, i0 + ' → ' + iUp);
let iDown = iUp;
for (let i = 0; i < 3 && iDown === iUp; i++) { await keyCombo('[', 'BracketLeft', 2); iDown = await domIdx(); }
check('Ctrl+[ 能下移一层（原层级键的等价路径）', iDown < iUp, iUp + ' → ' + iDown);

/* 5.4 编辑文字 = 双击 */
await clickAt(spot.x, spot.y, { clickCount: 2 });
await sleep(500);
const editing = await ev(`(() => ({
  editing: !!WD.app.E.editing,
  tag: WD.app.E.editing ? (WD.app.E.editing.tagName || '') : '',
}))()`);
check('双击能进入文字编辑（原「编辑文字」键的等价路径）', editing.editing === true, JSON.stringify(editing));
await keyCombo('Escape', 'Escape', 0);
await sleep(200);

/* 5.5 改完之后画布依旧是零遮挡（撤销会重建文档，顺带验一遍） */
await keyCombo('z', 'KeyZ', 2);
await sleep(500);
await clickAt(spot.x, spot.y);
const oc5 = await occluders();
check('撤销重做之后依然零遮挡', oc5.list.length === 0, JSON.stringify(oc5.list));

console.log('\n通过 ' + pass + '  失败 ' + fail);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
check('控制台零异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
ws.close();
process.exit(0);
