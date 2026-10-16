/* 顶栏改版验收：量每个按钮的「有无边框 / 有无图标 / 有无文字」，
   并截一张顶栏特写。断言按用户的三条要求写：
     1) 不显示按钮边框
     2) 除撤销/重做外，其余都有图标和文字
     3) 工具栏不溢出（宽度装得下） */
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9520);
const OUT = process.argv[4] || 'tmp/topbar.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pend = new Map();
const errors = [];

async function resolvePageWs(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* not up */ }
    await sleep(400);
  }
  throw new Error('找不到调试目标');
}

ws = new WebSocket(await resolvePageWs(PORT));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) {
    const p = pend.get(d.id); pend.delete(d.id);
    if (d.error) p.rej(new Error(JSON.stringify(d.error))); else p.res(d.result);
  } else if (d.method === 'Runtime.exceptionThrown') {
    errors.push(d.params.exceptionDetails.text);
  } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
    errors.push((d.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 60000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    /* 只报 .text 是不够的：抛的不是 Error 对象时 text 永远是 "Uncaught"，
       等于什么都没说。要连 exception.description 一起打出来。 */
    const d = r.exceptionDetails;
    const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text;
    const where = d.stackTrace && d.stackTrace.callFrames && d.stackTrace.callFrames[0];
    throw new Error('页面异常: ' + detail +
      (where ? '  @ ' + (where.url || '').split('/').pop() + ':' + (where.lineNumber + 1) : ''));
  }
  return r.result.value;
};

let pass = 0, fail = 0;
const bad = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; bad.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + '   ' + (detail || '')); }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2500);

/* 放映按钮的「空状态」检查必须放在 loadSample 之前：
   这个测试一上来就载入了示例课件，到 [A] 时已经有文档了，测不到「没文档」这一态。 */
const presEmpty = await ev(`(() => {
  const b = document.getElementById('btn-present');
  if (!b) return { missing: true };
  return { missing: false, hiddenAttr: b.hidden, display: getComputedStyle(b).display,
           barEmptyHidden: document.getElementById('stage-empty').hidden };
})()`);
await ev('(async () => { await WD.app.loadSample(); return true; })()');
await ev('(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()');
await sleep(1500);

const SYMBOLS = new Set(['btn-undo', 'btn-redo']);

console.log('\n[A] 顶栏按钮：无边框 + 图标 + 文字');
const r = await ev(`(() => {
  const tb = document.querySelector('.topbar');
  const ids = ['btn-undo','btn-redo','btn-add-slide','btn-insert-text','btn-insert-title',
               'btn-insert-shape','btn-insert-image','btn-insert-video','btn-painter','btn-find',
               'btn-save-menu','btn-theme','btn-help'];
  const buttons = ids.map(id => {
    const b = document.getElementById(id);
    if (!b) return { id, missing: true };
    const cs = getComputedStyle(b);
    const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderRightWidth)
             + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth);
    const ic = b.querySelector('svg.ic');
    const lb = b.querySelector('span:not(.btn-caret)');
    const r = b.getBoundingClientRect();
    return { id, border: bw, borderColor: cs.borderTopColor, bg: cs.backgroundColor,
             hasIcon: !!ic, iconW: ic ? Math.round(ic.getBoundingClientRect().width) : 0,
             hasLabel: !!lb, label: lb ? lb.textContent.trim() : '',
             w: Math.round(r.width), h: Math.round(r.height),
             left: Math.round(r.left), right: Math.round(r.right) };
  });
  const tr = tb.getBoundingClientRect();
  /* fmt 组已从顶栏挪到第二行 #ctx-bar，这里改成量第二行的按钮 */
  const ctx = document.getElementById('ctx-bar');
  const fmt = ['fmt-bold','fmt-italic','fmt-underline','fmt-size-dec','fmt-size-inc',
               'fmt-align-left','fmt-align-center','fmt-align-right','fmt-align-justify','fmt-color']
    .map(id => { const b = document.getElementById(id); const cs = getComputedStyle(b);
      return { id, border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth)
               + parseFloat(cs.borderRightWidth) + parseFloat(cs.borderBottomWidth),
               w: Math.round(b.getBoundingClientRect().width) }; });
  return { buttons, fmt, ctxInTopbar: !!ctx && tb.contains(ctx),
           fmtInTopbar: tb.contains(document.getElementById('fmt-group')),
           tbW: Math.round(tr.width), tbRight: Math.round(tr.right),
           maxRight: Math.max(...buttons.map(b => b.right)),
           minLeft: Math.min(...buttons.map(b => b.left)),
           vw: window.innerWidth };
})()`);

const SYM = ['btn-undo', 'btn-redo'];
for (const b of r.buttons) {
  if (b.missing) { check(b.id + ' 存在', false, 'DOM 里找不到'); continue; }
  check(b.id + ' 无边框', b.border === 0, b.border + 'px');
  if (SYM.includes(b.id)) {
    check(b.id + ' 保持纯符号', !b.hasIcon && !b.hasLabel, JSON.stringify(b));
  } else {
    check(b.id + ' 有图标(16px)', b.hasIcon && b.iconW === 16, b.hasIcon ? b.iconW + 'px' : '无');
    check(b.id + ' 有文字「' + b.label + '」', b.hasLabel && b.label.length > 0, JSON.stringify(b.label));
  }
}
for (const f of r.fmt) check(f.id + ' 无边框', f.border === 0, f.border + 'px');
check('顶栏不溢出视口', r.maxRight <= r.vw && r.minLeft >= 0, `最右 ${r.maxRight} / 视口 ${r.vw}`);

