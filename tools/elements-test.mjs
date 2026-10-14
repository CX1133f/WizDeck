/* 新增元素体系 + 两个形状约束 bug 的端到端回归。
   重点两条：
   · 圆形怎么拖都还是圆（约束生效）；
   · 线条怎么拖都不会从一维变成二维。
   两条都必须用**真实手柄拖动**验证，不能只读 CSS。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9620);
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
let id = 0; const pend = new Map(); const pageErrors = [];
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
async function mouse(type, x, y, btn) {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: btn || 'none', buttons: btn === 'left' && type !== 'mouseReleased' ? 1 : 0,
    clickCount: btn === 'left' ? 1 : 0,
  });
}
/* 真实按下-移动-松开，用来拖手柄 */
async function drag(fromX, fromY, toX, toY) {
  await mouse('mouseMoved', fromX, fromY);
  await mouse('mousePressed', fromX, fromY, 'left');
  const N = 8;
  for (let i = 1; i <= N; i++) {
    await mouse('mouseMoved', fromX + (toX - fromX) * i / N, fromY + (toY - fromY) * i / N);
    await sleep(24);
  }
  await mouse('mouseReleased', toX, toY, 'left');
  await sleep(320);
}
/* 选中刚插入的元素（addElement 已经选中了，这里只取坐标） */
const last = () => ev(`(() => {
  const n = WD.app.E.selection[0];
  if (!n) return { none: true };
  const r = n.getBoundingClientRect();
  return { tag: n.tagName, kind: n.getAttribute('data-wd-added'),
           w: +r.width.toFixed(1), h: +r.height.toFixed(1),
           cx: r.left + r.width / 2, cy: r.top + r.height / 2,
           left: r.left, top: r.top, right: r.right, bottom: r.bottom };
})()`);
/* 覆盖层上某个手柄的屏幕坐标 */
const handleAt = (cls) => ev(`(() => {
  const h = document.querySelector('#frame-box .handle${cls}');
  if (!h || h.style.display === 'none') return null;
  const r = h.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, visible: true };
})()`);

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);
await ev('(async () => { await WD.app.loadSample(); return true; })()');
await ev('(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()');
await sleep(800);

/* ═══ [1] 圆形：拖角不变椭圆 ═══ */
console.log('\n[1] 圆形：锁宽高比');
await ev(`(() => { WD.app._internal.addElement('circle'); return true; })()`);
await sleep(400);
const c0 = await last();
check('插入圆形 260×260', c0.kind === 'circle' && Math.abs(c0.w - c0.h) < 1.5, JSON.stringify(c0));
const cSE = await handleAt('.h-se');
await drag(cSE.x, cSE.y, cSE.x + 90, cSE.y);          /* 只向右拖，高度完全不动 */
const c1 = await last();
check('★ 只往右拖角，高度跟着等比放大',
  c1.w > c0.w + 40 && Math.abs(c1.w - c1.h) < 1.5,
  c0.w + '×' + c0.h + ' → ' + c1.w + '×' + c1.h);
const cNW = await handleAt('.h-nw');
await drag(cNW.x, cNW.y, cNW.x - 60, cNW.y - 30);     /* 斜着拖，更容易暴露比例失控 */
const c2 = await last();
check('★ 斜着拖角仍然是正圆',
  Math.abs(c2.w - c2.h) < 1.5, c2.w + '×' + c2.h);
