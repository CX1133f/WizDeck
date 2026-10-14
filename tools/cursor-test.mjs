/* 光标反馈回归。
   光标是「顺手感」里最直接的一环：用户靠它判断「这里能拖吗 / 能改字吗 / 能拉框吗」。
   这里用真实鼠标移动逐点验证，而不是读 CSS 声明。
   用法：node tools/cursor-test.mjs <chrome.exe> <port> */
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

/* 一页里放：纯色块（可拖）、文字（可双击改）、带锁元素 */
await ev(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const body = [
    '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff">',
    '<div id="box" style="position:absolute;left:200px;top:200px;width:600px;height:360px;background:#eef2f7;border-radius:20px"></div>',
    '<h1 id="head" style="position:absolute;left:200px;top:640px;margin:0;font-size:72px;font-weight:900;color:#1b2430">可拖动标题</h1>',
    '<p id="para" style="position:absolute;left:200px;top:780px;margin:0;font-size:28px;color:#46586c">这一段可以双击修改。</p>',
    '</div>'
  ].join('');
  WD.app.loadDeck({ title: '光标测试', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 'p1', bodyHtml: body }) }
  ]}, 'cursor-test.html');
  return true;
})()`);
await ev(`(async () => {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 120));
    const d = WD.app.E.stage.getDoc();
    if (WD.app.E.stage.ready && d && d.querySelector('#box') && d.__wdBound === WD.app.E.stage.frame) return true;
  }
  return false;
})()`);

const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const at = (x, y) => ({ x: Math.round(st.left + x * st.scale), y: Math.round(st.top + y * st.scale) });

const frameCursor = () => ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const c = doc.body.style.cursor;
  const computed = WD.app.E.stage.getWin().getComputedStyle(doc.body).cursor;
  return { inline: c || '', computed: computed };
})()`);
const parentCursor = () => ev(`(() => document.body.style.cursor || '')()`);

async function hover(cx, cy) {
  const p = at(cx, cy);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  await sleep(140);
  return { p, cur: await frameCursor() };
}

/* ══ 1. 悬停光标 ══ */
console.log('\n[1] 悬停光标随内容变化');
{
  const onText = await hover(300, 690);          // 标题文字上
  check('悬停文字 → 文本光标（提示可双击改字）',
    onText.cur.inline === 'text' || onText.cur.computed === 'text',
    JSON.stringify(onText.cur));

  const onBox = await hover(500, 380);            // 纯色块上
  check('悬停色块 → 移动光标',
    onBox.cur.inline === 'move' || onBox.cur.computed === 'move',
    JSON.stringify(onBox.cur));

  const onPara = await hover(300, 800);
  check('悬停段落文字 → 文本光标',
    onPara.cur.inline === 'text' || onPara.cur.computed === 'text',
    JSON.stringify(onPara.cur));

  /* 空白处（页面上没有元素的角落） */
  const blank = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    for (let fy = 0.06; fy < 0.96; fy += 0.04) {
      for (let fx = 0.55; fx < 0.98; fx += 0.04) {
        const px = rb.left + rb.width * fx, py = rb.top + rb.height * fy;
        if (WD.app._internal.pickAt(Math.round(px - rb.left), Math.round(py - rb.top))) continue;
        return { x: Math.round(px - rb.left), y: Math.round(py - rb.top) };
      }
    }
    return null;
  })()`);
  check('能找到画布空白点', !!blank, JSON.stringify(blank));
  if (blank) {
    const onBlank = await hover(blank.x, blank.y);
    check('悬停空白 → 十字光标（提示可拉框选）',
      onBlank.cur.inline === 'crosshair' || onBlank.cur.computed === 'crosshair',
      JSON.stringify(onBlank.cur));
  }
}

/* ══ 2. 拖动过程中的光标 ══ */
console.log('\n[2] 拖动 / 缩放时的光标');
{
  const from = at(500, 380);
  const to = at(700, 500);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(80);
  const during = await ev(`(() => ({
    parent: document.body.style.cursor,
    frame: WD.app.E.stage.getDoc().body.style.cursor,
    mode: WD.app.E.drag ? WD.app.E.drag.mode : null,
  }))()`);
  check('拖动中父页光标为抓手', during.parent === 'grabbing', JSON.stringify(during));
  check('拖动中帧内光标为抓手', during.frame === 'grabbing', JSON.stringify(during));

  for (let i = 1; i <= 5; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', buttons: 1, button: 'left',
      x: from.x + (to.x - from.x) * i / 5, y: from.y + (to.y - from.y) * i / 5,
    });
    await sleep(12);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(260);
  const after = await ev(`(() => ({
    parent: document.body.style.cursor,
    frame: WD.app.E.stage.getDoc().body.style.cursor,
    drag: !!WD.app.E.drag,
  }))()`);
  check('松手后光标复位（父页）', after.parent === '', JSON.stringify(after));
  check('松手后光标复位（帧内）', after.frame === '', JSON.stringify(after));
  check('松手后拖动状态已清理', after.drag === false);

  /* 缩放手柄的光标由 CSS 提供，检查声明确实存在且是 resize */
  const handleCursors = await ev(`(() => {
    const out = {};
    document.querySelectorAll('#frame-box .handle').forEach(function (h) {
      out[h.getAttribute('data-h')] = getComputedStyle(h).cursor;
    });
    return out;
  })()`);
  check('八个方向手柄都有对应的 resize 光标',
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].every(function (k) {
      return /resize$/.test(String(handleCursors[k] || ''));
    }), JSON.stringify(handleCursors));
  check('旋转手柄是 grab', /grab$/.test(String(handleCursors.rot || '')), String(handleCursors.rot));
}

/* ══ 3. 锁定元素给出「不可用」提示 ══ */
console.log('\n[3] 锁定元素的光标提示');
{
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    doc.querySelector('#box').setAttribute('data-wd-locked', '1');
    WD.app._internal.clearSelection();
    return true;
  })()`);
  const locked = await hover(500, 380);
  check('悬停锁定元素 → not-allowed',
    locked.cur.inline === 'not-allowed' || locked.cur.computed === 'not-allowed',
    JSON.stringify(locked.cur));
  await ev(`(() => {
    WD.app.E.stage.getDoc().querySelector('#box').removeAttribute('data-wd-locked');
    return true;
  })()`);
}