/* 第二行上下文操作栏 */
console.log('\n[A3] 第二行：随选区换内容，且控件不在右栏留副本');
const ctxShape = await ev(`(() => {
  const bar = document.getElementById('ctx-bar');
  const tb = document.querySelector('.topbar');
  const insp = document.getElementById('insp-body');
  const dup = ['seg-align','f-x','f-y','f-w','f-h','f-rot','f-fill','f-fill-text',
               'tbl-tools','btn-layer-up','btn-layer-down','btn-layer-front',
               'btn-layer-back','btn-el-dup','btn-el-dup','btn-el-del',
               'f-slide-layout','f-slide-bg','f-slide-bg-text','el-kind','el-tag']
    .filter(id => document.querySelectorAll('#' + id).length > 1);
  return {
    exists: !!bar, inTopbar: tb.contains(bar), inInspector: insp.contains(bar),
    barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
    tbBottom: Math.round(tb.getBoundingClientRect().bottom),
    dupIds: dup,
    inspKeeps: ['f-radius','f-border-color','f-font','seg-weight','f-line-height',
                'f-letter-spacing','f-opacity','f-css','f-notes','layer-list']
      .every(id => !!document.getElementById(id)),
    gone: ['f-font-size','f-color','seg-textalign','btn-el-front','btn-el-back']
      .filter(id => !!document.getElementById(id)),
  };
})()`);
check('第二行存在且是顶栏与工作区之间的独立一层',
  ctxShape.exists && ctxShape.inTopbar === false && ctxShape.inInspector === false,
  JSON.stringify(ctxShape));
check('第二行紧贴在顶栏下方（不是浮在画布中间）',
  ctxShape.barTop !== null && Math.abs(ctxShape.barTop - ctxShape.tbBottom) <= 1,
  `第二行顶 ${ctxShape.barTop} / 顶栏底 ${ctxShape.tbBottom}`);
check('高频控件在页面上都只有一个 id（没有右栏副本）',
  ctxShape.dupIds.length === 0, JSON.stringify(ctxShape.dupIds));
check('右栏长尾项一个没少', ctxShape.inspKeeps, JSON.stringify(ctxShape.inspKeeps));
check('被并入第二行的重复控件已从右栏移除',
  ctxShape.gone.length === 0, JSON.stringify(ctxShape.gone));

/* 三态：没文档 / 无选区 / 选中元素 */
const ctxNoSel = await ev(`(() => {
  const g = id => { const e = document.getElementById(id);
    return { hidden: e.hidden, w: Math.round(e.getBoundingClientRect().width) }; };
  return { bar: g('ctx-bar'), slide: g('ctx-slide'), el: g('ctx-el'), fmt: g('fmt-group') };
})()`);
check('有文档、无选区 → 第二行只显示页面组',
  ctxNoSel.bar.hidden === false && ctxNoSel.slide.hidden === false &&
  ctxNoSel.el.hidden === true && ctxNoSel.fmt.hidden === true,
  JSON.stringify(ctxNoSel));
/* 真的选中一个带文字的元素再看 —— 上一版忘了选就断言「元素组出现」，
   量到的其实是未选中态，等于把 page 组的形状当 element 组断言。 */
await ev(`(() => {
  const I = WD.app._internal, doc = WD.app.E.stage.getDoc();
  I.setSelection([doc.querySelector('h1')]); I.updateInspector(); I.refreshOverlay();
  return true;
})()`);
await sleep(500);
const ctxSel = await ev(`(() => {
  const g = id => { const e = document.getElementById(id);
    return { hidden: e.hidden, w: Math.round(e.getBoundingClientRect().width) }; };
  return { slide: g('ctx-slide'), el: g('ctx-el'), fmt: g('fmt-group'),
           kind: document.getElementById('el-kind').textContent };
})()`);
check('选中文字元素 → 页面组让位，元素组与文字组同时出现',
  ctxSel.slide.hidden === true &&
  ctxSel.el.hidden === false && ctxSel.el.w > 0 &&
  ctxSel.fmt.hidden === false && ctxSel.fmt.w > 0,
  JSON.stringify(ctxSel));
check('第二行左端标签跟着显示成元素类型', ctxSel.kind && ctxSel.kind !== '元素', ctxSel.kind);
/* 最宽一态（表格：元素组 + 表格 4 键 + 文字组）的溢出量在 [C] 末尾量 ——
   插表格会改文档、置脏位，插在中段会把后面「未编辑时胶囊没有点」那条打穿。 */

/* 放映按钮已从顶栏挪到底部状态条，且只在载入 HTML 之后出现 */
console.log('\n[A2] 放映按钮：已移出顶栏，落在底部状态条');
check('未载入文档时放映按钮是隐藏的',
  presEmpty.missing === false && presEmpty.hiddenAttr === true && presEmpty.display === 'none',
  JSON.stringify(presEmpty));
check('空状态遮罩此刻确实可见（说明「没文档」这一态成立）', presEmpty.barEmptyHidden === false,
  JSON.stringify(presEmpty));