/* 检查器改宽，高度也要跟上 */
await ev(`(() => {
  const i = document.getElementById('f-w');
  i.value = '500';
  i.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(350);
/* 注意：getBoundingClientRect 是**屏幕**像素，55% 缩放下不是画布坐标。
   要跟检查器输入框的 500 比，必须读内联 style（画布坐标）。 */
const c3 = await ev(`(() => {
  const n = WD.app.E.selection[0];
  return { cssW: parseFloat(n.style.width), cssH: parseFloat(n.style.height),
           iw: parseFloat(document.getElementById('f-w').value),
           ih: parseFloat(document.getElementById('f-h').value) };
})()`);
check('★ 检查器把宽改成 500，高度同步（画布坐标）',
  Math.abs(c3.cssW - 500) < 2 && Math.abs(c3.cssW - c3.cssH) < 1.5,
  c3.cssW + '×' + c3.cssH + '，检查器显示 ' + c3.iw + '×' + c3.ih);

/* ═══ [2] 椭圆自由拉伸（对照组） ═══ */
console.log('\n[2] 椭圆：自由拉伸，不锁比例');
await ev(`(() => { WD.app._internal.addElement('oval'); return true; })()`);
await sleep(400);
const o0 = await last();
const oSE = await handleAt('.h-se');
await drag(oSE.x, oSE.y, oSE.x + 90, oSE.y + 40);
const o1 = await last();
check('椭圆拖角后宽高可以不等',
  o1.w > o0.w + 40 && Math.abs((o1.w - o1.h) - (o0.w - o0.h)) > 20,
  o0.w + '×' + o0.h + ' → ' + o1.w + '×' + o1.h);

/* ═══ [3] 线条：一维不变二维 ═══ */
console.log('\n[3] 直线 / 箭头：锁高度');
for (const [kind, name] of [['line', '直线'], ['arrow', '箭头'], ['dblarrow', '双向箭头']]) {
  await ev(`(() => { WD.app._internal.addElement('${kind}'); return true; })()`);
  await sleep(420);
  const a0 = await last();
  const before = a0.h;
  /* 选中后看上下手柄是不是被藏起来了 */
  const nH = await handleAt('.h-n');
  const sH = await handleAt('.h-s');
  check(name + '：上/下手柄被隐藏（点了没意义）', nH === null && sH === null,
    'n=' + JSON.stringify(nH) + ' s=' + JSON.stringify(sH));
  const eH = await handleAt('.h-e');
  if (eH) {
    await drag(eH.x, eH.y, eH.x + 70, eH.y + 120);   /* 故意斜着拖，含纵向分量 */
    const a1 = await last();
    check('★ ' + name + '：斜拖后高度纹丝不动（' + before + 'px）',
      Math.abs(a1.h - before) < 1, before + ' → ' + a1.h);
    check('★ ' + name + '：长度确实变了', a1.w > a0.w + 30, a0.w + ' → ' + a1.w);
  } else {
    check(name + '：右���柄存在', false, '没找到 .h-e');
  }
}
/* 箭头本身画出来了吗 */
const arrowSvg = await ev(`(() => {
  const n = WD.app.E.stage.getDoc().querySelector('[data-wd-added="arrow"]');
  if (!n) return { none: true };
  const svg = n.querySelector('svg');
  const p = svg && svg.querySelector('path');
  const r = n.getBoundingClientRect();
  return { hasSvg: !!svg, d: p ? p.getAttribute('d') : '',
           vb: svg ? svg.getAttribute('viewBox') : '',
           cssW: parseFloat(n.style.width), cssH: parseFloat(n.style.height),
           box: [Math.round(r.width), Math.round(r.height)] };
})()`);
check('箭头生成了 SVG path', arrowSvg.hasSvg === true && /M[\d.]+,/.test(arrowSvg.d || ''), JSON.stringify(arrowSvg).slice(0, 140));
/* viewBox 是按**画布坐标**（内联 style.width）算的，不是屏幕像素 */
check('箭头 viewBox 与元素画布尺寸一致',
  Math.abs(parseFloat((arrowSvg.vb || '0 0 0 0').split(' ')[2]) - arrowSvg.cssW) < 0.5 &&
  Math.abs(parseFloat((arrowSvg.vb || '0 0 0 0').split(' ')[3]) - arrowSvg.cssH) < 0.5,
  arrowSvg.vb + ' vs ' + arrowSvg.cssW + '×' + arrowSvg.cssH);
/* 可选中性要用 isSelectable 判，而且**必须传 frame 的 window** ——
   hasOwnPaint 内部要 win.getComputedStyle，不传会抛异常被吞掉、返回 false。
   另外选中态下覆盖层本来就盖在上面，拿 elementFromPoint 量只会量到选择框。 */
const arrowPick = await ev(`(() => {
  const n = WD.app.E.stage.getDoc().querySelector('[data-wd-added="arrow"]');
  const I = WD.app._internal;
  return { selectable: I.isSelectable(n, n.ownerDocument.defaultView),
           bg: getComputedStyle(n).backgroundColor,
           childSvg: !!n.querySelector('svg') };
})()`);
check('箭头可被选中（透明盒子也算有绘制）', arrowPick.selectable === true, JSON.stringify(arrowPick));

/* ═══ [4] 形状清单 ═══ */
console.log('\n[4] 形状下拉内容');
const shapeMenu = await ev(`(() => {
  document.getElementById('btn-insert-shape').click();
  const n = document.querySelectorAll('#menu-insert .shape-row button');
  const titles = Array.from(n).map(b => b.title);
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { count: n.length, titles };
})()`);
check('形状共 9 种', shapeMenu.count === 9, JSON.stringify(shapeMenu));
check('含 矩形/圆角矩形/圆形/椭圆/三角形/平行四边形/直线/箭头/双向箭头',
  ['矩形', '圆角矩形', '圆形', '椭圆', '三角形', '平行四边形', '直线', '箭头', '双向箭头']
    .every((t) => shapeMenu.titles.indexOf(t) >= 0), shapeMenu.titles.join(','));
check('「横线」已删除', shapeMenu.titles.indexOf('横线') < 0, shapeMenu.titles.join(','));
check('「标签」已删除', shapeMenu.titles.indexOf('标签') < 0, shapeMenu.titles.join(','));

/* 逐个插入，看几何是否合理 */
console.log('\n[5] 每种形状都能插进来且有尺寸');
for (const k of ['rect', 'round', 'circle', 'oval', 'triangle', 'para', 'line', 'arrow', 'dblarrow']) {
  const r = await ev(`(() => {
    const n = WD.app._internal.addElement('${k}');
    if (!n) return { none: true };
    const b = n.getBoundingClientRect();
    return { tag: n.tagName, w: Math.round(b.width), h: Math.round(b.height),
             selected: (WD.app.E.selection[0] || []) === n };
  })()`);
  check(k + ' 插入后有实际尺寸并被选中',
    r.w > 1 && r.h >= 1 && r.selected === true, JSON.stringify(r));
}

/* ═══ [6] 标题四级 ═══ */
console.log('\n[6] 标题：一级到四级');
const titleMenu = await ev(`(() => {
  document.getElementById('btn-insert-title').click();
  const n = document.querySelectorAll('#menu-title .shape-row button');
  const titles = Array.from(n).map(b => b.title);
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return titles;
})()`);
check('标题下拉 4 项', titleMenu.length === 4, JSON.stringify(titleMenu));
check('含一/二/三/四级',
  [0, 1, 2, 3].every((i) => /一|二|三|四/.test(titleMenu[i] || '')), JSON.stringify(titleMenu));
const titleInfo = [];
for (const [i, k] of ['title1', 'title2', 'title3', 'title4'].entries()) {
  const r = await ev(`(() => {
    const n = WD.app._internal.addElement('${k}');
    const b = n.getBoundingClientRect();
    return { tag: n.tagName, h: Math.round(b.height), fs: n.style.font };
  })()`);
  titleInfo.push(r);
  check('第' + (i + 1) + '级标题用 ' + ['H1', 'H2', 'H3', 'H4'][i] + ' 标签', r.tag === ['H1', 'H2', 'H3', 'H4'][i], JSON.stringify(r));
}
const sizes = titleInfo.map((t) => parseInt((t.fs.match(/(\d+)px/) || [])[1] || 0, 10));
check('四级字号依次递减', sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] > sizes[3], JSON.stringify(sizes));

/* ═══ [7] 文本框横竖 ═══ */
console.log('\n[7] 文本框：横向 / 竖向');
const textMenu = await ev(`(() => {
  document.getElementById('btn-insert-text').click();
  const n = document.querySelectorAll('#menu-text .shape-row button');
  const titles = Array.from(n).map(b => b.title);
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return titles;
})()`);
check('文本框下拉 2 项', textMenu.length === 2, JSON.stringify(textMenu));
const tv = await ev(`(() => {
  const n = WD.app._internal.addElement('textv');
  const cs = n.ownerDocument.defaultView.getComputedStyle(n);
  const b = n.getBoundingClientRect();
  return { writingMode: cs.writingMode, w: Math.round(b.width), h: Math.round(b.height) };
})()`);
check('竖向文本框 writing-mode = vertical-rl', /vertical/.test(tv.writingMode), JSON.stringify(tv));
check('竖向文本框是「高瘦」形（高 > 宽）', tv.h > tv.w * 2, JSON.stringify(tv));

/* ═══ [8] 表格 ═══ */
console.log('\n[8] 表格：自定义行列');
await ev(`(() => { document.getElementById('btn-insert-table').click(); return true; })()`);
await sleep(400);
const dlg = await ev(`(() => {
  const m = document.getElementById('modal');
  return { open: !m.hidden, title: document.getElementById('modal-title').textContent,
           r: !!document.getElementById('tbl-r'), c: !!document.getElementById('tbl-c') };
})()`);
check('点「表格」弹出对话框', dlg.open === true && dlg.r && dlg.c, JSON.stringify(dlg));
const tbl = await ev(`(async () => {
  document.getElementById('tbl-r').value = '4';
  document.getElementById('tbl-c').value = '6';
  await new Promise(r => setTimeout(r, 80));
  const btns = Array.from(document.querySelectorAll('#modal-foot .btn'));
  const ok = btns.find(b => b.textContent.trim() === '插入');
  ok.click();
  await new Promise(r => setTimeout(r, 400));
  const n = WD.app.E.selection[0];
  if (!n || n.tagName !== 'TABLE') return { none: true, tag: n && n.tagName };
  return { rows: n.rows.length, cols: n.rows[0].cells.length,
           w: Math.round(n.getBoundingClientRect().width),
           head: n.rows[0].cells[0].textContent,
           border: getComputedStyle(n.rows[0].cells[0]).borderTopWidth };
})()`);
check('按输入的行列插入（4 行 6 列）', tbl.rows === 4 && tbl.cols === 6, JSON.stringify(tbl));
check('表格有边框、表头有底色文字', /1px/.test(tbl.border || '') && /表头/.test(tbl.head || ''), JSON.stringify(tbl));
/* 检查器增删行列 */
const tblOps = await ev(`(async () => {
  const I = WD.app._internal;
  const before = WD.app.E.selection[0].rows.length;
  document.getElementById('tbl-add-row').click();
  await new Promise(r => setTimeout(r, 300));
  const afterAdd = WD.app.E.selection[0].rows.length;
  document.getElementById('tbl-del-col').click();
  await new Promise(r => setTimeout(r, 300));
  const n = WD.app.E.selection[0];
  return { before, afterAdd, afterDelColCols: n.rows[0].cells.length,
           toolsVisible: !document.getElementById('tbl-tools').hidden,
           selectable: I.isSelectable(n, n.ownerDocument.defaultView) };
})()`);
check('检查器「＋行」真的加了一行', tblOps.afterAdd === tblOps.before + 1, JSON.stringify(tblOps));
check('检查器「－列」真的减了一列', tblOps.afterDelColCols === tbl.cols - 1,
  tbl.cols + ' → ' + tblOps.afterDelColCols);
check('选中表格时工具条可见', tblOps.toolsVisible === true, JSON.stringify(tblOps));
check('重建后的表格仍可选中', tblOps.selectable === true, JSON.stringify(tblOps));

/* ★ 表格必须真的听 width / height。
   曾经每个 td 都写死了 width 且是 content-box，padding + 折叠边框额外累加，
   整张表被内容顶到比声明值还宽（5 列 200px → 实际 1106px），
   于是「检查器里写 620」看上去成功了、实际纹丝不动。这里用 offsetWidth 量。 */
const tblW = await ev(`(() => {
  const n = WD.app.E.selection[0];
  const cssW = parseFloat(n.style.width), cssH = parseFloat(n.style.height);
  const before = { cssW: cssW, cssH: cssH, w: n.offsetWidth, h: n.offsetHeight };
  const i = document.getElementById('f-w');
  i.value = '900';
  i.dispatchEvent(new Event('change', { bubbles: true }));
  return { before: before, nCols: n.rows[0].cells.length,
           afterW: n.offsetWidth, afterCss: parseFloat(n.style.width),
           colW: Math.round(n.rows[0].cells[0].getBoundingClientRect().width) };
})()`);
check('★ 声明的宽度就是实际宽度（不被内容顶开）',
  Math.abs(tblW.before.w - tblW.before.cssW) <= 2 && Math.abs(tblW.before.h - tblW.before.cssH) <= 2,
  JSON.stringify(tblW.before));
check('★ 检查器改宽 900 真的生效（900±2）',
  Math.abs(tblW.afterW - 900) <= 2 && Math.abs(tblW.afterCss - 900) <= 2,
  'offsetWidth=' + tblW.afterW + ' style.width=' + tblW.afterCss);
check('★ 各列按 900 等分', Math.abs(tblW.colW * tblW.nCols - 900) <= 8,
  tblW.nCols + ' 列 × 列宽 ' + tblW.colW);

/* ═══ [9] 公式 / LaTeX ═══ */
console.log('\n[9] 公式：直接插入 + LaTeX 自动解析');
const fMenu = await ev(`(() => {
  document.getElementById('btn-insert-formula').click();
  const n = document.querySelectorAll('#menu-formula .shape-row button');
  const titles = Array.from(n).map(b => b.title);
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return titles;
})()`);
check('公式下拉 2 项', fMenu.length === 2, JSON.stringify(fMenu));
check('含「插入公式」与「LaTeX 公式（自动解析）」',
  /插入公式/.test(fMenu[0] || '') && /LaTeX/.test(fMenu[1] || ''), JSON.stringify(fMenu));
const formula = await ev(`(async () => {
  const n = WD.app._internal.addElement('formula');
  await new Promise(r => setTimeout(r, 200));
  const m = n.querySelector('math');
  return { hasMath: !!m, msup: !!n.querySelector('msup'),
           latex: n.getAttribute('data-wd-latex') };
})()`);
check('直接插入的公式含 <math> 与上标', formula.hasMath && formula.msup, JSON.stringify(formula));
const texDlg = await ev(`(async () => {
  document.getElementById('btn-insert-formula').click();
  await new Promise(r => setTimeout(r, 200));
  const items = Array.from(document.querySelectorAll('#menu-formula .shape-row button'));
  items[1].click();                                  /* LaTeX 公式 */
  await new Promise(r => setTimeout(r, 350));
  const m = document.getElementById('modal');
  const src = document.getElementById('tex-src');
  const prev = document.getElementById('tex-preview');
  return { open: !m.hidden, hasInput: !!src,
           previewMath: !!(prev && prev.querySelector('math')),
           previewMfrac: !!(prev && prev.querySelector('mfrac')) };
})()`);
check('点「LaTeX 公式」弹出输入框', texDlg.open === true && texDlg.hasInput === true, JSON.stringify(texDlg));
check('默认式子实时预览已渲染', texDlg.previewMath === true, JSON.stringify(texDlg));
const texIns = await ev(`(async () => {
  const src = document.getElementById('tex-src');
  src.value = '\\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}';
  src.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const prev = document.getElementById('tex-preview');
  const hasMfrac = !!prev.querySelector('mfrac');
  const hasMsqrt = !!prev.querySelector('msqrt');
  const btns = Array.from(document.querySelectorAll('#modal-foot .btn'));
  btns.find(b => b.textContent.trim() === '插入').click();
  await new Promise(r => setTimeout(r, 400));
  const n = WD.app.E.selection[0];
  return { hasMfrac, hasMsqrt, kind: n && n.getAttribute('data-wd-added'),
           insertedMfrac: !!(n && n.querySelector('mfrac')),
           latex: n && n.getAttribute('data-wd-latex') };
})()`);
check('预览实时把 \\frac 解析成 <mfrac>', texIns.hasMfrac === true, JSON.stringify(texIns));
check('预览把 \\sqrt 解析成 <msqrt>', texIns.hasMsqrt === true, JSON.stringify(texIns));
check('确定后插进画布且带上 LaTeX 源码', texIns.kind === 'formula' && texIns.insertedMfrac === true, JSON.stringify(texIns));
check('LaTeX 源码被存进 data-wd-latex（可再次编辑）', /frac/.test(texIns.latex || ''), JSON.stringify(texIns.latex));

/* ═══ [10] 图表 ═══ */
console.log('\n[10] 图表：柱状 / 折线 / 饼状');
const cMenu = await ev(`(() => {
  document.getElementById('btn-insert-chart').click();
  const n = document.querySelectorAll('#menu-chart .shape-row button');
  const titles = Array.from(n).map(b => b.title);
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return titles;
})()`);
check('图表下拉 3 项', cMenu.length === 3, JSON.stringify(cMenu));
check('含 柱状图/折线图/饼状图',
  /柱状图/.test(cMenu[0] || '') && /折线图/.test(cMenu[1] || '') && /饼状图/.test(cMenu[2] || ''), JSON.stringify(cMenu));
for (const [i, k] of ['bar', 'chartline', 'pie'].entries()) {
  const c = await ev(`(async () => {
    const n = WD.app._internal.addElement('${k}');
    if (!n) return { none: true };
    await new Promise(r => setTimeout(r, 120));
    const b = n.getBoundingClientRect();
    return { tag: n.tagName, kind: n.getAttribute('data-wd-added'),
             png: /^data:image\\/png;base64,/.test(n.getAttribute('src') || ''),
             bytes: (n.getAttribute('src') || '').length,
             w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
  check(cMenu[i] + '：插成 PNG 图片且有真实像素',
    c.tag === 'IMG' && c.png === true && c.bytes > 3000 && c.w > 100,
    JSON.stringify(c).slice(0, 120));
}

/* ═══ [11] 栅格化：这些形状进 PPTX 时要变成贴图，贴图不能是空白 ═══
   曾经三角形 / 平行四边形 / 直线 / 箭头 / 双向箭头在 PPTX 里全是**纯白**的图，
   画布上却完全正常。根因有两条，都在这一段量：
     · foreignObject 已经按盒子原点平移过，克隆树根节点又带着自己的 left/top → 偏移翻倍；
     · 克隆树被当 XML 重新解析，<svg> 不会自动进 SVG 命名空间 → 什么都不画。

   ⚠ 贴图是**透明底**（导出器要的就是透明底），PNG 的透明像素 RGB 是 0,0,0 ——
   所以只能量 alpha 覆盖率。量 RGB 会把透明区域当成「有墨」，
   圆形会量成 99.9% 而不是 π/4 的 78.5%，看起来像坏了，其实是尺子错了。 */
console.log('\n[11] 栅格化：贴图必须有真实像素');
const raster = await ev(`(async () => {
  const cover = (canvas) => {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    c.getContext('2d').drawImage(canvas, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; const tot = c.width * c.height;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) n++;
    return +(n / tot * 100).toFixed(2);
  };
  const m = await WD.render.mountFrame(WD.store.model.slides[0].doc, { timeout: 25000 });
  const out = {};
  const nodes = Array.from(m.doc.querySelectorAll('[data-wd-added]'));
  for (const n of nodes) {
    const kind = n.getAttribute('data-wd-added');
    if (['bar', 'chartline', 'pie', 'table', 'formula'].indexOf(kind) >= 0) continue;
    const box = WD.render.boxInFrame(n);
    const c = await WD.render.rasterizeNode(n, m.win, { box: box, scale: 2, background: null });
    out[kind] = c ? cover(c) : null;
  }
  m.frame.remove();
  return out;
})()`);
for (const k of ['rect', 'circle', 'triangle', 'para', 'line', 'arrow', 'dblarrow']) {
  check('★ ' + k + ' 栅格化后有真实像素', (raster[k] || 0) > 1, k + ' alpha 覆盖率 ' + raster[k] + '%');
}
check('★ 圆形覆盖率接近 π/4（78.5%±6）',
  Math.abs((raster.circle || 0) - 78.5) < 6, String(raster.circle));
check('★ 三角形覆盖率约一半', (raster.triangle || 0) > 40 && (raster.triangle || 0) < 60, String(raster.triangle));
check('★ 直线覆盖率接近满格（6px 细线）',
  (raster.line || 0) > 90, String(raster.line));

/* 帧内坐标 → 顶层页面坐标。
   ⚠ CDP 的 Input.dispatchMouseEvent 发的是**顶层页面**坐标，
   而画布里元素的 getBoundingClientRect() 是 **iframe 视口**坐标。
   两者差一个 iframe 的位置与画布缩放 —— 不换算就会点在隔壁元素上，
   测出来的是「点歪了」，会被误判成产品缺陷。 */
async function toPage(x, y) {
  const m = await ev(`(() => {
    const st = WD.app.E.stage;
    const f = st.frame.getBoundingClientRect();
    return { l: f.left, t: f.top, z: st.fitMode ? st.scale : st.zoom };
  })()`);
  return { x: Math.round(m.l + x * m.z), y: Math.round(m.t + y * m.z) };
}
async function dblclickAt(innerX, innerY) {
  const p = await toPage(innerX, innerY);
  await mouse('mouseMoved', p.x, p.y);
  await mouse('mousePressed', p.x, p.y, 'left');
  await mouse('mouseReleased', p.x, p.y, 'left');
  await sleep(50);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 2,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 2,
  });
  await sleep(340);
}
/* 真实打字。key 字段不能省 —— 少了它浏览器收不到要打的字符 */
async function typeText(t) {
  for (const ch of t) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(20);
  }
  await sleep(150);
}
async function pressEsc() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(320);
}