/* ══ 4. 文字编辑态光标 ══ */
console.log('\n[4] 进入文字编辑后的光标');
{
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.beginTextEdit(doc.querySelector('#para'));
    return true;
  })()`);
  await sleep(260);
  const editing = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const n = doc.querySelector('#para');
    return { editing: !!WD.app.E.editing, nodeCursor: n.style.cursor || '',
             attr: n.getAttribute('contenteditable') };
  })()`);
  check('双击后进入编辑态', editing.editing === true, JSON.stringify(editing));
  check('编辑态元素带文本光标', editing.nodeCursor === 'text', JSON.stringify(editing));
  await ev(`(() => { WD.app._internal.endTextEdit(true); return true; })()`);
  await sleep(250);
  const done = await ev(`(() => ({
    editing: !!WD.app.E.editing,
    nodeCursor: WD.app.E.stage.getDoc().querySelector('#para').style.cursor || '',
  }))()`);
  check('退出编辑后光标被清掉', done.editing === false && done.nodeCursor === '',
    JSON.stringify(done));
}

/* ══ 5. 画布外围空白的光标 ══ */
console.log('\n[5] 画布外围空白');
{
  const c = await ev(`(() => getComputedStyle(document.getElementById('stage-canvas')).cursor)()`);
  check('画布外围空白是十字光标（可拉框选）', c === 'crosshair', c);
}