const pres = await ev(`(() => {
  const b = document.getElementById('btn-present');
  if (!b) return { missing: true };
  const tb = document.querySelector('.topbar');
  const bar = document.getElementById('stage-bar');
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  return {
    missing: false,
    inTopbar: tb.contains(b),
    inStageBar: bar.contains(b),
    hiddenAttr: b.hidden,
    display: cs.display,
    w: Math.round(r.width), h: Math.round(r.height),
    iconW: Math.round(b.querySelector('svg.ic').getBoundingClientRect().width),
    label: b.querySelector('span').textContent.trim(),
    barBottom: Math.round(bar.getBoundingClientRect().bottom),
    btnBottom: Math.round(r.bottom),
  };
})()`);
check('放映按钮仍在 DOM 里（只是换了位置）', pres.missing === false, JSON.stringify(pres));
check('放映按钮已不在顶栏内', pres.inTopbar === false, JSON.stringify(pres));
check('放映按钮位于底部状态条内', pres.inStageBar === true, JSON.stringify(pres));
check('载入文档后放映按钮可见', pres.hiddenAttr === false && pres.display !== 'none',
  `hidden=${pres.hiddenAttr} display=${pres.display}`);
check('放映按钮仍在状态条高度内', pres.h > 0 && pres.h <= 32 && pres.btnBottom <= pres.barBottom,
  `高 ${pres.h}px，底 ${pres.btnBottom} / 条底 ${pres.barBottom}`);

const presAfter = await ev(`(() => {
  const b = document.getElementById('btn-present');
  const r = b.getBoundingClientRect();
  const bar = document.getElementById('stage-bar').getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { w: Math.round(r.width), h: Math.round(r.height),
           iconW: Math.round(b.querySelector('svg.ic').getBoundingClientRect().width),
           label: b.querySelector('span').textContent.trim(),
           hitSelf: top === b || b.contains(top), hitTag: top ? (top.id || top.tagName) : null,
           fitsBar: r.right <= bar.right + 1 && r.bottom <= bar.bottom + 1 };
})()`);
check('放映按钮可见、可点、在状态条内', presAfter.w > 0 && presAfter.hitSelf && presAfter.fitsBar,
  JSON.stringify(presAfter));
check('放映按钮仍带图标 + 文字', presAfter.iconW > 0 && presAfter.label === '放映',
  JSON.stringify(presAfter));
await ev(`(() => { const b = document.getElementById('btn-present'); b.click(); return true; })()`);
await sleep(500);
const presenting = await ev(`(() => !document.getElementById('present').hidden)()`);
check('底部按钮点得动，真能进放映', presenting === true, `present 遮罩 hidden=${!presenting}`);
await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
await sleep(400);

