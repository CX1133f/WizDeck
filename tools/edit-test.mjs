/* ============================================================================
   WizDeck 编辑交互回归
     用 CDP 的 Input.dispatchMouseEvent / dispatchKeyEvent 发真实输入事件，
     而不是直接调内部函数 —— 只有真实事件才能暴露坐标换算、pointer capture、
     transform 缩放这类「看起来对、用起来错」的问题。

   用法：node tools/edit-test.mjs <chrome.exe> <port>
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9350);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CDP ─────────────────────────────────────────────────────────────── */

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message + ' ' + JSON.stringify(m.error.data || ''))) : p.resolve(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) || []).forEach((fn) => fn(m.params));
      }
    });
  }
  on(m, fn) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result.value;
  }
  /* 真实鼠标：按下 → 分步移动 → 抬起 */
  async drag(from, to, opts = {}) {
    const steps = opts.steps || 8;
    const button = opts.button || 'left';
    const modifiers = opts.modifiers || 0;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', modifiers });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, clickCount: 1, buttons: 1, modifiers });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps;
      const y = from.y + (to.y - from.y) * i / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons: 1, modifiers });
      await sleep(8);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button, buttons: 0, clickCount: 1, modifiers });
    await sleep(60);
  }
  async click(x, y, opts = {}) {
    const button = opts.button || 'left';
    const clickCount = opts.clickCount || 1;
    /* 修饰键必须直接带在鼠标事件上：dispatchKeyEvent 设置的修饰状态
       不会自动延续到后续的鼠标事件。 */
    const modifiers = opts.modifiers || 0;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, buttons: 1, modifiers });
    await sleep(20);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers });
    await sleep(80);
  }
  async key(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(12);
    }
  }
  /* 组合键，例如 Ctrl+Z / Delete / ArrowLeft */
  async keyCombo(key, code, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code, windowsVirtualKeyCode: KEYCODES[key] || 0, modifiers,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: KEYCODES[key] || 0, modifiers,
    });
    await sleep(70);
  }
}

const KEYCODES = {
  Delete: 46, Backspace: 8, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  z: 90, Z: 90, d: 68, D: 68, a: 65, A: 65, c: 67, C: 67, v: 86, V: 86, Enter: 13, F5: 116,
};

async function resolvePageWs(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
      const made = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      if (made && made.webSocketDebuggerUrl) return made.webSocketDebuggerUrl;
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error('无法连接 Chromium: ' + (lastErr && lastErr.message));
}

/* ── 断言小工具 ───────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++; failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '   ' + detail : ''));
  }
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */

const ws = new WebSocket(await resolvePageWs(PORT));
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
});
const cdp = new CDP(ws);
const consoleErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails || {};
  consoleErrors.push((d.exception && d.exception.description) || d.text);
});
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
});

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

/* 载入一份结构清晰的测试稿：一个可拖动的标题 + 一个卡片 + 两行文字。
   每个用例前都调一次，保证互不污染 —— 否则前一个用例挪动过的元素
   会让后一个用例点到空处，诊断出一堆假失败。 */