/* ═══ [12] 公式就是一个文本框 + 公式菜单改成「插入公式 / 插入 LaTeX」 ═══ */
console.log('\n[12] 公式：去掉卡片壳，菜单按 PowerPoint 的叫法');
const fBox = await ev(`(() => {
  const n = WD.app._internal.addElement('formula');
  const cs = getComputedStyle(n);
  return { tag: n.tagName, bg: cs.backgroundColor, borderTop: cs.borderTopWidth,
           borderStyle: cs.borderTopStyle, radius: cs.borderRadius, inlineBorder: n.style.border };
})()`);
check('★ 公式无底色', /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(fBox.bg), JSON.stringify(fBox));
check('★ 公式无边框、无圆角',
  parseFloat(fBox.borderTop) === 0 && fBox.borderStyle === 'none' && parseFloat(fBox.radius) === 0,
  JSON.stringify(fBox));
const fMenu2 = await ev(`(() => {
  document.getElementById('btn-insert-formula').click();
  const bs = Array.from(document.querySelectorAll('#menu-formula .shape-row button'));
  const out = bs.map(b => ({ title: b.title,
    ico: (b.querySelector('.mi-ico') || {}).textContent,
    txt: (b.querySelector('.mi-txt') || {}).textContent }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return out;
})()`);
check('公式菜单两项：插入公式 / 插入 LaTeX',
  fMenu2.length === 2 && fMenu2[0].title === '插入公式' && fMenu2[1].title === '插入 LaTeX',
  JSON.stringify(fMenu2));
