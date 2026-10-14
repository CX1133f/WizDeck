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
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.text));
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
await ev('(async () => { await WD.app.loadSample(); return true; })()');
await ev('(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()');
await sleep(1500);

const SYMBOLS = new Set(['btn-undo', 'btn-redo']);

console.log('\n[A] 顶栏按钮：无边框 + 图标 + 文字');
const r = await ev(`(() => {
  const tb = document.querySelector('.topbar');
  const ids = ['btn-undo','btn-redo','btn-add-slide','btn-insert-text','btn-insert-title',
               'btn-insert-shape','btn-insert-image','btn-insert-video','btn-painter','btn-find',
               'btn-save-menu','btn-present','btn-theme','btn-help'];
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
  const fmt = ['fmt-bold','fmt-italic','fmt-underline','fmt-size-dec','fmt-size-inc',
               'fmt-align-left','fmt-align-center','fmt-align-right','fmt-color']
    .map(id => { const b = document.getElementById(id); const cs = getComputedStyle(b);
      return { id, border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth)
               + parseFloat(cs.borderRightWidth) + parseFloat(cs.borderBottomWidth),
               w: Math.round(b.getBoundingClientRect().width) }; });
  return { buttons, fmt, tbW: Math.round(tr.width), tbRight: Math.round(tr.right),
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
      fmtIdx: kids.indexOf(document.getElementById('fmt-group')),
    };
  })()`);
  check('顶栏「打开 HTML」按钮已删除', !t.hasOpen, JSON.stringify(t.hasOpen));
  check('顶栏「面板」按钮已删除', !t.hasPanels, JSON.stringify(t.hasPanels));
  check('「载入示例课件」按钮已删除', !t.hasSample2, String(t.hasSample2));
  check('独立的「有未保存修改」徽章已删除', !t.hasDirtyBadge, String(t.hasDirtyBadge));
  check('文件名胶囊仍在顶栏里', t.hasFileChip, JSON.stringify(t));
  check('文件名胶囊位于撤销之后、文字格式条之前',
    t.chipIdx > t.undoIdx && t.chipIdx < t.fmtIdx, JSON.stringify(t));
  check('新增「图片」按钮', t.hasImage);
  check('新增「视频」按钮', t.hasVideo);
  check('视频文件选择器存在', t.videoInput);
  check('file-input 仍在（打开功能的落点）', t.fileInput);

  /* 形状下拉：9 种真正的形状（图片/视频已上移为独立按钮；横线/标签已换成线条与新形状） */
  const sh = await ev(`(() => {
    document.getElementById('btn-insert-shape').click();
    const n = document.querySelectorAll('#menu-insert .shape-row button');
    const out = { count: n.length, titles: Array.from(n).map(b => b.title) };
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return out;
  })()`);
  check('形状下拉共 9 种', sh.count === 9, JSON.stringify(sh));
  check('形状下拉里没有「图片」「视频」「横线」「标签」',
    !/图片|视频|横线|标签/.test(sh.titles.join(',')), sh.titles.join(','));
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

  /* 保存与导出：打开入口并入，且排在第一位 */
  const sm = await ev(`(() => {
    document.getElementById('btn-save-menu').click();
    const items = Array.from(document.querySelectorAll('#menu-save .menu-item')).map(b => b.textContent.trim());
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return items;
  })()`);
  check('保存与导出共 4 项', sm.length === 4, JSON.stringify(sm));
  check('第一项是「打开 HTML 文件」', /打开 HTML/.test(sm[0] || ''), JSON.stringify(sm));
  check('仍含 保存工程 / 导出 HTML / 导出 PPTX',
    /保存工程/.test(sm[1] || '') && /HTML/.test(sm[2] || '') && /PPTX/.test(sm[3] || ''), JSON.stringify(sm));
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

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (bad.length) { console.log('失败项:'); bad.forEach((b) => console.log('  - ' + b)); }
console.log('页面错误:', errors.length ? [...new Set(errors)].join(' | ') : '无');
ws.close();
process.exit(fail ? 1 : 0);
