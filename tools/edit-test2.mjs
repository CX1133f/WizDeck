/* ============================================================================
   WizDeck 编辑功能回归（第二批）：对齐 / 分布 / 图层 / 框选 / 复制页 / 锁定
     这些是上一轮没写断言的「半成品区」，也是右键菜单与浮动工具条真正依赖的能力。

   用法：node tools/edit-test2.mjs <chrome.exe> <port>
   ========================================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9370);
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
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
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
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 120000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result.value;
};

/* 真实鼠标左键点击（viewport 坐标） */
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? '   ' + detail : '')); }
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

/* 三个大小不一、位置分散的方块，用来测对齐 / 分布 / 图层 */
const resetDeck = () => ev(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const box = function (id, x, y, w, h, color) {
    return '<div id="' + id + '" style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w +
      'px;height:' + h + 'px;background:' + color + '"></div>';
  };
  const body = '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff">'
    + box('a', 100, 100, 200, 100, '#e8eef7')
    + box('b', 500, 300, 300, 200, '#dce7f5')
    + box('c', 1000, 700, 160, 160, '#cfdcf0')
    + '</div>';
  window.__stageToken = (window.__stageToken || 0) + 1;
  /* 关掉可能还开着的浮层：模态/右键菜单是整屏覆盖的，
     留着会把后续所有鼠标事件都吃掉，制造一堆莫名其妙的假失败。 */
  document.getElementById('modal').hidden = true;
  document.getElementById('present').hidden = true;
  WD.app._internal.closeContextMenu();
  WD.app.loadDeck({ title: '对齐测试', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 'p1', bodyHtml: body }) },
    { id: 's2', name: 'p2', title: 'p2', layout: 'blank', notes: '', doc: WD.parse.blankSlideDoc('', { layout: 'blank' }) },
  ]}, 'align-test.html');
  return true;
})()`).then(() => waitStageReady());

/* 等舞台真正就绪：元素齐了、监听器绑上了、选择框归零 */
const waitStageReady = () => ev(`(async () => {
  for (let i = 0; i < 60; i++) {
    const doc = WD.app.E.stage.getDoc();
    const ok = WD.app.E.stage.ready && doc && doc.querySelector('#a') &&
      doc.__wdBound === WD.app.E.stage.frame;
    if (ok) {
      // 再多等一帧，确保 loadStage 的收尾（refreshOverlay / renderLayers）跑完
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
})()`);

/* 读取某元素在画布坐标里的几何 */
const geo = (sel) => ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const el = doc.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const win = WD.app.E.stage.getWin();
  const r = el.getBoundingClientRect();
  const root = WD.render.findRoot(doc).getBoundingClientRect();
  return { x: Math.round(r.left - root.left), y: Math.round(r.top - root.top),
           w: Math.round(r.width), h: Math.round(r.height),
           z: el.style.zIndex || 'auto',
           domIndex: Array.prototype.indexOf.call(el.parentNode.children, el) };
})()`);

/* 选中若干元素（走真实的选择入口，保证选择框 / 检查器同步更新） */
const selectThese = (ids) => ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const nodes = ${JSON.stringify(ids)}.map(function (i) { return doc.querySelector('#' + i); }).filter(Boolean);
  WD.app._internal.setSelection(nodes);
  return (WD.app.E.selection || []).map(function (n) { return n.id; });
})()`);

await resetDeck();

/* ══ 1. 单选对齐（相对画布） ══ */
console.log('\n[1] 单选对齐到画布');
{
  await selectThese(['a']);
  await ev(`(() => { WD.app._internal.alignAction('hcenter'); return true; })()`);
  await sleep(200);
  const g = await geo('#a');
  const expected = Math.round((1920 - g.w) / 2);
  check('单选 hcenter 让元素在画布水平居中', Math.abs(g.x - expected) <= 2,
    `x=${g.x} 期望≈${expected}`);
}

/* ══ 2. 多选对齐 ══ */
console.log('\n[2] 多选对齐');
{
  await selectThese(['a', 'b', 'c']);
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.alignAction('left');
    const rect = function (id) { const q = doc.querySelector('#' + id).getBoundingClientRect(); return Math.round(q.left); };
    return { a: rect('a'), b: rect('b'), c: rect('c'), sel: WD.app.E.selection.length };
  })()`);
  check('左对齐让三个元素左边缘一致', r.a === r.b && r.b === r.c,
    `左边缘 a=${r.a} b=${r.b} c=${r.c}`);
}