check('两项图标不同（√x / TeX，避免两个 ∑ 看不出区别）',
  fMenu2[0].ico !== fMenu2[1].ico && fMenu2[0].ico.length > 0, JSON.stringify(fMenu2));

/* ═══ [13] 表格：数据行也要能双击编辑 ═══
   原来「只有第一行能填」有两个原因叠在一起：
     · textBlockFor 要求「这块必须有文字」，空单元格直接被跳过；
     · 双击走 pickAt，命中的是**整张表**，于是永远落不到具体某一格。
   现在双击先用 elementFromPoint 找到那一格，再进编辑。 */
console.log('\n[13] 表格：数据行单元格可编辑');
await clearAdded();
await ev(`(() => {
  const I = WD.app._internal;
  I.clearSelection();
  I.addElement('table');
  return true;
})()`);
await sleep(420);
await ev(`(() => {
  document.getElementById('tbl-r').value = '3';
  document.getElementById('tbl-c').value = '3';
  Array.from(document.querySelectorAll('#modal-foot .btn')).find(b => b.textContent.trim() === '插入').click();
  return true;
})()`);
await sleep(600);
await ev(`(() => {
  const t = WD.app.E.selection[0];
  t.style.left = '160px'; t.style.top = '160px'; t.style.width = '600px';
  WD.app.commit('摆位');
  return true;
})()`);
await sleep(800);
const cellPt = await ev(`(() => {
  const tb = WD.app.E.stage.getDoc().querySelector('table[data-wd-added]');
  const td = tb.rows[2].cells[1];
  const b = td.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
})()`);
check('双击点确实落在第3行第2列上（先自证落点）',
  (await hitIs(cellPt.x, cellPt.y)).tag === 'TD' &&
  (await hitIs(cellPt.x, cellPt.y)).row === 2,
  JSON.stringify(await hitIs(cellPt.x, cellPt.y)));