console.log('\n[B] 顶栏横向滚动 + 下拉不被裁剪');
console.log('\n[B1] 下拉能反复开合（「只能下拉一次」的回归）');
{
  /* 曾经的 bug：点一次展开 → 再点一次收起 → 第三次再也展不开。
     根因是全局兜底用捕获阶段监听 document click，
     它先于触发按钮把 openMenu 关掉了，于是 toggle 判断永远读到「本来就开着」。
     这里必须真的点满 6 次（开/关 ×3），只测两次是测不出来的。 */
  const seq = async (btnId, menuId, label) => {
    const st = [];
    for (let i = 0; i < 6; i++) {
      await ev(`document.getElementById(${JSON.stringify(btnId)}).click()`);
      await sleep(220);
      st.push(await ev(`!document.getElementById(${JSON.stringify(menuId)}).hidden`));
    }
    check(`${label} 连续 6 次点击严格开→关→开→关→开→关`,
      st.join(',') === 'true,false,true,false,true,false', st.join(','));
    await ev(`document.getElementById(${JSON.stringify(btnId)}).click()`);
    await sleep(220);
  };

  /* 1) 纯反复点触发器 */
  await seq('btn-save-menu', 'menu-save', '保存与导出');
  await seq('btn-insert-shape', 'menu-insert', '形状');

  /* 2) 关键：点外面关掉之后，必须还能再打开。
        旧实现正是在这一步永久卡死。 */
  const outside = async (btnId, menuId, label) => {
    await ev(`document.getElementById(${JSON.stringify(btnId)}).click()`);
    await sleep(220);
    const opened = await ev(`!document.getElementById(${JSON.stringify(menuId)}).hidden`);
    check(`${label} 先展开`, opened === true, String(opened));
    await ev(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(220);
    const closed = await ev(`document.getElementById(${JSON.stringify(menuId)}).hidden`);
    check(`${label} 点外面收起`, closed === true, String(closed));
    await ev(`document.getElementById(${JSON.stringify(btnId)}).click()`);
    await sleep(220);
    const reopened = await ev(`!document.getElementById(${JSON.stringify(menuId)}).hidden`);
    check(`${label} 点外面关掉后还能再展开`, reopened === true, String(reopened));
    await ev(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(220);
  };
  await outside('btn-save-menu', 'menu-save', '保存与导出');
  await outside('btn-insert-shape', 'menu-insert', '形状');

  /* 3) Esc 之后也能再打开 */
  await ev(`document.getElementById('btn-insert-shape').click()`);
  await sleep(200);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  await ev(`document.getElementById('btn-insert-shape').click()`);
  await sleep(200);
  check('形状：Esc 关闭后还能再展开',
    await ev(`!document.getElementById('menu-insert').hidden`));
  await ev(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(200);
}

console.log('\n[B2] 顶栏按钮增删');
{
  const t = await ev(`(() => {
    const tb = document.querySelector('.topbar');
    const kids = Array.from(tb.children);
    return {
      hasOpen: !!document.getElementById('btn-open'),
      hasPanels: !!document.getElementById('btn-panels'),
      hasSample2: !!document.getElementById('btn-sample-2'),
      hasImage: !!document.getElementById('btn-insert-image'),
      hasVideo: !!document.getElementById('btn-insert-video'),
      videoInput: !!document.getElementById('video-input'),
      fileInput: !!document.getElementById('file-input'),
      hasDirtyBadge: !!document.getElementById('dirty-badge'),
      hasFileChip: !!document.getElementById('file-chip'),
      chipIdx: kids.indexOf(document.getElementById('file-chip')),
      brandIdx: kids.indexOf(document.querySelector('.brand')),
      undoIdx: kids.indexOf(document.getElementById('btn-undo').closest('.tb-group')),
      saveIdx: kids.indexOf(document.getElementById('save-group')),
      fmtIdx: kids.indexOf(document.getElementById('fmt-group')),
    };
  })()`);
  check('顶栏保留「打开 HTML」入口（与空状态各一处）', t.hasOpen === true, JSON.stringify(t.hasOpen));
  check('顶栏「面板」按钮已删除', !t.hasPanels, JSON.stringify(t.hasPanels));
  check('「载入示例课件」按钮已删除', !t.hasSample2, String(t.hasSample2));
  check('独立的「有未保存修改」徽章已删除', !t.hasDirtyBadge, String(t.hasDirtyBadge));
  check('文件名胶囊仍在顶栏里', t.hasFileChip, JSON.stringify(t));
  /* 文字格式条搬去了第二行，顶栏里不该再有它的位置（indexOf 会返回 -1）。
     胶囊现在夹在「撤销」和「保存与导出」之间。 */
  check('顶栏里已不再有文字格式条', t.fmtIdx === -1, JSON.stringify(t));
  check('文件名胶囊位于撤销之后、保存与导出之前',
    t.chipIdx > t.undoIdx && t.chipIdx < t.saveIdx, JSON.stringify(t));
  check('新增「图片」按钮', t.hasImage);
  check('新增「视频」按钮', t.hasVideo);
  check('视频文件选择器存在', t.videoInput);
  check('file-input 仍在（打开功能的落点）', t.fileInput);

  /* 形状下拉：14 种（图片/视频已上移为独立按钮；横线/标签已换成线条与新形状）；
     本轮新增 多边形 / 曲线 / 连接线 / 曲线连接线 / 自由绘制 */
  const sh = await ev(`(() => {
    document.getElementById('btn-insert-shape').click();
    const n = document.querySelectorAll('#menu-insert .shape-row button');
    const out = { count: n.length, titles: Array.from(n).map(b => b.title) };
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return out;
  })()`);
  check('形状下拉共 14 种', sh.count === 14, JSON.stringify(sh));
  check('形状下拉里没有「图片」「视频」「横线」「标签」',
    !/图片|视频|横线|标签/.test(sh.titles.join(',')), sh.titles.join(','));
  check('含 曲线 / 连接线 / 曲线连接线 / 自由绘制 / 多边形',
    ['曲线', '连接线', '曲线连接线', '自由绘制', '多边形']
      .every((t) => sh.titles.indexOf(t) >= 0), sh.titles.join(','));
  check('含 椭圆 / 三角形 / 平行四边形 / 直线 / 箭头 / 双向箭头',
    ['椭圆', '三角形', '平行四边形', '直线', '箭头', '双向箭头'].every((t) => sh.titles.indexOf(t) >= 0),
    sh.titles.join(','));

  /* 标题 / 文本框 / 公式 / 图表 各自有下拉 */
  const menus = await ev(`(() => {
    const grab = (btn, menu) => {
      document.getElementById(btn).click();
      const n = document.querySelectorAll(menu + ' .shape-row button');
      const titles = Array.from(n).map(b => b.title);
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return titles;
    };
    return {
      title: grab('btn-insert-title', '#menu-title'),
      text: grab('btn-insert-text', '#menu-text'),
      formula: grab('btn-insert-formula', '#menu-formula'),
      chart: grab('btn-insert-chart', '#menu-chart'),
    };
  })()`);
  check('标题下拉 4 项（一级到四级）', menus.title.length === 4, JSON.stringify(menus.title));
  check('文本框下拉 2 项（横向/竖向）', menus.text.length === 2, JSON.stringify(menus.text));
  check('公式下拉 2 项', menus.formula.length === 2, JSON.stringify(menus.formula));
  check('图表下拉 3 项', menus.chart.length === 3, JSON.stringify(menus.chart));
  const newBtns = await ev(`({
    table: !!document.getElementById('btn-insert-table'),
    formula: !!document.getElementById('btn-insert-formula'),
    chart: !!document.getElementById('btn-insert-chart')
  })`);
  check('新增 表格 / 公式 / 图表 三个顶栏按钮',
    newBtns.table && newBtns.formula && newBtns.chart, JSON.stringify(newBtns));

  /* 保存与导出：只管保存与导出。
     「打开 HTML」入口放在顶栏和空状态两处（用户定的方案），
     不再往这个菜单里塞 —— 菜单名是「保存与导出」，塞个「打开」名不副实。 */
  const sm = await ev(`(() => {
    document.getElementById('btn-save-menu').click();
    const items = Array.from(document.querySelectorAll('#menu-save .menu-item')).map(b => b.textContent.trim());
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return items;
  })()`);
  check('保存与导出共 4 项', sm.length === 4, JSON.stringify(sm));
  check('★ 菜单里没有「打开」——入口只在顶栏与空状态',
    !sm.some((t) => /打开/.test(t)), JSON.stringify(sm));
  check('四项依次是 保存 / 导出 HTML 放映页 / 导出 HTML 工程文件 / 导出 PPTX',
    /保存/.test(sm[0] || '') && /HTML/.test(sm[1] || '') &&
    /工程文件/.test(sm[2] || '') && /Power\s*Point|PPTX/.test(sm[3] || ''), JSON.stringify(sm));
  const openEntries = await ev(`(() => ({
    top: !!document.getElementById('btn-open'),
    topLabel: (document.getElementById('btn-open') || {}).textContent || '',
    topTitle: (document.getElementById('btn-open') || {}).title || '',
    empty: !!document.getElementById('btn-open-2'),
    inMenu: !!document.querySelector('#menu-save .menu-item[data-open]'),
    dupIds: (function () {
      const seen = {}, dup = [];
      Array.from(document.querySelectorAll('[id]')).forEach((n) => {
        if (seen[n.id]) dup.push(n.id); else seen[n.id] = 1;
      });
      return dup;
    })(),
  }))()`);
  check('★ 「打开」入口恰好两处：顶栏（图标+文字+title）与空状态',
    openEntries.top && openEntries.empty && !openEntries.inMenu &&
    /打开/.test(openEntries.topLabel) && /Ctrl\+O/.test(openEntries.topTitle), JSON.stringify(openEntries));
  check('页面里没有重复 id', openEntries.dupIds.length === 0, JSON.stringify(openEntries.dupIds));
}

console.log('\n[B2b] 未保存提示：文件名胶囊上那个点');
{
  /* 点必须真的在屏幕上出现，而不是只有一个 class 挂着。 */
  const read = () => ev(`(() => {
    const c = document.getElementById('file-chip');
    if (!c || !c.offsetParent) return { hidden: true };
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c, '::before');
    return { hidden: false, dirty: c.classList.contains('dirty'),
             text: c.textContent.trim(), title: c.title,
             w: +r.width.toFixed(1),
             dotDisplay: cs.display, dotW: cs.width, dotBg: cs.backgroundColor };
  })()`);
  const clean = await read();
  check('载入后胶囊可见且文件名正确', !clean.hidden && clean.text.length > 0, JSON.stringify(clean));
  check('未编辑时胶囊没有点（display:none）',
    clean.dirty === false && clean.dotDisplay === 'none', JSON.stringify(clean));

  /* 走一次真实编辑：加一个元素就会置 dirty */
  await ev(`(() => { WD.app._internal.addElement('rect'); return true; })()`);
  await sleep(400);
  const dirty = await read();
  check('发生编辑后胶囊加上 dirty 类', dirty.dirty === true, JSON.stringify(dirty));
  check('★ 那个点真的显示出来了', dirty.dotDisplay !== 'none', JSON.stringify(dirty));
  check('★ 点的尺寸 ≥ 5px 且有实心颜色',
    parseFloat(dirty.dotW) >= 5 && dirty.dotBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(dirty));
  check('点出现时胶囊比未编辑时更宽', dirty.w > clean.w + 3, clean.w + ' → ' + dirty.w);
  check('配了 title 说明点是什么意思', /未保存/.test(dirty.title || ''), JSON.stringify(dirty.title));

  /* 撤销**不会**让点消失：store 里 undo/redo 都显式 setDirty(true)，
     「撤销本身也是一次改动」是这个库既定的语义（Office 那种
     「撤销回上次保存状态就自动干净」这里没做）。所以这里只断言点还在。 */
  await ev(`(() => { WD.app.store.undo(); return true; })()`);
  await sleep(400);
  const undone = await read();
  check('撤销后点仍在（撤销本身算一次改动，store 语义如此）',
    undone.dirty === true && undone.dotDisplay !== 'none', JSON.stringify(undone));

  /* 点真正消失的路径是「已保存」—— saveProject 里就是这一句 setDirty(false) */
  await ev(`(() => { WD.app.store.setDirty(false); return true; })()`);
  await sleep(300);
  const saved = await read();
  check('保存后点消失', saved.dirty === false && saved.dotDisplay === 'none', JSON.stringify(saved));
  check('保存后 title 也一并清掉', (saved.title || '') === '', JSON.stringify(saved.title));

  /* ── 最容易出问题的一个时刻：选中文字元素 → 格式条出现 → 顶栏超宽。
     胶囊是顶栏里唯一可压缩的元素，会被挤扁；胶囊有 overflow:hidden，
     而 padding 就占掉 22px —— 一旦压到 20 多 px，**点本身会被裁掉**，
     提示恰好在最需要它的场景里失效。这里复现那个挤压并量内容盒。 */
  await ev(`(() => { WD.app._internal.addElement('rect'); return true; })()`);
  await sleep(300);
  await ev(`(() => {
    const I = WD.app._internal, doc = WD.app.E.stage.getDoc();
    I.setSelection([doc.querySelector('h1')]); I.updateInspector(); I.refreshOverlay();
    return true;
  })()`);
  await sleep(500);
  const squeezed = await ev(`(() => {
    const c = document.getElementById('file-chip');
    const tb = document.querySelector('.topbar');
    tb.scrollLeft = 0;
    const cs = getComputedStyle(c);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const w = c.getBoundingClientRect().width;
    const dot = getComputedStyle(c, '::before');
    return { w: +w.toFixed(1), padX,
             contentBox: +(w - padX).toFixed(1),
             dotW: parseFloat(dot.width), gap: 7,
             dotDisplay: dot.display,
             fmtShown: (() => { const f = document.getElementById('fmt-group');
                                return f ? f.offsetWidth > 0 : false; })(),
             overflow: tb.scrollWidth - tb.clientWidth };
  })()`);
  console.log('  （选中文字后）' + JSON.stringify(squeezed));
  check('★ 选中文字触发格式条时，点仍完整可见（内容盒 ≥ 点+间距）',
    squeezed.dotDisplay === 'none' || squeezed.contentBox >= squeezed.dotW + squeezed.gap + 0.5,
    JSON.stringify(squeezed));
  /* 格式条搬去第二行之后，它再也不占顶栏的宽度了 ——
     「选中文字就把顶栏挤到横向滚动」这个老毛病顺带没了。
     这里的 squeezed.fmtShown 为真，说明此刻格式条确实是显示态，
     所以 overflow === 0 才是有意义的断言，不是碰巧没选文字。 */
  check('★ 选中文字时顶栏不再被挤到横向滚动（格式条已移出顶栏）',
    squeezed.fmtShown === true && squeezed.overflow <= 0,
    JSON.stringify(squeezed));
}

console.log('\n[B3] 顶栏横向滚动 + 下拉不被裁剪');{
  /* 让文字格式条出现（它是让顶栏最宽的东西），再展开两个下拉 */
  await ev(`(() => {
    const I = WD.app._internal, doc = WD.app.E.stage.getDoc();
    I.setSelection([doc.querySelector('h1')]); I.updateInspector(); I.refreshOverlay();
    return true;
  })()`);
  await sleep(500);

  const scroll = await ev(`(() => { const tb = document.querySelector('.topbar');
    return { sw: tb.scrollWidth, cw: tb.clientWidth, scrollable: tb.scrollWidth > tb.clientWidth,
             ow: getComputedStyle(tb).overflowX }; })()`);
  console.log('  顶栏 ' + JSON.stringify(scroll));
  check('顶栏可横向滚动（装不下时不丢内容）', scroll.ow === 'auto' || scroll.sw <= scroll.cw, JSON.stringify(scroll));

  const checkMenu = async (btnId, menuId, label) => {
    await ev(`document.getElementById(${JSON.stringify(btnId)}).click()`);
    await sleep(320);
    const m = await ev(`(() => {
      const el = document.getElementById(${JSON.stringify(menuId)});
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { hidden: el.hidden, pos: cs.position,
               l: Math.round(r.left), t: Math.round(r.top),
               w: Math.round(r.width), h: Math.round(r.height),
               inViewport: r.left >= 0 && r.top >= 0 &&
                           r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
               belowBar: r.top >= 40 };
    })()`);
    check(`${label} 展开了`, !m.hidden, JSON.stringify(m));
    check(`${label} 用 fixed 定位（不受顶栏 overflow 裁剪）`, m.pos === 'fixed', m.pos);
    check(`${label} 完整落在视口内`, m.inViewport && m.w > 40 && m.h > 20, JSON.stringify(m));
    check(`${label} 出现在顶栏下方`, m.belowBar, 'top=' + m.t);
    if (menuId === 'menu-save') {
      const s = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: Math.max(0, m.l - 260), y: 0, width: Math.min(560, r.vw - Math.max(0, m.l - 260)), height: 190, scale: 2 },
      });
      fs.writeFileSync(OUT.replace(/\.png$/, '-menu.png'), Buffer.from(s.data, 'base64'));
      console.log('已保存', OUT.replace(/\.png$/, '-menu.png'));
    }
    await ev(`document.getElementById(${JSON.stringify(btnId)}).click()`);
    await sleep(250);
  };

  await checkMenu('btn-save-menu', 'menu-save', '保存与导出下拉');
  await checkMenu('btn-insert-shape', 'menu-insert', '形状下拉');

  /* 查找栏同理 */
  await ev(`document.getElementById('btn-find').click()`);
  await sleep(320);
  const fb = await ev(`(() => { const el = document.getElementById('find-bar'); const r = el.getBoundingClientRect();
    return { hidden: el.hidden, pos: getComputedStyle(el).position,
             l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width),
             inViewport: r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 40 }; })()`);
  check('查找栏展开', !fb.hidden, JSON.stringify(fb));
  check('查找栏用 fixed 且完整可见', fb.pos === 'fixed' && fb.inViewport && fb.w > 100, JSON.stringify(fb));
  await ev(`document.getElementById('find-close').click()`);
  await sleep(250);
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width: Math.min(r.maxRight + 16, r.vw), height: 54, scale: 2 },
});
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('已保存', OUT);