/* ══ 3. 垂直分布 ══ */
console.log('\n[3] 垂直分布');
{
  await resetDeck();
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a'), doc.querySelector('#b'), doc.querySelector('#c')]);
    WD.app._internal.alignAction('dist-v');
    const rect = function (id) { const q = doc.querySelector('#' + id).getBoundingClientRect(); return { y: q.top, h: q.height }; };
    const A = rect('a'), B = rect('b'), C = rect('c');
    // 排序后应：上边缘间距相等
    const list = [A, B, C].sort((p, q) => p.y - q.y);
    const gap1 = list[1].y - (list[0].y + list[0].h);
    const gap2 = list[2].y - (list[1].y + list[1].h);
    return { gap1: Math.round(gap1), gap2: Math.round(gap2) };
  })()`);
  check('垂直分布后间隙相等', Math.abs(r.gap1 - r.gap2) <= 2,
    `间隙 ${r.gap1} vs ${r.gap2}`);
}

/* ══ 4. 图层上下移 ══ */
console.log('\n[4] 图层顺序');
{
  await resetDeck();
  const before = await geo('#a');
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    WD.app._internal.layerAction('up');
    return true;
  })()`);
  await sleep(150);
  const afterUp = await geo('#a');
  check('上移一层让 DOM 顺序 +1', afterUp.domIndex === before.domIndex + 1,
    `domIndex ${before.domIndex} → ${afterUp.domIndex}`);

  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    WD.app._internal.layerAction('down');
    return true;
  })()`);
  await sleep(150);
  const afterDown = await geo('#a');
  check('下移一层让 DOM 顺序 -1', afterDown.domIndex === before.domIndex,
    `domIndex ${afterUp.domIndex} → ${afterDown.domIndex}（原 ${before.domIndex}）`);

  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    WD.app._internal.layerAction('front');
    return true;
  })()`);
  await sleep(150);
  const g = await geo('#a');
  const last = await ev(`(() => {
    const root = WD.render.findRoot(WD.app.E.stage.getDoc());
    return root.children.length - 1;
  })()`);
  check('置于顶层让元素成为最后一个子节点', g.domIndex === last, `domIndex=${g.domIndex} 期望=${last}`);

  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    WD.app._internal.layerAction('back');
    return true;
  })()`);
  await sleep(150);
  const gb = await geo('#a');
  check('置于底层让元素成为第一个子节点', gb.domIndex === 0, `domIndex=${gb.domIndex} 期望=0`);
}

/* ══ 5. 框选 ══ */
console.log('\n[5] 框选');
{
  await resetDeck();
  const r = await ev(`(() => {
    // 覆盖 a(100,100,200,100) 与 b(500,300,300,200)，不覆盖 c(1000,700)
    const picked = WD.app._internal.elementsInRect({ x: 50, y: 50, x2: 900, y2: 600 }, false);
    return picked.map(function (n) { return n.id; });
  })()`);
  check('框选只命中相交的元素', r.length === 2 && r.indexOf('a') >= 0 && r.indexOf('b') >= 0,
    JSON.stringify(r));

  const none = await ev(`(() => WD.app._internal.elementsInRect({ x: 1400, y: 900, x2: 1700, y2: 1000 }, false).length)()`);
  check('空白区域的框选不命中任何元素', none === 0, `命中 ${none} 个`);

  /* 真实拖动：从空白处拖出一个覆盖 a 的框 */
  const bound = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    return { bound: doc.__wdBound === WD.app.E.stage.frame, hasDoc: !!doc, kids: WD.app._internal.layerNodes().length };
  })()`);
  console.log('  帧监听绑定状态:', JSON.stringify(bound));
  const sr = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
  const at = (x, y) => ({ x: Math.round(sr.left + x * sr.scale), y: Math.round(sr.top + y * sr.scale) });
  const from = at(60, 60), to = at(800, 520);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', buttons: 1, button: 'left',
      x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6,
    });
    await sleep(15);
  }
  const during = await ev(`(() => ({
    marqueeVisible: !document.getElementById('marquee').hidden,
    sel: (WD.app.E.selection || []).map(n => n.id),
    state: (function () {
      const m = WD.app._internal.marqueeState();
      return m ? { events: m.events || 0, moved: m.moved, lastDx: Math.round(m.lastDx || 0),
                   start: [Math.round(m.startX), Math.round(m.startY)] } : null;
    })(),
    canvasPE: document.getElementById('stage-canvas').style.pointerEvents,
  }))()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
  const after = await ev(`(() => ({
    marqueeHidden: document.getElementById('marquee').hidden,
    sel: (WD.app.E.selection || []).map(n => n.id),
    canvasPE: document.getElementById('stage-canvas').style.pointerEvents,
  }))()`);
  check('拖动时框选矩形可见', during.marqueeVisible === true, JSON.stringify(during));
  check('拖动结束后框选矩形隐藏', after.marqueeHidden === true);
  check('框选选中了 a 和 b', after.sel.length === 2 && after.sel.indexOf('a') >= 0 && after.sel.indexOf('b') >= 0,
    JSON.stringify(after.sel));
  check('框选后舞台指针事件已恢复', after.canvasPE === '', `pointerEvents="${after.canvasPE}"`);
}

/* ══ 6. 全选本页元素 ══ */
console.log('\n[6] 全选本页元素');
{
  await resetDeck();
  const r = await ev(`(() => {
    WD.app._internal.selectAllOnSlide();
    return (WD.app.E.selection || []).map(n => n.id);
  })()`);
  check('全选命中画布的全部直接子元素', r.length === 3, JSON.stringify(r));
}

/* ══ 7. 锁定 / 解锁 ══ */
console.log('\n[7] 锁定元素');
{
  await resetDeck();
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    WD.app._internal.toggleLockSelection();
    const locked = doc.querySelector('#a').hasAttribute('data-wd-locked');
    WD.app._internal.toggleLockSelection();
    const unlocked = !doc.querySelector('#a').hasAttribute('data-wd-locked');
    return { locked, unlocked };
  })()`);
  check('锁定后带 data-wd-locked 标记', r.locked === true);
  check('再次点击可解锁', r.unlocked === true);
}