await dblclickAt(cellPt.x, cellPt.y);
const cellEd = await ev(`(() => {
  const e = WD.app.E.editing;
  return { tag: e ? e.tagName : null, row: e ? e.parentElement.rowIndex : null,
           col: e ? e.cellIndex : null, ce: e ? e.getAttribute('contenteditable') : null };
})()`);
check('★ 双击**数据行**单元格进入编辑（不是表头行）',
  cellEd.tag === 'TD' && cellEd.row === 2 && cellEd.col === 1, JSON.stringify(cellEd));
await typeText('填第二行');
const cellTyped = await ev(`(() => {
  const tb = WD.app.E.stage.getDoc().querySelector('table[data-wd-added]');
  return { head: tb.rows[0].cells[1].textContent, body: tb.rows[2].cells[1].textContent };
})()`);
check('★ 打出来的字落在**那一格**里',
  cellTyped.body.indexOf('填第二行') === 0 && cellTyped.head.indexOf('填第二行') !== 0,
  JSON.stringify(cellTyped));
await pressEsc();
const cellAfter = await ev(`(() => {
  const tb = WD.app.E.stage.getDoc().querySelector('table[data-wd-added]');
  return { body: tb.rows[2].cells[1].textContent, editing: !!WD.app.E.editing };
})()`);
check('退出编辑后内容保留在单元格里', cellAfter.body.indexOf('填第二行') === 0 && !cellAfter.editing,
  JSON.stringify(cellAfter));