/* 整条顶栏 3 倍放大，用来目视核对每个图标 */
const zoom = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 6, width: Math.min(r.maxRight + 16, r.vw), height: 42, scale: 3 },
});
fs.writeFileSync(OUT.replace(/\.png$/, '-zoom.png'), Buffer.from(zoom.data, 'base64'));
console.log('已保存', OUT.replace(/\.png$/, '-zoom.png'));

/* ══ [C] 第二行的最宽一态 ══
   必须排在最后：插表格会改文档、置脏位，放中段会把
   「未编辑时胶囊没有点」那条断言打穿。
   这一态内容最多——元素组 + 表格 4 键 + 文字组 11 个，
   1600px 视口下只要溢出 1px，末尾的文字色按钮就被切掉。 */
console.log('\n[C] 第二行：选中最宽的一态也不溢出');
await ev(`(async () => {
  document.getElementById('btn-insert-table').click();
  await new Promise(r => setTimeout(r, 500));
  document.getElementById('tbl-r').value = '3';
  document.getElementById('tbl-c').value = '3';
  await new Promise(r => setTimeout(r, 150));
  const ok = Array.from(document.querySelectorAll('#modal-foot .btn'))
    .find(b => b.textContent.trim() === '插入');
  if (ok) ok.click();
  await new Promise(r => setTimeout(r, 900));
  return true;
})()`);
await sleep(700);
const ctxWide = await ev(`(() => {
  const bar = document.getElementById('ctx-bar');
  const tt = document.getElementById('tbl-tools');
  const r = tt.getBoundingClientRect();
  const color = document.getElementById('fmt-color').getBoundingClientRect();
  return { overflow: bar.scrollWidth - bar.clientWidth,
           tblVisible: !tt.hidden && r.width > 0, tblW: Math.round(r.width),
           colorRight: Math.round(color.right), vw: window.innerWidth,
           kind: document.getElementById('el-kind').textContent };
})()`);
check('选中表格时，表格专属的 ＋行－行＋列－列出现在第二行', ctxWide.tblVisible, JSON.stringify(ctxWide));
check('第二行左端标签跟着显示成「表格」', ctxWide.kind === '表格', ctxWide.kind);
check('★ 最宽的一态也不溢出 1600px 视口',
  ctxWide.overflow <= 0, `溢出 ${ctxWide.overflow}px / 视口 ${ctxWide.vw}`);