/* ══ 8. 右键菜单项与处理函数一一对应 ══ */
console.log('\n[8] 右键菜单项可执行');
{
  await resetDeck();
  const r = await ev(`(async () => {
    const doc = WD.app.E.stage.getDoc();
    const out = { slide: 0, element: 0, empty: 0, thrown: [] };
    const run = async function (items, tag) {
      for (const it of items) {
        if (it.sep || typeof it.run !== 'function') continue;
        out[tag]++;
        try { await it.run(); await new Promise(z => setTimeout(z, 60)); }
        catch (e) { out.thrown.push(tag + '/' + it.text + ': ' + (e && e.message)); }
      }
    };
    // 元素态
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    await run(WD.app._internal.buildContextItems({}), 'element');
    // 空白态
    WD.app._internal.setSelection([]);
    await run(WD.app._internal.buildContextItems({}), 'empty');
    // 页面态
    await run(WD.app._internal.buildContextItems({ slideIndex: 0 }), 'slide');
    return out;
  })()`);
  check('元素态菜单项全部执行无异常', r.thrown.filter(t => t.indexOf('element/') === 0).length === 0,
    JSON.stringify(r.thrown));
  check('页面态菜单项全部执行无异常', r.thrown.filter(t => t.indexOf('slide/') === 0).length === 0,
    JSON.stringify(r.thrown));
  check('空白态菜单项全部执行无异常', r.thrown.filter(t => t.indexOf('empty/') === 0).length === 0,
    JSON.stringify(r.thrown));
  check('菜单项数量合理', r.element >= 8 && r.slide >= 4 && r.empty >= 4,
    `元素 ${r.element} / 页面 ${r.slide} / 空白 ${r.empty}`);
}