/* ═══ [14] 图表：有文字 + 双击能改数据 ═══ */
console.log('\n[14] 图表：标题/图例/数值 + 双击改数据');
/* 像素层面确认「真的画了字」。
   ⚠ 两个坑：
   ① 不能量整张图的墨量 —— 去掉标题会让绘图区上移、柱子变高，整图墨量反而**变多**；
   ② 不能量「标题带」的总墨量 —— 网格线(#d8e0ea)、坐标刻度(#7c8ba1)也落在同一条带里。
   所以只数**文字颜色**那一档：标题 #16202e、图例文字 #4a5a70 算数，
   网格线 / 刻度 / 柱子(#3b6fd4) 都不在阈值内。 */
const chartInk = await ev(`(() => {
  const cv = document.createElement('canvas'); cv.width = 960; cv.height = 560;
  /* 只数深色文字像素（排除网格线、刻度数字、柱子填充） */
  const textInk = (d, y0, y1) => {
    WD.elements.drawChart('bar', cv, d);
    const x = cv.getContext('2d').getImageData(0, y0, 960, y1 - y0).data;
    let n = 0;
    for (let i = 0; i < x.length; i += 4) {
      if (x[i] < 110 && x[i + 1] < 115 && x[i + 2] < 140) n++;
    }
    return n;
  };
  const base = WD.elements.defaultChartData('bar');
  return {
    标题带: {
      有: textInk(base, 0, 52),
      无: textInk(Object.assign({}, base, { title: '' }), 0, 52),
    },
    图例带: {
      有: textInk(base, 508, 560),
      无: textInk(Object.assign({}, base, { showLegend: false }), 508, 560),
    },
    绘图区: {
      无值: textInk(base, 52, 508),
      有值: textInk(Object.assign({}, base, { showValues: true }), 52, 508),
    },
  };
})()`);
check('★ 图表标题是真的画上去的（标题带文字像素：去掉就归零）',
  chartInk.标题带.有 > 300 && chartInk.标题带.无 < 30, JSON.stringify(chartInk.标题带));