const resetDeck = () => cdp.eval(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const body = [
    '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff">',
    '<div id="card" style="position:absolute;left:200px;top:200px;width:600px;height:360px;background:#eef2f7;border-radius:20px"></div>',
    '<h1 id="head" style="position:absolute;left:200px;top:620px;margin:0;font-size:72px;font-weight:900;color:#1b2430">可拖动标题</h1>',
    '<p id="para" style="position:absolute;left:200px;top:740px;margin:0;font-size:28px;color:#46586c">这是一段可编辑的正文。</p>',
    '</div>'
  ].join('');
  const doc = WD.parse.buildSlideDoc({ title: '编辑测试', bodyHtml: body });
  WD.app.loadDeck({ title: '编辑测试', style: '', slides: [
    { id: 's1', name: '第 1 页', title: '编辑测试', layout: 'content', notes: '', doc: doc },
    { id: 's2', name: '第 2 页', title: '第二页', layout: 'blank', notes: '', doc: WD.parse.blankSlideDoc('', { layout: 'blank' }) },
  ]}, 'edit-test.html');
  return true;
})()`).then(() => sleep(1400));

await resetDeck();

/* 工具：把画布坐标（1920×1080 空间）换算成屏幕坐标 */
const stageInfo = await cdp.eval(`(() => {
  const st = WD.app.E.stage;
  const r = st.el.getBoundingClientRect();
  return { left: r.left, top: r.top, scale: st.scale, ready: st.ready };
})()`);
console.log('舞台:', JSON.stringify(stageInfo));
const toScreen = (x, y) => ({
  x: Math.round(stageInfo.left + x * stageInfo.scale),
  y: Math.round(stageInfo.top + y * stageInfo.scale),
});

/* 读取模型里某个元素的几何（从序列化文档里解析内联样式） */
const geomOf = (sel) => cdp.eval(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const el = doc.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const cs = doc.defaultView.getComputedStyle(el);
  return { left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0,
           width: cs.width, height: cs.height,
           position: cs.position, transform: cs.transform, fontSize: cs.fontSize,
           color: cs.color, background: cs.backgroundColor };
})()`);

const selectionInfo = () => cdp.eval(`(() => {
  const s = WD.app.E.selection || [];
  const doc = WD.app.E.stage.getDoc();
  return {
    count: s.length,
    labels: s.map(function (n) { return n.tagName + (n.id ? '#' + n.id : ''); }),
    overlayVisible: !document.getElementById('frame-box').hidden,
    toolbarGone: !document.getElementById('ov-toolbar'),
    inspectorElementVisible: !document.getElementById('sec-element').hidden,
    editing: !!WD.app.E.editing,
  };
})()`);

/* ══ 1. 选中 ══ */
console.log('\n[1] 点选元素');
{
  const before = await selectionInfo();
  const p = toScreen(500, 380);          // 落在 #card 里
  await cdp.click(p.x, p.y);
  const sel = await selectionInfo();
  check('点击卡片后产生选中', sel.count === 1, JSON.stringify(sel));
  check('选中标签是 card', (sel.labels[0] || '').indexOf('card') >= 0, JSON.stringify(sel.labels));
  check('选择框可见', sel.overlayVisible === true);
  check('浮动工具条已从 DOM 里彻底移除', sel.toolbarGone === true);
  check('检查器切到元素属性', sel.inspectorElementVisible === true);
}

/* ══ 2. 拖动 ══ */
console.log('\n[2] 拖动元素');
{
  const g0 = await geomOf('#card');
  const from = toScreen(500, 380);
  const to = toScreen(660, 480);         // 目标：+160, +100 画布像素
  await cdp.drag(from, to);
  const g1 = await geomOf('#card');
  const dx = Math.round(g1.left - g0.left);
  const dy = Math.round(g1.top - g0.top);
  check('拖动后 left 增加约 160px', Math.abs(dx - 160) <= 6, `实际 dx=${dx}（期望 160）`);
  check('拖动后 top 增加约 100px', Math.abs(dy - 100) <= 6, `实际 dy=${dy}（期望 100）`);
  check('拖动后仍是绝对定位', g1.position === 'absolute', g1.position);
}

/* ══ 3. 撤销 / 重做 ══ */
console.log('\n[3] 撤销与重做');
{
  const gDragged = await geomOf('#card');
  await cdp.keyCombo('z', 'KeyZ', 2);    // Ctrl+Z
  const gUndo = await geomOf('#card');
  check('Ctrl+Z 撤销了拖动', Math.abs(gUndo.left - 200) <= 6,
    `left=${gUndo.left}（期望回到 200），拖动后曾是 ${gDragged.left}`);
  await cdp.keyCombo('z', 'KeyZ', 10);   // Ctrl+Shift+Z
  const gRedo = await geomOf('#card');
  check('Ctrl+Shift+Z 重做了拖动', Math.abs(gRedo.left - gDragged.left) <= 6,
    `left=${gRedo.left}（期望 ${gDragged.left}）`);
}

