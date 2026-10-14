/* 面板折叠 / 展开回归。
   原 bug：展开按钮就在面板的 .panel-head 里，而折叠时 .panel-head 是 display:none，
   于是收起后按钮消失、再也点不回来。
   这里用**真实鼠标点击**验证：收起 → 拉手出现 → 点拉手能展开。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9430);
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
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(20);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(320);
}
/* 点击某个元素（按它自己的中心坐标），返回是否命中该元素 */
async function clickEl(selector) {
  const box = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return { x: Math.round(cx), y: Math.round(cy),
             top: top ? top.tagName + (top.id ? '#' + top.id : '') : null,
             self: el === top || el.contains(top) };
  })()`);
  if (!box) return { clicked: false, reason: '元素不可见或尺寸为 0' };
  await clickAt(box.x, box.y);
  return { clicked: true, top: box.top, self: box.self };
}
/* 顶栏的「面板」按钮已按要求移除，一键显隐两侧改绑到 Ctrl+\。
   这里发**真实**键盘事件，而不是调内部函数 ——
   走一遍真实链路才能证明快捷键确实接上了。 */
async function toggleBothPanels() {
  await ev(`(() => { document.body.focus(); return true; })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '\\', code: 'Backslash',
    windowsVirtualKeyCode: 220, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '\\', code: 'Backslash',
    windowsVirtualKeyCode: 220, modifiers: 2 });
  await sleep(320);
}

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? '   ' + detail : '')); }
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

const state = () => ev(`(() => {
  const sb = document.getElementById('sidebar'), insp = document.getElementById('inspector');
  const lt = document.getElementById('btn-rail-open'), rt = document.getElementById('btn-insp-open');
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect();
    return !el.hidden && r.width > 1 && r.height > 1 && getComputedStyle(el).display !== 'none'; };
  return {
    sidebarCollapsed: sb.classList.contains('collapsed'),
    inspCollapsed: insp.classList.contains('collapsed'),
    sidebarW: Math.round(sb.getBoundingClientRect().width),
    inspW: Math.round(insp.getBoundingClientRect().width),
    railTabVisible: vis(lt),
    inspTabVisible: vis(rt),
    railTabHitTarget: document.elementFromPoint(
      lt.getBoundingClientRect().left + 11, lt.getBoundingClientRect().top + 31
    ) ? (function () { const n = document.elementFromPoint(lt.getBoundingClientRect().left + 11, lt.getBoundingClientRect().top + 31); return n.id || n.tagName; })() : null,
  };
})()`);

/* ══ 1. 左栏收起 → 拉手出现 → 点拉手展开 ══ */
console.log('\n[1] 左栏收起 / 展开');
{
  const before = await state();
  check('初始左栏是展开的', before.sidebarCollapsed === false && before.sidebarW > 40,
    JSON.stringify(before));
  const c = await clickEl('#btn-rail-collapse');
  check('能点到「收起左栏」按钮', c.clicked && c.self, JSON.stringify(c));
  const collapsed = await state();
  check('左栏已收起（宽度归零）', collapsed.sidebarCollapsed === true && collapsed.sidebarW <= 1,
    JSON.stringify(collapsed));
  check('收起后出现「展开左栏」拉手', collapsed.railTabVisible === true,
    JSON.stringify(collapsed));

  const o = await clickEl('#btn-rail-open');
  check('拉手可点（没有被别的元素盖住）', o.clicked && o.self, JSON.stringify(o));
  const reopened = await state();
  check('点拉手后左栏恢复展开', reopened.sidebarCollapsed === false && reopened.sidebarW > 40,
    JSON.stringify(reopened));
}

/* ══ 2. 右栏收起 → 拉手出现 → 点拉手展开 ══ */
console.log('\n[2] 右栏收起 / 展开');
{
  const c = await clickEl('#btn-insp-collapse');
  check('能点到「收起右栏」按钮', c.clicked && c.self, JSON.stringify(c));
  const collapsed = await state();
  check('右栏已收起', collapsed.inspCollapsed === true && collapsed.inspW <= 1, JSON.stringify(collapsed));
  check('收起后出现「展开右栏」拉手', collapsed.inspTabVisible === true, JSON.stringify(collapsed));

  const o = await clickEl('#btn-insp-open');
  check('拉手可点（没有被别的元素盖住）', o.clicked && o.self, JSON.stringify(o));
  const reopened = await state();
  check('点拉手后右栏恢复展开', reopened.inspCollapsed === false && reopened.inspW > 40,
    JSON.stringify(reopened));
}