check('★ 末尾的文字色按钮完整落在视口内',
  ctxWide.colorRight <= ctxWide.vw, `右缘 ${ctxWide.colorRight} / 视口 ${ctxWide.vw}`);

const ctxShot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('tmp/topbar-ctx.png', Buffer.from(ctxShot.data, 'base64'));
console.log('已保存 tmp/topbar-ctx.png');

/* ══ [D] 放映：整页必须完整落在屏幕内 ══
   坑：.present iframe 原来写的是 inset:0 + 固定 1920×1080。
   inset:0 与显式 width 同时存在时 right/bottom 会被忽略，元素落在 (0,0)，
   再配 transform-origin:center —— 缩放绕的是**它自己**的中心 (960,540)，
   而那个点只有在视口恰好也是 1920×1080 时才等于视口中心。
   于是其余任何分辨率下画布都偏出屏幕：实测 1366×768 右侧裁掉 276px、
   底部裁掉 156px，近五分之一的画面根本不在屏幕内。 */
console.log('\n[D] 放映：各分辨率下整页都在屏幕内且居中');
await ev(`document.getElementById('btn-present').click()`);
await sleep(1200);
for (const [w, h] of [[1920, 1080], [1600, 950], [1440, 900], [1366, 768], [1280, 800], [2560, 1440]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await ev(`window.dispatchEvent(new Event('resize'))`);
  await sleep(350);
  const m = await ev(`(() => {
    const f = document.getElementById('present-frame').getBoundingClientRect();
    return { w: Math.round(f.width), h: Math.round(f.height), vw: innerWidth, vh: innerHeight,
             over: [Math.max(0, -f.left), Math.max(0, -f.top),
                    Math.max(0, f.right - innerWidth), Math.max(0, f.bottom - innerHeight)].map(Math.round),
             dxc: Math.round(f.left + f.width / 2 - innerWidth / 2) };
  })()`);
  check(`${w}×${h} 整页都在屏幕内（左/上/右/下溢出都为 0）`, m.over.every((v) => v <= 0), JSON.stringify(m));
  check(`${w}×${h} 水平居中（偏差 ≤1px）`, Math.abs(m.dxc) <= 1, `偏差 ${m.dxc}px`);
  check(`${w}×${h} 保持 16:9 不被拉伸`, Math.abs(m.w / m.h - 16 / 9) < 0.01,
    `${m.w}×${m.h} = ${(m.w / m.h).toFixed(3)}`);
}

/* 备注面板是从底部盖上来的：展开时画布必须上移让位，
   否则演示时那几行备注正好压在幻灯片最下面一行字上。
   只缩不放是不够的 —— 画布仍按整屏居中时，缩对了底部仍会被压住 18px。 */
console.log('\n[D2] 放映：展开备注时画布让位，不被盖住');
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await ev(`window.dispatchEvent(new Event('resize'))`);
  await sleep(300);
  await ev(`(() => { if (document.getElementById('present-notes').hidden)
                        document.getElementById('present-notes-btn').click(); return true; })()`);
  await sleep(400);
  const m = await ev(`(() => {
    const f = document.getElementById('present-frame').getBoundingClientRect();
    const n = document.getElementById('present-notes').getBoundingClientRect();
    return { notesH: Math.round(n.height), cover: Math.round(Math.max(0, f.bottom - n.top)),
             overR: Math.round(Math.max(0, f.right - innerWidth)), vw: innerWidth };
  })()`);
  check(`${w}×${h} 备注展开后画布不被备注盖住`, m.cover === 0, `备注高 ${m.notesH}px，被盖 ${m.cover}px`);
  check(`${w}×${h} 备注展开后画布仍在屏幕内`, m.overR === 0, `右侧溢出 ${m.overR}px`);
  await ev(`document.getElementById('present-notes-btn').click()`);
  await sleep(250);
}
await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
await sleep(400);
check('Esc 能退出放映', (await ev(`document.getElementById('present').hidden`)) === true);