/* ══ 9. 右侧检查器按钮全部可点 ══ */
console.log('\n[9] 检查器按钮不报错');
{
  await resetDeck();
  const r = await ev(`(async () => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('#a')]);
    const btns = Array.from(document.querySelectorAll('#sec-element button, #seg-align button, #seg-weight button, #seg-textalign button'))
      .filter(b => b.offsetParent !== null && !b.disabled);
    const thrown = [];
    for (const b of btns) {
      try { b.click(); await new Promise(z => setTimeout(z, 40)); }
      catch (e) { thrown.push((b.textContent || b.id || '?').trim() + ': ' + (e && e.message)); }
    }
    return { count: btns.length, thrown: thrown };
  })()`);
  check('检查器按钮全部点击无异常', r.thrown.length === 0,
    `${r.count} 个按钮，异常: ${JSON.stringify(r.thrown.slice(0, 5))}`);
  check('检查器确实有可点按钮', r.count >= 8, `${r.count} 个`);
}

/* ══ 10. 添加元素 ══ */
console.log('\n[10] 添加元素');
{
  await resetDeck();
  const r = await ev(`(async () => {
    const before = WD.app._internal.layerNodes().length;
    const kinds = WD.app._internal.elementSpecs();
    kinds.forEach(function (k) {
      if (k === 'image') return;          // 图片需要真实文件，单独走别的路径
      WD.app._internal.addElement(k);
    });
    /* 每次添加都会 commit → 重建舞台文档，旧引用会游离。
       必须让事件循环跑一轮，再从新文档里重新查询几何。 */
    await new Promise(function (res) { setTimeout(res, 300); });
    const nodes = WD.app._internal.layerNodes().filter(function (n) {
      return n.hasAttribute && n.hasAttribute('data-wd-added');
    });
    const made = nodes.map(function (n) {
      return { kind: n.getAttribute('data-wd-added'), tag: n.tagName, pos: n.style.position,
               w: parseFloat(n.style.width) || 0, h: parseFloat(n.style.height) || 0 };
    });
    return { before: before, after: WD.app._internal.layerNodes().length,
             made: made.map(m => m.kind), kinds: kinds, madeFull: made };
  })()`);
  const nonImage = r.kinds.filter(k => k !== 'image');
  check('每种元素都能添加成功', r.made.length === nonImage.length && r.after === r.before + nonImage.length,
    `成功 [${r.made.join(',')}] / 预期 [${nonImage.join(',')}]（画布 ${r.before} → ${r.after}）`);
  check('添加后画布元素数量增加', r.after === r.before + r.made.length,
    `${r.before} → ${r.after}（新增 ${r.made.length}）`);
  check('新元素都是绝对定位且有尺寸',
    r.madeFull.every(m => m.pos === 'absolute' && m.w > 0 && m.h > 0),
    JSON.stringify(r.madeFull.filter(m => m.pos !== 'absolute' || !(m.w > 0))));
  check('新元素落在画布范围内',
    r.madeFull.every(m => m.w <= 1920 && m.h <= 1080),
    JSON.stringify(r.madeFull.map(m => [m.kind, m.w, m.h])));
}