/* ══ 4. 缩放（拖右下角手柄） ══ */
console.log('\n[4] 拖角缩放');
{
  await resetDeck();
  const geo = await cdp.eval(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const win = WD.app.E.stage.getWin();
    const out = { sel: (WD.app.E.selection||[]).length, drag: !!WD.app.E.drag, editing: !!WD.app.E.editing,
                  activeEl: document.activeElement ? document.activeElement.tagName : null };
    const root = WD.render.findRoot(doc);
    out.rootChildren = Array.prototype.map.call(root.children, function (c) {
      const r = c.getBoundingClientRect();
      const cs = win.getComputedStyle(c);
      return { tag: c.tagName + (c.id ? '#'+c.id : ''), pos: cs.position, display: cs.display, z: cs.zIndex,
               rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    });
    out.hitAt500 = (function(){ const n = doc.elementFromPoint(500,380); return n ? n.tagName + (n.id?'#'+n.id:'') + (n === root ? ' [ROOT]' : '') : null; })();
    out.hitAt500_501 = (function(){ const n = doc.elementFromPoint(501,380); return n ? n.tagName + (n.id?'#'+n.id:'') + (n === root ? ' [ROOT]' : '') : null; })();
    out.hitAt300660 = (function(){ const n = doc.elementFromPoint(300,660); return n ? n.tagName + (n.id?'#'+n.id:'') : null; })();
    out.rootRect = JSON.stringify(root.getBoundingClientRect());
    out.scroll = [doc.documentElement.scrollLeft, doc.documentElement.scrollTop];
    out.dpr = win.devicePixelRatio;
    return out;
  })()`);
  console.log('  几何:', JSON.stringify(geo));
  /* 缩放手柄只在「已选中某元素」时才存在，先选中卡片 */
  const cp = toScreen(500, 380);
  await cdp.click(cp.x, cp.y);
  await sleep(220);
  const selNow = await selectionInfo();
  check('缩放前卡片已被选中（手柄才存在）',
    selNow.count === 1 && selNow.overlayVisible === true, JSON.stringify(selNow));
  const g0 = await geomOf('#card');
  const w0 = parseFloat(g0.width);
  /* 必须用手柄自己的 bounding rect 求中心：
     手柄带 counter-scale，几何中心不等于元素右下角，取错点会点到 iframe。 */
  const h = await cdp.eval(`(() => {
    const el = document.querySelector('#frame-box .handle.h-se');
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             topEl: top ? (top.tagName + '.' + String(top.className).split(' ')[0]) : null,
             frameBoxHidden: document.getElementById('frame-box').hidden };
  })()`);
  const to = { x: h.x + Math.round(80 * stageInfo.scale), y: h.y + Math.round(60 * stageInfo.scale) };
  await cdp.drag(h, to, { steps: 10 });
  const g1 = await geomOf('#card');
  const w1 = parseFloat(g1.width);
  check('拖右下角后宽度增加约 80px', Math.abs((w1 - w0) - 80) <= 8,
    `宽度 ${w0} → ${w1}（期望 +80）；手柄中心 (${h.x},${h.y}) 命中 ${h.topEl}；frameBoxHidden=${h.frameBoxHidden}`);
  const dragGone = await cdp.eval(`(() => !WD.app.E.drag)()`);
  check('缩放结束后 drag 状态已清理', dragGone === true,
    'drag 若残留会堵死后续所有快捷键');
}

/* ══ 5. 双击进入文字编辑 ══ */
console.log('\n[5] 双击改文字');
{
  const hp = toScreen(300, 660);         // 落在 #head 文字上
  await cdp.click(hp.x, hp.y);
  await cdp.click(hp.x, hp.y, { clickCount: 2 });
  await sleep(200);
  const sel = await selectionInfo();
  check('双击后进入文字编辑态', sel.editing === true, JSON.stringify(sel));

  // 全选后替换
  await cdp.eval(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const el = WD.app.E.editing;
    if (!el) return false;
    const r = doc.createRange(); r.selectNodeContents(el);
    const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r);
    return true;
  })()`);
  await cdp.key('改过的标题');
  await sleep(150);
  await cdp.keyCombo('Escape', 'Escape');
  await sleep(200);
  const txt = await cdp.eval(`(() => {
    const doc = WD.app.E.stage.getDoc();
    return (doc.querySelector('#head').textContent || '').trim();
  })()`);
  check('文字已被替换', txt === '改过的标题', `实际="${txt}"`);
  const persisted = await cdp.eval(`(() => {
    const doc = WD.parse.parseHtml(WD.store.slide().doc, 'about:blank').doc;
    return (doc.querySelector('#head').textContent || '').trim();
  })()`);
  check('文字改动写回了模型', persisted === '改过的标题', `模型里="${persisted}"`);
}