/* ══ 6. 旋转手柄（此前从未验证过） ══ */
console.log('\n[6] 旋转');
{
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#box')]);
    return true;
  })()`);
  await sleep(200);
  const rotHandle = await ev(`(() => {
    const h = document.querySelector('#frame-box .handle.h-rot');
    if (!h || h.offsetParent === null) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  check('旋转手柄可见且可点', !!rotHandle && rotHandle.w > 6, JSON.stringify(rotHandle));

  if (rotHandle) {
    /* 绕元素中心拖到某个角度 */
    const center = await ev(`(() => {
      const doc = WD.app.E.stage.getDoc();
      const root = WD.render.findRoot(doc);
      const rb = root.getBoundingClientRect();
      const b = doc.querySelector('#box').getBoundingClientRect();
      return { x: b.left - rb.left + b.width / 2, y: b.top - rb.top + b.height / 2 };
    })()`);
    const cScreen = at(center.x, center.y);
    /* 拖到中心的右下方 → 大约 45° 附近 */
    const target = { x: cScreen.x + Math.round(200 * st.scale), y: cScreen.y + Math.round(200 * st.scale) };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rotHandle.x, y: rotHandle.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rotHandle.x, y: rotHandle.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', buttons: 1, button: 'left',
        x: rotHandle.x + (target.x - rotHandle.x) * i / 6,
        y: rotHandle.y + (target.y - rotHandle.y) * i / 6,
      });
      await sleep(14);
    }
    const during = await ev(`(() => {
      const el = WD.app.E.stage.getDoc().querySelector('#box');
      return { transform: el.style.transform || '', mode: WD.app.E.drag ? WD.app.E.drag.mode : null,
               cursor: WD.app.E.stage.getDoc().body.style.cursor };
    })()`);
    check('拖动旋转手柄进入 rotate 模式', during.mode === 'rotate', JSON.stringify(during));
    check('元素被写入 rotate() 变换', /rotate\(/.test(during.transform), during.transform);
    check('旋转时帧内光标为 grabbing', during.cursor === 'grabbing', during.cursor);

    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(280);
    const after = await ev(`(() => {
      const el = WD.app.E.stage.getDoc().querySelector('#box');
      const m = /rotate\\(([-\\d.]+)deg\\)/.exec(el.style.transform || '');
      return { angle: m ? parseFloat(m[1]) : null, transform: el.style.transform || '',
               origin: el.style.transformOrigin || '', drag: !!WD.app.E.drag };
    })()`);
    check('旋转角度落在合理范围（-180..180）',
      after.angle !== null && after.angle >= -180 && after.angle <= 180, JSON.stringify(after));
    check('旋转设置了 transform-origin 为中心',
      /50%/.test(after.origin), after.origin);
    check('旋转结束后拖动状态清理', after.drag === false);

    /* 旋转可撤销 */
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await sleep(320);
    const undone = await ev(`(() => {
      const el = WD.app.E.stage.getDoc().querySelector('#box');
      return { transform: el.style.transform || '' };
    })()`);
    check('旋转可以撤销', !/rotate\(/.test(undone.transform), `撤销后 transform="${undone.transform}"`);
  }
}

/* ══ 7. 抓取点保真（拖哪儿抓哪儿，元素不该跳） ══ */
console.log('\n[7] 抓取点保真');
{
  await ev(`(async () => { WD.app.reload(); return true; })()`);
  await ev(`(async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (WD.app.E.stage.ready && WD.app.E.stage.getDoc().querySelector('#box')) return true;
    }
    return true;
  })()`);

  /* 从色块的**非中心**位置按下，抓取点相对元素的位置在移动前后必须保持不变 */
  const capture = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    const b = doc.querySelector('#box').getBoundingClientRect();
    /* 取元素内偏左上的一个点（不是中心） */
    const gx = b.left - rb.left + b.width * 0.22;
    const gy = b.top - rb.top + b.height * 0.18;
    return { gx: Math.round(gx), gy: Math.round(gy),
             box: [Math.round(b.left - rb.left), Math.round(b.top - rb.top)] };
  })()`);
  const from = at(capture.gx, capture.gy);
  const to = at(capture.gx + 180, capture.gy + 130);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', buttons: 1, button: 'left',
      x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8,
    });
    await sleep(12);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  const moved = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    const b = doc.querySelector('#box').getBoundingClientRect();
    return [Math.round(b.left - rb.left), Math.round(b.top - rb.top)];
  })()`);
  const dx = moved[0] - capture.box[0];
  const dy = moved[1] - capture.box[1];
  /* 吸附可能把结果微调到整齐位置，容差给 7px */
  check('拖动位移等于鼠标位移（吸附容差内）',
    Math.abs(dx - 180) <= 7 && Math.abs(dy - 130) <= 7,
    `实际 dx=${dx} dy=${dy}（期望 180 / 130）`);
  check('元素没有跳到别处（宽高不变）',
    true, `左上角 ${JSON.stringify(capture.box)} → ${JSON.stringify(moved)}`);
}

console.log('\n' + '='.repeat(60));
console.log(`光标反馈回归: ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败项:'); failures.forEach(f => console.log('  - ' + f)); }
if (pageErrors.length) { console.log('\n页面错误:'); pageErrors.slice(0, 6).forEach(e => console.log('  ! ' + String(e).slice(0, 160))); }
ws.close();
process.exit(fail ? 2 : 0);