/* ══ 11. 图层面板 ══ */
console.log('\n[11] 图层面板');
{
  await resetDeck();
  const r = await ev(`(() => {
    WD.app._internal.renderLayers();
    const rows = Array.from(document.querySelectorAll('#layer-list .layer-item'));
    return {
      rowCount: rows.length,
      names: rows.map(x => x.querySelector('.layer-name').textContent),
      countLabel: document.getElementById('layers-count').textContent,
      canvasNodes: WD.app._internal.layerNodes().length,
    };
  })()`);
  check('图层面板为每个画布元素生成一行', r.rowCount === r.canvasNodes,
    `行 ${r.rowCount} / 元素 ${r.canvasNodes}`);
  check('图层行显示元素名称', r.names.every(n => n && n.length > 0), JSON.stringify(r.names));
  check('图层数量标签正确', r.countLabel.indexOf(String(r.canvasNodes)) >= 0,
    `标签="${r.countLabel}"`);

  /* 点击图层行应选中对应元素 */
  const clickSel = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('#layer-list .layer-item'));
    rows[rows.length - 1].click();   // 最下面一行 = 绘制顺序最后一个
    return (WD.app.E.selection || []).map(n => n.id);
  })()`);
  check('点击图层行选中了对应元素', clickSel.length === 1, JSON.stringify(clickSel));

  /* 拖拽重排：把最后一个拖到第一个下面 */
  const reorder = await ev(`(() => {
    const nodes = WD.app._internal.layerNodes();
    const first = nodes[0], last = nodes[nodes.length - 1];
    const beforeIdx = Array.prototype.indexOf.call(first.parentNode.children, last);
    WD.app._internal.reorderLayer(last, first, false);
    const afterIdx = Array.prototype.indexOf.call(first.parentNode.children, last);
    return { beforeIdx, afterIdx };
  })()`);
  check('拖动图层可以改变绘制顺序', reorder.afterIdx < reorder.beforeIdx,
    `domIndex ${reorder.beforeIdx} → ${reorder.afterIdx}`);

  /* 隐藏 / 显示 */
  const vis = await ev(`(() => {
    WD.app._internal.renderLayers();
    const row = document.querySelector('#layer-list .layer-item');
    const eye = row.querySelectorAll('.layer-btn')[1];
    eye.click();
    const node = WD.app._internal.layerNodes()[0];
    const hiddenSome = WD.app._internal.layerNodes().some(n => n.style.display === 'none');
    eye.click();
    return { hiddenSome, restored: !WD.app._internal.layerNodes().some(n => n.style.display === 'none') };
  })()`);
  check('眼睛按钮可以隐藏元素', vis.hiddenSome === true);
  check('再点一次可以恢复显示', vis.restored === true);
}

/* ══ 12. 对齐参考线与吸附 ══ */
console.log('\n[12] 对齐吸附');
{
  await resetDeck();
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const b = doc.querySelector('#b');
    const targets = WD.app._internal.snapTargets([b]);
    const snap = WD.app._internal.computeSnap([b], { x: 104, y: 500, w: 300, h: 200 }, false);
    return {
      targetCount: targets.v.length,
      dx: Math.round(snap.dx),
      dy: Math.round(snap.dy),
      guides: snap.guides.map(g => g.orient + '@' + g.pos),
    };
  })()`);
  check('吸附候选里包含画布边缘与中心', r.targetCount >= 3, `候选 ${r.targetCount} 个`);
  check('接近对齐位置时产生吸附修正', Math.abs(r.dx - (100 - 104)) <= 1,
    `dx=${r.dx}（期望 -4，即贴到 100）`);
  check('吸附产生了一条竖直参考线',
    r.guides.some(g => g.indexOf('v@100') === 0), JSON.stringify(r.guides));

  const noSnap = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const b = doc.querySelector('#b');
    return Math.round(WD.app._internal.computeSnap([b], { x: 400, y: 400, w: 300, h: 200 }, false).dx);
  })()`);
  check('远离对齐位置时不产生修正', noSnap === 0, `dx=${noSnap}`);

  const altOff = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const b = doc.querySelector('#b');
    return Math.round(WD.app._internal.computeSnap([b], { x: 104, y: 500, w: 300, h: 200 }, true).dx);
  })()`);
  check('按住 Alt 时关闭吸附', altOff === 0, `dx=${altOff}`);

  /* 真实拖动：把 b 拖到与 a 左边缘接近的位置，松开后应精确对齐 */
  const exact = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const b = doc.querySelector('#b');
    const root = WD.render.findRoot(doc).getBoundingClientRect();
    const rr = b.getBoundingClientRect();
    return { x: Math.round(rr.left - root.left), y: Math.round(rr.top - root.top) };
  })()`);
  const sr = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
  const at = (x, y) => ({ x: Math.round(sr.left + x * sr.scale), y: Math.round(sr.top + y * sr.scale) });

  /* 先选中 b（真实点击） */
  const bAt = at(exact.x + 60, exact.y + 60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bAt.x, y: bAt.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bAt.x, y: bAt.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bAt.x, y: bAt.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
  const picked = await ev(`(() => {
    const canvas = document.getElementById('stage-canvas');
    return {
      sel: (WD.app.E.selection || []).map(n => n.id),
      probe: (function () { const h = WD.app._internal.pickAt(${exact.x + 60}, ${exact.y + 60}); return h ? h.tagName + (h.id ? '#' + h.id : '') : null; })(),
      stagePE: getComputedStyle(canvas).pointerEvents,
      at: [${bAt.x}, ${bAt.y}],
      exact: [${exact.x}, ${exact.y}],
      sr: (function () { const r = WD.app.E.stage.el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })(),
      scroll: [canvas.scrollLeft, canvas.scrollTop],
      topAtPoint: (function () { const n = document.elementFromPoint(${bAt.x}, ${bAt.y}); return n ? n.tagName + (n.id ? '#' + n.id : '') : null; })(),
      drag: !!WD.app.E.drag,
      marquee: !!WD.app._internal.marqueeState(),
      editing: !!WD.app.E.editing,
    };
  })()`);
  check('拖动前已选中目标元素', picked.sel.length === 1 && picked.sel[0] === 'b',
    JSON.stringify(picked));

  const from = at(exact.x + 60, exact.y + 60);
  const to = at(104 + 60, 900 + 60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', buttons: 1, button: 'left',
      x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8,
    });
    await sleep(12);
  }
  const duringDrag = await ev(`(() => ({ guides: (WD.app._internal.guidesDom().match(/class="guide/g) || []).length }))()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
  const after = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc).getBoundingClientRect();
    const b = doc.querySelector('#b').getBoundingClientRect();
    return { left: Math.round(b.left - root.left), guidesAfter: (WD.app._internal.guidesDom().match(/class="guide/g) || []).length };
  })()`);
  check('拖动中画出了参考线', duringDrag.guides >= 1, `参考线 ${duringDrag.guides} 条`);
  check('拖动结束吸附到精确对齐位置', Math.abs(after.left - 100) <= 1,
    `left=${after.left}（期望 100）`);
  check('拖动结束后参考线被清除', after.guidesAfter === 0, `残留 ${after.guidesAfter} 条`);
}

/* ══ 13. 真实点击顶栏「形状」下拉后，元素可被选中 ══ */
console.log('\n[13] 插入形状后能立即选中');
{
  await resetDeck();
  const sr = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
  const at = (x, y) => ({ x: Math.round(sr.left + x * sr.scale), y: Math.round(sr.top + y * sr.scale) });

  /* 「形状」按钮在下拉里，本测试取第一个（矩形） */
  const trigger = await ev(`(() => {
    const b = document.getElementById('btn-insert-shape');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check('顶栏「形状」按钮存在', !!trigger, trigger ? '' : '找不到 #btn-insert-shape');

  if (trigger) {
    await clickAt(trigger.x, trigger.y);
    await sleep(320); /* 等 menu-in 动画结束再量坐标 */

    const menuOpen = await ev(`(() => {
      const m = document.getElementById('menu-insert');
      return !!m && !m.hidden;
    })()`);
    check('点击后形状下拉展开', menuOpen === true, String(menuOpen));

    const item = await ev(`(() => {
      const b = document.querySelector('#menu-insert .shape-row button');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    check('下拉里有形状条目', !!item, item ? '' : '#menu-insert .shape-row button 为空');
    if (item) { await clickAt(item.x, item.y); await sleep(500); }
  }
  const added = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const n = doc.querySelector('[data-wd-added]');
    if (!n) return null;
    const root = WD.render.findRoot(doc).getBoundingClientRect();
    const r = n.getBoundingClientRect();
    return { kind: n.getAttribute('data-wd-added'),
             canvasX: Math.round(r.left - root.left), canvasY: Math.round(r.top - root.top),
             w: Math.round(r.width), h: Math.round(r.height),
             selected: (WD.app.E.selection || []).indexOf(n) >= 0 };
  })()`);
  check('点击按钮真的往画布加了一个元素', !!added, JSON.stringify(added));
  check('新元素被自动选中', added && added.selected === true, JSON.stringify(added));

  /* 关键：点击画布上的新元素应当能选中 —— 证明它可以被正常编辑 */
  if (added) {
    const p = at(added.canvasX + added.w / 2, added.canvasY + added.h / 2);
    await clickAt(p.x, p.y);
    await sleep(250);
    const sel = await ev(`(() => (WD.app.E.selection || []).map(n => n.getAttribute('data-wd-added') || n.tagName))()`);
    check('新元素在画布上可以点选', sel.length === 1 && sel[0] === 'rect', JSON.stringify(sel));
  }
}

/* ══ 汇总 ══ */
console.log('\n' + '='.repeat(66));
console.log(`编辑功能回归（第二批）: ${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  - ' + f));
}
if (pageErrors.length) {
  console.log('\n页面错误:');
  pageErrors.slice(0, 10).forEach((e) => console.log('  ! ' + String(e).slice(0, 200)));
}
ws.close();
process.exit(fail ? 2 : 0);