/* ══ [E] 按钮手感：全应用逐个量，发现「不统一」而不是「不好看」 ══
   手感问题最容易被说成「不流畅」却又说不清具体哪儿不对。
   能量出来的只有三件事：命中区够不够大、过渡时长是不是只有一种、
   控件是不是都有 title。三项都是硬指标，能进回归。 */
console.log('\n[E] 按钮手感：命中区 / 过渡时长一致性');
await ev(`(() => {
  const I = WD.app._internal, doc = WD.app.E.stage.getDoc();
  I.setSelection([doc.querySelector('h1')]); I.updateInspector(); I.refreshOverlay();
  return true;
})()`);
await sleep(600);
const feel = await ev(`(() => {
  const visible = Array.from(document.querySelectorAll('button')).filter((b) => {
    const cs = getComputedStyle(b), r = b.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  });
  const durs = {};
  const zeroDur = [];
  const tooSmall = [];
  let noCursor = 0, noTitle = 0;
  for (const b of visible) {
    const cs = getComputedStyle(b), r = b.getBoundingClientRect();
    if (!/pointer|not-allowed/.test(cs.cursor)) noCursor++;
    if (!(b.textContent || '').trim() && !b.getAttribute('title')) noTitle++;
    /* 贴边拉手是 20×52 的竖条，缩略图上的操作键是 26px，
       都不按 24px 这条线量 —— 它们另有存在理由。
       容差 0.5px：aspect-ratio / flex 算出来常是 23.99 这种值，不是真的偏小。 */
    const isEdgeTab = b.classList.contains('panel-collapse');
    if (!isEdgeTab && (r.height < 23.5 || r.width < 23.5)) {
      tooSmall.push((b.id || b.className) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
    if (cs.transitionProperty && cs.transitionProperty !== 'none') {
      const d = cs.transitionDuration.split(',')[0].trim();
      durs[d] = (durs[d] || 0) + 1;
      if (d === '0s') zeroDur.push((b.id || b.className) + '@' + b.parentElement.className);
    }
  }
  return { total: visible.length, durs, tooSmall, zeroDur, noCursor, noTitle };
})()`);
console.log('  ' + JSON.stringify({ total: feel.total, durs: feel.durs, zeroDur: feel.zeroDur }));
check('★ 所有可见按钮的光标都是 pointer / not-allowed', feel.noCursor === 0, `${feel.noCursor} 个不是`);
check('★ 纯图标按钮都有 title（悬停有解释）', feel.noTitle === 0, `${feel.noTitle} 个缺 title`);
check('★ 按钮命中区都 ≥ 24×24（贴边拉手除外）', feel.tooSmall.length === 0,
  JSON.stringify(feel.tooSmall.slice(0, 8)));