/* ══ 3. 两栏同时收起 / Ctrl+\ 恢复 ══ */
console.log('\n[3] 两栏同时收起，Ctrl+\\ 恢复');
{
  await clickEl('#btn-rail-collapse');
  await clickEl('#btn-insp-collapse');
  const both = await state();
  check('两栏都已收起', both.sidebarCollapsed && both.inspCollapsed, JSON.stringify(both));
  check('两个拉手都可见', both.railTabVisible && both.inspTabVisible, JSON.stringify(both));

  check('顶栏「面板」按钮已移除', !(await ev(`!!document.getElementById('btn-panels')`)));
  await toggleBothPanels();
  const back = await state();
  check('Ctrl+\\ 能一次恢复两栏',
    back.sidebarCollapsed === false && back.inspCollapsed === false,
    JSON.stringify(back));
  check('恢复后拉手自动隐藏',
    back.railTabVisible === false && back.inspTabVisible === false, JSON.stringify(back));
}

/* ══ 4. 收起 / 展开后舞台仍然可用并自动重新适配 ══ */
console.log('\n[4] 面板变化后画布自动重新适配');
{
  /* 先放一页内容，这样 stage.ready 才有意义，缩放也确实会变 */
  await ev(`(() => {
    const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
    const body = '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H
      + 'px;overflow:hidden;background:#fff"><div id="box" style="position:absolute;left:200px;top:200px;width:600px;height:360px;background:#e8eef7"></div></div>';
    WD.app.loadDeck({ title: 'p', style: '', slides: [
      { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 'p1', bodyHtml: body }) }
    ]}, 'panel-test.html');
    return true;
  })()`);
  const ready = await ev(`(async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (WD.app.E.stage.ready && WD.app.E.stage.getDoc().querySelector('#box')) return true;
    }
    return false;
  })()`);
  check('测试页已就绪', ready === true);

  const openState = await ev(`(() => {
    const st = WD.app.E.stage;
    return { scale: st.scale, canvas: document.getElementById('stage-canvas').getBoundingClientRect().width };
  })()`);

  await clickEl('#btn-rail-collapse');
  await clickEl('#btn-insp-collapse');
  await sleep(350);
  const collapsed = await ev(`(() => {
    const st = WD.app.E.stage;
    return { scale: st.scale, canvas: document.getElementById('stage-canvas').getBoundingClientRect().width,
             frameW: Math.round(st.el.getBoundingClientRect().width) };
  })()`);
  check('两栏收起后画布变宽、舞台放大', collapsed.canvas > openState.canvas + 100 && collapsed.scale > openState.scale,
    `画布 ${Math.round(openState.canvas)} → ${Math.round(collapsed.canvas)}，缩放 ${openState.scale.toFixed(3)} → ${collapsed.scale.toFixed(3)}`);

  await toggleBothPanels();
  await sleep(350);
  const back = await ev(`(() => {
    const st = WD.app.E.stage;
    return { scale: st.scale, canvas: document.getElementById('stage-canvas').getBoundingClientRect().width };
  })()`);
  check('恢复两栏后舞台缩回适配', Math.abs(back.scale - openState.scale) < 0.02 && back.canvas <= collapsed.canvas,
    `缩放回到 ${back.scale.toFixed(3)}（原 ${openState.scale.toFixed(3)}）`);

  /* 面板变化后仍能正常点选元素 */
  await clickEl('#btn-rail-collapse');
  await sleep(320);
  const ok = await ev(`(() => {
    const st = WD.app.E.stage;
    const r = st.el.getBoundingClientRect();
    const doc = st.getDoc();
    const node = doc.querySelector('#box');
    const br = node.getBoundingClientRect();
    st.getWin();
    WD.app._internal.setSelection([node]);
    return { sel: (WD.app.E.selection || []).length, overlay: !document.getElementById('frame-box').hidden,
             stageRect: [Math.round(r.left), Math.round(r.top)] , boxRect: [Math.round(br.left), Math.round(br.top)] };
  })()`);
  check('面板收起后仍能选中元素并显示选择框', ok.sel === 1 && ok.overlay === true, JSON.stringify(ok));
}

console.log('\n' + '='.repeat(60));
console.log(`面板折叠回归: ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败项:'); failures.forEach(f => console.log('  - ' + f)); }
if (pageErrors.length) { console.log('\n页面错误:'); pageErrors.slice(0, 6).forEach(e => console.log('  ! ' + String(e).slice(0, 160))); }
ws.close();
process.exit(fail ? 2 : 0);