/* ══ 6. 改样式（检查器输入框） ══ */
console.log('\n[6] 检查器改样式');
{
  const p = toScreen(500, 380);
  await cdp.click(p.x, p.y);             // 重新选中卡片
  await sleep(150);
  // 直接操作检查器输入框并派发 change 事件
  await cdp.eval(`(() => {
    const inp = document.getElementById('f-fill-text');
    inp.value = '#ff0000';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const g = await geomOf('#card');
  const isRed = /255,\\s*0,\\s*0/.test(g.background) || g.background === 'rgb(255, 0, 0)';
  check('填充色改为红色', isRed, g.background);
}

/* ══ 7. 键盘微调 ══ */
console.log('\n[7] 方向键微调');
{
  await resetDeck();
  /* 先明确选中卡片，避免被上一步的样式改动影响 */
  const cp = toScreen(500, 380);
  await cdp.click(cp.x, cp.y);
  await sleep(200);
  const selNow = await cdp.eval(`(() => ({
    labels: (WD.app.E.selection || []).map(n => n.tagName + (n.id ? '#'+n.id : '')),
    drag: !!WD.app.E.drag, editing: !!WD.app.E.editing,
    activeEl: document.activeElement ? document.activeElement.tagName : null,
  }))()`);
  const g0 = await geomOf('#card');
  await cdp.keyCombo('ArrowRight', 'ArrowRight');
  await cdp.keyCombo('ArrowRight', 'ArrowRight');
  await sleep(400);
  const g1 = await geomOf('#card');
  const dx = Math.round(g1.left - g0.left);
  check('两次右键移动 2px', Math.abs(dx - 2) <= 1,
    `dx=${dx}；选中=${JSON.stringify(selNow.labels)} drag=${selNow.drag} editing=${selNow.editing} active=${selNow.activeEl}`);
  await cdp.keyCombo('ArrowDown', 'ArrowDown', 8);   // Shift+Down = 10px
  await sleep(400);
  const g2 = await geomOf('#card');
  const dy = Math.round(g2.top - g1.top);
  check('Shift+下键移动 10px', Math.abs(dy - 10) <= 1, `dy=${dy}`);
}

/* ══ 8. 删除元素 ══ */
console.log('\n[8] 删除元素');
{
  await resetDeck();
  /* 前面的缩放可能让卡片盖住段落，先把它挪开，保证删除的是目标段落 */
  await cdp.eval(`(() => {
    const el = WD.app.E.stage.getDoc().querySelector('#card');
    el.style.left = '1300px'; el.style.top = '120px';
    el.style.width = '500px'; el.style.height = '300px';
    return true;
  })()`);
  await sleep(200);
  const exists0 = await cdp.eval(`(() => !!WD.app.E.stage.getDoc().querySelector('#para'))()`);
  const pp = toScreen(300, 760);
  await cdp.click(pp.x, pp.y);
  await sleep(200);
  const selNow = await cdp.eval(`(() => (WD.app.E.selection||[]).map(n => n.tagName + (n.id ? '#'+n.id : '')))()`);
  await cdp.keyCombo('Delete', 'Delete');
  await sleep(250);
  const exists1 = await cdp.eval(`(() => !!WD.app.E.stage.getDoc().querySelector('#para'))()`);
  check('Delete 删除了选中的段落', exists0 && !exists1,
    `before=${exists0} after=${exists1} 选中的是 ${JSON.stringify(selNow)}`);
  await cdp.keyCombo('z', 'KeyZ', 2);
  await sleep(300);
  const back = await cdp.eval(`(() => !!WD.app.E.stage.getDoc().querySelector('#para'))()`);
  check('撤销恢复了被删段落', back === true);
}

/* ══ 9. 多选与对齐 ══ */
console.log('\n[9] 多选与对齐');
{
  await resetDeck();
  await cdp.eval(`(() => { WD.app.debug.on(); WD.app.debug.clear(); return true; })()`);
  const p1 = toScreen(500, 380);
  await cdp.click(p1.x, p1.y);
  await sleep(150);
  const one = await selectionInfo();
  const p2 = toScreen(300, 660);
  await cdp.click(p2.x, p2.y, { modifiers: 8 });   // 8 = Shift
  await sleep(250);
  const sel = await selectionInfo();
  const dbg = await cdp.eval(`(() => WD.app.debug.log())()`);
  check('Shift+点击形成多选', sel.count >= 2,
    `先 ${one.count} 个 → 后 ${sel.count} 个 ${JSON.stringify(sel.labels)}；日志=${JSON.stringify(dbg)}`);
  check('多选后画布上仍然没有任何浮层控件', sel.toolbarGone === true);
}

/* ══ 10. 复制粘贴元素 ══ */
console.log('\n[10] 复制元素');
{
  await resetDeck();
  const p = toScreen(500, 380);
  await cdp.click(p.x, p.y);
  await sleep(120);
  const before = await cdp.eval(`(() => WD.app.E.stage.getDoc().querySelectorAll('[data-wd-root] *').length)()`);
  await cdp.keyCombo('d', 'KeyD', 2);    // Ctrl+D
  await sleep(250);
  const after = await cdp.eval(`(() => WD.app.E.stage.getDoc().querySelectorAll('[data-wd-root] *').length)()`);
  check('Ctrl+D 复制出新的元素', after > before, `${before} → ${after}`);
  await cdp.keyCombo('z', 'KeyZ', 2);
  await sleep(250);
}

/* ══ 11. 翻页后编辑仍然可用 ══ */
console.log('\n[11] 翻页');
{
  await cdp.eval(`(() => { WD.store.goto(1); return true; })()`);
  await sleep(900);
  const info = await cdp.eval(`(() => ({
    ready: WD.app.E.stage.ready,
    current: WD.store.current,
    text: (WD.app.E.stage.getDoc().body.textContent || '').trim().slice(0, 20),
  }))()`);
  check('切到第 2 页后舞台就绪', info.ready === true && info.current === 1, JSON.stringify(info));
  await cdp.eval(`(() => { WD.store.goto(0); return true; })()`);
  await sleep(800);
}

/* ══ 汇总 ══ */
console.log('\n' + '='.repeat(66));
console.log(`编辑交互回归: ${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  - ' + f));
}
if (consoleErrors.length) {
  console.log('\n控制台错误:');
  consoleErrors.slice(0, 12).forEach((e) => console.log('  ! ' + String(e).slice(0, 220)));
}
await cdp.send('Page.captureScreenshot', { format: 'png' }).then((s) => {
  fs.mkdirSync('tmp/edit', { recursive: true });
  fs.writeFileSync('tmp/edit/after.png', Buffer.from(s.data, 'base64'));
}).catch(() => {});

ws.close();
process.exit(fail ? 2 : 0);