check('★ 柱状图也有图例（原来只有折线图有）',
  chartInk.图例带.有 > 120 && chartInk.图例带.无 < 30, JSON.stringify(chartInk.图例带));
check('★ 数据标签可开关（打开后绘图区文字变多）',
  chartInk.绘图区.有值 > chartInk.绘图区.无值 + 200, JSON.stringify(chartInk.绘图区));

await clearAdded();
await ev(`(() => {
  const I = WD.app._internal;
  I.clearSelection();
  I.addElement('bar');
  return true;
})()`);
await sleep(600);
await ev(`(() => {
  const img = WD.app.E.selection[0];
  img.style.left = '1000px'; img.style.top = '160px';
  img.style.width = '700px'; img.style.height = '408px';
  WD.app.commit('摆位');
  return true;
})()`);
await sleep(800);
const chartMeta = await ev(`(() => {
  const img = WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]');
  const b = img.getBoundingClientRect();
  const d = JSON.parse(img.getAttribute('data-wd-chart'));
  return { kind: img.getAttribute('data-wd-chart-kind'), title: d.title,
           labels: d.labels.length, series: d.series.length,
           srcLen: (img.getAttribute('src') || '').length,
           x: b.left + b.width / 2, y: b.top + b.height / 2 };
})()`);
check('图表元素带着自己的数据模型（标题/分类/系列）',
  !!chartMeta.kind && !!chartMeta.title && chartMeta.labels >= 2 && chartMeta.series >= 1,
  JSON.stringify({ kind: chartMeta.kind, title: chartMeta.title, labels: chartMeta.labels, series: chartMeta.series }));
check('双击点确实落在图表上（先自证落点）',
  (await hitIs(chartMeta.x, chartMeta.y)).tag === 'IMG', JSON.stringify(await hitIs(chartMeta.x, chartMeta.y)));
await dblclickAt(chartMeta.x, chartMeta.y);
const chartDlg = await ev(`(() => ({
  open: !document.getElementById('modal').hidden,
  title: document.getElementById('modal-title').textContent,
  hasTitle: !!document.getElementById('ch-title'),
  hasLabels: !!document.getElementById('ch-labels'),
  rows: document.querySelectorAll('.chart-row').length,
  legend: !!document.getElementById('ch-legend'),
  values: !!document.getElementById('ch-values'),
}))()`);
check('★ 双击图表弹出数据表编辑器',
  chartDlg.open && /图表/.test(chartDlg.title || '') && chartDlg.hasTitle && chartDlg.hasLabels,
  JSON.stringify(chartDlg));
check('数据表里每个系列一行，可勾图例/数值',
  chartDlg.rows >= 1 && chartDlg.legend && chartDlg.values, JSON.stringify(chartDlg));
/* 标签列宽度不够会把「系列与数值」折成两行掉一个孤字，肉眼很明显 */
const lblLines = await ev(`(() => Array.from(document.querySelectorAll('#modal .form-lbl')).map((el) => ({
  txt: el.textContent.trim(),
  lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || 18)),
  need: (() => { const o = el.style.width; el.style.width = 'auto'; const w = el.getBoundingClientRect().width; el.style.width = o; return Math.ceil(w); })(),
})))()`);
check('数据表标签一律单行不折断',
  lblLines.length > 0 && lblLines.every((l) => l.lines <= 1),
  JSON.stringify(lblLines));