/* 之前散着 0.1/0.12/0.13/0.15/0.16/0.18 共 7 种，界面上不同部位应答快慢不一。
   现在统一到 --dur，回归就盯「只有一种」。 */
const durKeys = Object.keys(feel.durs);
check('★ 全应用按钮的过渡时长只有一种（点下去快慢一致）',
  durKeys.length === 1 && durKeys[0] === '0.14s', JSON.stringify(feel.durs));

console.log('\n[E2] 放映：鼠标也能前后翻页');
await ev(`document.getElementById('btn-present').click()`);
await sleep(1200);
const nav = await ev(`(() => ({
  prev: !!document.getElementById('present-prev'),
  next: !!document.getElementById('present-next'),
  fs: !!document.getElementById('present-fs'),
  prevDisabled: document.getElementById('present-prev').disabled,
  pos: document.getElementById('present-pos').textContent.trim(),
  hasTitle: ['present-prev','present-next','present-fs']
    .every(id => !!document.getElementById(id).getAttribute('title')),
}))()`);
check('HUD 上有「上一页 / 下一页 / 全屏」三个按钮', nav.prev && nav.next && nav.fs, JSON.stringify(nav));
check('这三个按钮都有 title', nav.hasTitle, JSON.stringify(nav));
check('第一页时「上一页」是禁用态（不给点了没反应的按钮）', nav.prevDisabled === true, JSON.stringify(nav));
const afterNext = await ev(`(() => { document.getElementById('present-next').click();
  return document.getElementById('present-pos').textContent.trim(); })()`);
check('点「下一页」真的翻页了', afterNext !== nav.pos, `${nav.pos} → ${afterNext}`);
await ev(`document.getElementById('present-prev').click()`);
await sleep(500);
const afterPrev = await ev(`document.getElementById('present-pos').textContent.trim()`);
check('点「上一页」能翻回去', afterPrev === nav.pos, `${afterNext} → ${afterPrev}`);
const lastPage = await ev(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  return new Promise(r => setTimeout(() => r({
    pos: document.getElementById('present-pos').textContent.trim(),
    nextDisabled: document.getElementById('present-next').disabled }), 600));
})()`);
check('End 跳到最后一页，且「下一页」变禁用', lastPage.nextDisabled === true, JSON.stringify(lastPage));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
await sleep(600);
check('Home 跳回第一页',
  (await ev(`document.getElementById('present-pos').textContent.trim()`)) === nav.pos);
/* 全屏在这个无头环境里通常被拒绝，所以只验「按钮存在且不抛异常」，
   真正验「进没进全屏」要靠有头环境，不适合塞进回归。 */
const fsSafe = await ev(`(() => { try {
  document.getElementById('present-fs').click();
  return { threw: false, fsElement: !!document.fullscreenElement };
} catch (e) { return { threw: true, msg: String(e) }; } })()`);
check('点「全屏」不抛异常（无头环境可能被浏览器拒绝，属正常）', fsSafe.threw === false, JSON.stringify(fsSafe));
await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
await sleep(500);
check('Esc 能退出放映（HUD 隐藏后也一样）', (await ev(`document.getElementById('present').hidden`)) === true);

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (bad.length) { console.log('失败项:'); bad.forEach((b) => console.log('  - ' + b)); }
console.log('页面错误:', errors.length ? [...new Set(errors)].join(' | ') : '无');
ws.close();
process.exit(fail ? 1 : 0);