await ev(`(() => {
  document.getElementById('ch-title').value = '改过的标题';
  document.getElementById('ch-labels').value = '甲, 乙, 丙';
  document.getElementById('cs-v0').value = '10, 20, 30';
  document.getElementById('ch-values').checked = true;
  Array.from(document.querySelectorAll('#modal-foot .btn')).find(b => b.textContent.trim() === '应用').click();
  return true;
})()`);
await sleep(800);
const chartApplied = await ev(`(() => {
  const img = WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]');
  const d = JSON.parse(img.getAttribute('data-wd-chart'));
  return { title: d.title, labels: d.labels, values: d.series[0].data,
           showValues: d.showValues, modalHidden: document.getElementById('modal').hidden,
           srcLen: (img.getAttribute('src') || '').length };
})()`);
check('★ 改完标题立即生效并写回数据模型',
  chartApplied.title === '改过的标题' && chartApplied.modalHidden, JSON.stringify(chartApplied));
check('★ 改完分类与数值立即生效',
  JSON.stringify(chartApplied.labels) === JSON.stringify(['甲', '乙', '丙']) &&
  JSON.stringify(chartApplied.values.slice(0, 3)) === JSON.stringify([10, 20, 30]) &&
  chartApplied.srcLen !== chartMeta.srcLen,
  JSON.stringify(chartApplied));

/* 清掉前面各段插进来的元素：后面的用例要「点哪儿就是哪儿」，
   否则新元素压在旧元素上，双击落点会被上一个用例的残留抢走。 */
async function clearAdded() {
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    Array.from(doc.querySelectorAll('[data-wd-added]')).forEach(n => n.remove());
    WD.app._internal.clearSelection();
    WD.app.commit('清场');
    return true;
  })()`);
  await sleep(520);
}
/* 双击前先自证「这个点确实落在目标元素上」——点歪了要当场报出来，
   绝不能让它伪装成一条产品缺陷。 */
async function hitIs(x, y, tag, rowIndex, cellIndex) {
  return await ev(`(() => {
    const n = WD.app.E.stage.getDoc().elementFromPoint(${x}, ${y});
    if (!n) return { tag: null };
    return { tag: n.tagName,
             row: n.parentElement && n.parentElement.rowIndex,
             col: n.cellIndex };
  })()`);
}

/* ═══ [15] 插入组下拉统一成「左图标 + 右文字」 ═══
   以前是一排只有符号的方块：四个「H」并排，哪个是一级哪个是四级全靠猜，
   中文标签只藏在 title 里，得把鼠标停上去等 tooltip。 */
console.log('\n[15] 插入组下拉：左图标 + 右文字说明');
const menuAudit = await ev(`(() => {
  const out = {};
  [['btn-insert-shape', 'menu-insert'], ['btn-insert-title', 'menu-title'],
   ['btn-insert-text', 'menu-text'], ['btn-insert-formula', 'menu-formula'],
   ['btn-insert-chart', 'menu-chart']].forEach((pair) => {
    document.getElementById(pair[0]).click();
    const bs = Array.from(document.querySelectorAll('#' + pair[1] + ' .shape-row button'));
    out[pair[1]] = bs.map((b) => {
      const ico = b.querySelector('.mi-ico');
      const txt = b.querySelector('.mi-txt');
      const r = b.getBoundingClientRect();
      return { hasIco: !!ico, hasTxt: !!txt,
               ico: ico ? ico.textContent : '', txt: txt ? txt.textContent : '',
               w: Math.round(r.width), h: Math.round(r.height),
               isMenuItem: b.classList.contains('menu-item') };
    });
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return out;
})()`);
let auditBad = 0;
for (const [menu, items] of Object.entries(menuAudit)) {
  const missing = items.filter((i) => !i.hasIco || !i.hasTxt || !i.ico || !i.txt || !i.isMenuItem);
  if (missing.length) auditBad++;
  check('#' + menu + ' 每项都有图标 + 文字',
    items.length > 0 && missing.length === 0,
    JSON.stringify(items.slice(0, 2)) + (missing.length ? ' 缺: ' + JSON.stringify(missing.slice(0, 2)) : ''));
}
check('★ 四个标题的图标互不相同（不能都是 H）',
  new Set(menuAudit['menu-title'].map((i) => i.ico)).size === 4,
  JSON.stringify(menuAudit['menu-title'].map((i) => i.ico)));
check('★ 横排/竖排文本框的图标互不相同',
  menuAudit['menu-text'][0].ico !== menuAudit['menu-text'][1].ico,
  JSON.stringify(menuAudit['menu-text'].map((i) => i.ico)));
check('★ 条目是竖排的菜单项（高度够放一行文字，不是小方块）',
  menuAudit['menu-insert'].every((i) => i.h >= 28 && i.w >= 140),
  JSON.stringify(menuAudit['menu-insert'][0]));

console.log('\n通过 ' + pass + '  失败 ' + fail);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
check('控制台零异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
ws.close();
process.exit(0);
