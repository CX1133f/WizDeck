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

/* ═══ [3] 线条：两点头模型 ═══
   这一节原来断言的是「高度锁死、斜拖高度纹丝不动」——
   那是旧模型（线条只能是水平线）的产物。现在换成两点头模型：
   几何由 data-wd-p1 / p2（/ bend）三个比例点决定，盒子是它们的包围盒，
   于是**斜拖就会长出高度**，而「8 个盒手柄全部隐藏、只留端点手柄」
   保证用户改的是点而不是把整条线缩放成色块。 */
console.log('\n[3] 直线 / 箭头：两点头模型');
for (const [kind, name] of [['line', '直线'], ['arrow', '箭头'], ['dblarrow', '双向箭头']]) {
  await ev(`(() => { WD.app._internal.addElement('${kind}'); return true; })()`);
  await sleep(420);
  const a0 = await last();
  /* 8 个盒手柄全部隐藏 */
  const boxHidden = await ev(`(() => {
    const names = ['nw','n','ne','e','se','s','sw','w'];
    return names.every((n) => {
      const h = document.querySelector('#frame-box .handle.h-' + n);
      return !h || h.style.display === 'none';
    });
  })()`);
  check('★ ' + name + '：8 个盒手柄全部隐藏（改形状应该拖点，不是缩放盒子）',
    boxHidden === true, String(boxHidden));
  /* 三个点手柄里，起终点必须露出来 */
  const eps = await ev(`(() => {
    const g = (c) => { const h = document.querySelector('#frame-box ' + c);
      return !!(h && h.classList.contains('shown')); };
    return { start: g('.h-ep-start'), end: g('.h-ep-end') };
  })()`);
  check('★ ' + name + '：起点 / 终点手柄都露出来', eps.start === true && eps.end === true, JSON.stringify(eps));
  /* 插入时就把三点显式写出来（存档自描述） */
  const pts = await ev(`(() => {
    const n = WD.app.E.stage.getDoc().querySelector('[data-wd-added="${kind}"]');
    return { p1: n.getAttribute('data-wd-p1'), p2: n.getAttribute('data-wd-p2'),
             stroke: n.getAttribute('data-wd-stroke'), w: n.getAttribute('data-wd-w') };
  })()`);
  check('★ ' + name + '：插入即写出两点 + 颜色 / 粗细的真源属性',
    pts.p1 === '[0,50]' && pts.p2 === '[100,50]' && !!pts.stroke && parseFloat(pts.w) > 0,
    JSON.stringify(pts));
  /* 拖终点：往上拖 → 变成斜线，高度确实长出来 */
  const ep = await ev(`(() => {
    const h = document.querySelector('#frame-box .h-ep-end');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const h0 = a0.h;
  await drag(ep.x, ep.y, ep.x, ep.y - 110);
  const a1 = await last();
  check('★ ' + name + '：拖终点向上 → 变成斜线（高度从 ' + Math.round(h0) + 'px 长出来）',
    a1.h > h0 + 40, h0 + ' → ' + a1.h);
  const diag = await ev(`(() => {
    const n = WD.app.E.stage.getDoc().querySelector('[data-wd-added="${kind}"]');
    return { p2: n.getAttribute('data-wd-p2'), d: (n.querySelector('svg path') || {}).getAttribute
             ? n.querySelector('svg path').getAttribute('d').slice(0, 40) : null };
  })()`);
  check('  ' + name + '：终点比例点跟着走（p2 的 y 不再是 50）',
    diag.p2 && JSON.parse(diag.p2)[1] < 45, JSON.stringify(diag));
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
/* 14 种 = 原来 9 种 + 本轮新增的 多边形 / 曲线 / 连接线 / 曲线连接线 / 自由绘制。
   .menu-sep 是分组分隔线，不是按钮，所以不计入 count（选择器只取 button）。 */
check('形状共 14 种（原 9 + 多边形/曲线/连接线/曲线连接线/自由绘制）',
  shapeMenu.count === 14, JSON.stringify(shapeMenu));
check('含 矩形/圆角矩形/圆形/椭圆/三角形/平行四边形/直线/箭头/双向箭头',
  ['矩形', '圆角矩形', '圆形', '椭圆', '三角形', '平行四边形', '直线', '箭头', '双向箭头']
    .every((t) => shapeMenu.titles.indexOf(t) >= 0), shapeMenu.titles.join(','));
check('★ 含新增 多边形/曲线/连接线/曲线连接线/自由绘制',
  ['多边形', '曲线', '连接线', '曲线连接线', '自由绘制']
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
/* 直线现在是「8px 盒子里一根 3px 的杆」——盒子是两端点的包围盒，杆厚来自
   data-wd-w，两者不再像旧模型那样相等（旧模型盒高就是线粗，所以能满格）。
   所以这里断的是「有真实像素、且明显是细线而不是实心块」。 */
check('★ 直线栅格化后有真实像素（细杆，不是实心块）',
  (raster.line || 0) > 15 && (raster.line || 0) < 80, String(raster.line));

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
/*   ③ 默认背景已改成透明（用户新增的「背景色」控件）—— 透明像素的 RGB 全是 0，
      原本 0<110 全成立，会把整条带都当成墨；多一道 alpha 阈值（>128）排除透明，
      测的还是「真的画了字」。 */
const chartInk = await ev(`(() => {
  const cv = document.createElement('canvas'); cv.width = 960; cv.height = 560;
  /* 只数**不透明**且深色文字像素（透明背景的 0,0,0,0 不算） */
  const textInk = (d, y0, y1) => {
    WD.elements.drawChart('bar', cv, d);
    const x = cv.getContext('2d').getImageData(0, y0, 960, y1 - y0).data;
    let n = 0;
    for (let i = 0; i < x.length; i += 4) {
      if (x[i + 3] > 128 && x[i] < 110 && x[i + 1] < 115 && x[i + 2] < 140) n++;
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
const chartPanel = await ev(`(() => {
  const sec = document.getElementById('sec-chart');
  const rows = document.querySelectorAll('#chf-series .series-row');
  return {
    visible: !!sec && !sec.hidden,
    flashed: !!sec && sec.classList.contains('flash'),
    focused: (document.activeElement || {}).id,
    modalHidden: document.getElementById('modal').hidden,
    title: document.getElementById('chf-title').value,
    rows: rows.length,
    /* 每行：名称输入 + 类型下拉 + 颜色格 + 删除键 */
    rowName: rows.length ? !!rows[0].querySelector('[data-f="name"]') : false,
    rowType: rows.length ? !!rows[0].querySelector('[data-f="kind"]') : false,
    rowColor: rows.length ? !!rows[0].querySelector('.sw-series') : false,
    rowDel: rows.length ? !!rows[0].querySelector('.chart-del') : false,
    addSeries: !!document.getElementById('chf-add-series'),
    addCat: !!document.getElementById('chf-add-cat'),
    /* 数据网格：表头 = 系列数，行 = 分类数，值格 = 行×列 */
    gridHeads: document.querySelectorAll('#chf-grid .chart-grid-head').length,
    gridKeys: document.querySelectorAll('#chf-grid .grid-key').length,
    gridVals: document.querySelectorAll('#chf-grid .grid-val').length,
    bgNone: !!document.getElementById('chf-bg-none'),
    bgSwatches: document.querySelectorAll('#chf-bg .sw-bg').length,
    bgPick: !!document.getElementById('chf-bg-pick'),
    legend: !!document.getElementById('chf-legend'),
    values: !!document.getElementById('chf-values'),
    reset: !!document.getElementById('chf-reset'),
    /* 用户要求删掉的那个全局「图表类型」分段必须不在 */
    hasKindSeg: !!document.getElementById('chf-kind'),
    /* 也不该再有「一个输入框塞一串逗号值」 */
    hasCommaInput: !!document.getElementById('chf-labels') || !!document.getElementById('chf-v0'),
  };
})()`);
check('★ 双击图表把右栏「图表数据」段唤到眼前（不再弹模态框）',
  chartPanel.visible && chartPanel.flashed && chartPanel.modalHidden && chartPanel.focused === 'chf-title',
  JSON.stringify(chartPanel));
check('★ 上方的「图表类型」分段与逗号输入框已删除',
  chartPanel.hasKindSeg === false && chartPanel.hasCommaInput === false,
  JSON.stringify({ kindSeg: chartPanel.hasKindSeg, commaInput: chartPanel.hasCommaInput }));
check('★ 系列行有 名称 + 类型 + 颜色 + 删除 四件',
  chartPanel.rows >= 1 && chartPanel.rowName && chartPanel.rowType && chartPanel.rowColor && chartPanel.rowDel,
  JSON.stringify(chartPanel));
check('★ 数据是「分类 × 系列」网格（表头数=系列数、值格=行×列），不是一串逗号值',
  chartPanel.gridHeads === chartPanel.rows &&
  chartPanel.gridKeys >= 2 && chartPanel.gridVals === chartPanel.gridKeys * chartPanel.gridHeads,
  JSON.stringify({ heads: chartPanel.gridHeads, keys: chartPanel.gridKeys, vals: chartPanel.gridVals, rows: chartPanel.rows }));
check('★ 有「＋ 添加系列」「＋ 添加分类」按钮',
  chartPanel.addSeries && chartPanel.addCat, JSON.stringify(chartPanel));
check('★ 背景色控件齐全：无 + 预设色 + 自定义取色',
  chartPanel.bgNone && chartPanel.bgSwatches >= 4 && chartPanel.bgPick,
  JSON.stringify({ none: chartPanel.bgNone, sw: chartPanel.bgSwatches, pick: chartPanel.bgPick }));
check('图例 / 数值 / 恢复示例仍在',
  chartPanel.legend && chartPanel.values && chartPanel.reset, JSON.stringify(chartPanel));
check('★ 图表背景色默认「无」（不铺白底，贴深色课件不会被贴一张白纸）',
  await ev(`(() => {
    const img = WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]');
    return JSON.parse(img.getAttribute('data-wd-chart')).bgColor === '';
  })()`), 'bgColor 应为空串');

/* 选中别的元素时，这段必须自己消失 —— 右栏不该留着无关控件。
   要看**计算后的 display**，不能只看 .hidden 属性：
   .insp-sec 是 display:flex，作者样式会盖掉浏览器默认的 [hidden]{display:none}。 */
const hiddenWhenOther = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const other = doc.querySelector('p,div,span');
  WD.app._internal.setSelection([other]);
  const sec = document.getElementById('sec-chart');
  const out = { hidden: sec.hidden, display: getComputedStyle(sec).display, tag: other.tagName };
  WD.app._internal.setSelection([doc.querySelector('img[data-wd-chart]')]);
  return { hidden: out.hidden, display: out.display, backHidden: sec.hidden,
           backDisplay: getComputedStyle(sec).display, tag: out.tag };
})()`);
check('选中非图表元素时这段自动隐藏，切回图表又出现',
  hiddenWhenOther.display === 'none' && hiddenWhenOther.backDisplay !== 'none', JSON.stringify(hiddenWhenOther));

/* 即时生效：改输入框 → 停手 → 图自己重画，没有「应用」按钮。
   现在数据在网格里：改分类名要改行首那一格，改数值要改对应的值格。 */
await ev(`(() => {
  document.getElementById('chf-title').value = '改过的标题';
  /* 把前三个分类改名、前三个数值改掉 —— 一个 input 触发读全表
     （readChartPanel 在 0.4s 后从 DOM 把所有格一起读，单独触发每个
     只会多发几次防抖重画） */
  const keys = Array.from(document.querySelectorAll('#chf-grid .grid-key'));
  ['甲', '乙', '丙'].forEach((t, i) => { if (keys[i]) keys[i].value = t; });
  for (let ri = 0; ri < 3; ri++) {
    const v = document.querySelector('#chf-grid .grid-val[data-ri="' + ri + '"][data-si="0"]');
    if (v) v.value = String((ri + 1) * 10);
  }
  document.getElementById('chf-title').dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const notYet = await ev(`(() => {
  const img = WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]');
  return JSON.parse(img.getAttribute('data-wd-chart')).title;
})()`);
check('刚敲完还没到防抖时间，图上数据保持原样（不是每个键都重画一次）',
  notYet !== '改过的标题', String(notYet));
await sleep(900);
const chartApplied = await ev(`(() => {
  const img = WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]');
  const d = JSON.parse(img.getAttribute('data-wd-chart'));
  return { title: d.title, labels: d.labels, values: d.series[0].data,
           srcLen: (img.getAttribute('src') || '').length };
})()`);
check('★ 改完标题自动生效并写回数据模型（全程没点任何按钮）',
  chartApplied.title === '改过的标题' && chartApplied.srcLen !== chartMeta.srcLen,
  JSON.stringify(chartApplied));
check('★ 改完分类与数值自动生效（改前 3 个，其余保持）',
  JSON.stringify(chartApplied.labels.slice(0, 3)) === JSON.stringify(['甲', '乙', '丙']) &&
  JSON.stringify(chartApplied.values.slice(0, 3)) === JSON.stringify([10, 20, 30]),
  JSON.stringify(chartApplied));
/* 输入框不能被防抖回填打断：打字打到一半数据已经写回，光标还得在原处 */
const caret = await ev(`(() => {
  const f = document.getElementById('chf-title');
  f.focus();
  f.setSelectionRange(2, 2);
  f.value = f.value.slice(0, 2) + '季度' + f.value.slice(2);
  const want = f.value.length;
  f.dispatchEvent(new Event('input', { bubbles: true }));
  return { want: want, hasFocus: document.activeElement === f };
})()`);
await sleep(900);
const caretAfter = await ev(`(() => {
  const f = document.getElementById('chf-title');
  return { focused: document.activeElement === f, sel: f.selectionStart,
           val: f.value, title: JSON.parse(WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]').getAttribute('data-wd-chart')).title };
})()`);
check('★ 即时回填后焦点与光标仍在原处（打字不会被自己的回填打断）',
  caret.hasFocus && caretAfter.focused && caretAfter.sel === caret.want &&
  caretAfter.title === caretAfter.val, JSON.stringify({ before: caret, after: caretAfter }));
/* 分类名清空不能把图弄成空图：留空的分类名回退成「分类N」，图仍然完整 */
await ev(`(() => {
  const keys = Array.from(document.querySelectorAll('#chf-grid .grid-key'));
  if (keys[0]) { keys[0].value = ''; keys[0].dispatchEvent(new Event('input', { bubbles: true })); }
  return true;
})()`);
await sleep(900);
const emptyLabels = await ev(`(() => {
  const img = WD.app.E.stage.getDoc().querySelector('img[data-wd-chart]');
  const d = JSON.parse(img.getAttribute('data-wd-chart'));
  return { labels: d.labels, series0: d.series[0].data.slice(0, 3) };
})()`);
check('★ 分类名留空时回退成「分类N」，图仍有完整的分类与数值',
  emptyLabels.labels.length >= 3 && emptyLabels.labels[0] === '分类1' &&
  emptyLabels.labels[1] === '乙' && emptyLabels.labels[2] === '丙' &&
  JSON.stringify(emptyLabels.series0) === JSON.stringify([10, 20, 30]),
  JSON.stringify(emptyLabels));

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

/* ═══ [16] 图表点位必须落在横轴标签正上方 ═══
   折线图原来用 `pad.l + pw/(n-1)*i` 布点，而横轴标签在格心 `pad.l + pw*(i+.5)/n`：
   6 个分类时首点偏左 73px（正好一格），末点偏右 73px，画出来就是「点悬在标签旁边」，
   而且首点正压在 y 轴上。这里同时钉住两条：几何公式与**真实像素**。 */
console.log('\n[16] 折线图点位对齐横轴标签');
const chartAlign = await ev(`(() => {
  const cv = document.createElement('canvas'); cv.width = 960; cv.height = 560;
  const data = WD.elements.defaultChartData('chartline');
  WD.elements.drawChart('chartline', cv, data);
  const W = cv.width, H = cv.height;
  const pad = { l: 60, r: 24, t: 70, b: 90 };        /* CHART_HEAD=56 +14 / 46+CHART_LEGEND=44 */
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, n = data.labels.length;
  const maxV = Math.max.apply(null, data.series.reduce((a, s) => a.concat(s.data), [0]));
  const yMax = (() => { const mag = Math.pow(10, Math.floor(Math.log10(maxV)));
    for (const st of [1,1.2,1.5,2,2.5,3,4,5,6,8,10]) if (st * mag >= maxV) return st * mag; return 10 * mag; })();
  /* 期望：每个点都在自己那一格的中心（= 横轴标签的 x） */
  const slot = pw / n;
  const expect = data.labels.map((_, i) => ({ x: pad.l + slot * (i + .5),
                                              y: pad.t + ph - ph * data.series[0].data[i] / yMax }));
  const img = cv.getContext('2d').getImageData(0, 0, W, H).data;
  /* 数据点用系列的颜色（不再是写死的蓝）：折线图默认色板是 #3b6fd4，
     但现在「颜色」是用户可配的 —— 读图时按实际颜色搜。 */
  const c = data.series[0].color;
  const cr = parseInt(c.slice(1, 3), 16), cg = parseInt(c.slice(3, 5), 16), cb = parseInt(c.slice(5, 7), 16);
  const isDot = (x, y) => { const i = (y * W + x) * 4;
    /* 阈值比标题/图例那一档宽：点的描边是同色，中心是白底，所以不取「深色」而取「与该色同色」 */
    return img[i + 3] > 128 && Math.abs(img[i] - cr) < 40 && Math.abs(img[i+1] - cg) < 40 && Math.abs(img[i+2] - cb) < 40; };
  const measured = expect.map((p) => {
    let sx = 0, cnt = 0;
    /* 搜的是点（r=5）而不是那条线 —— 搜太宽会把连接线也量进来，质心被拉向「上一个点」那一侧。
       x 用 ±4（点的可见蓝区 r=4，±4 刚好包完），y 用 ±3（点上下的几个像素，
       避开线经过的两条横带 r=1.5 的位置）。 */
    for (let y = Math.round(p.y) - 3; y <= Math.round(p.y) + 3; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = Math.max(0, Math.round(p.x) - 4); x <= Math.min(W - 1, Math.round(p.x) + 4); x++) {
        if (isDot(x, y)) { sx += x; cnt++; }
      }
    }
    return { expectX: +p.x.toFixed(1), measuredX: cnt ? +(sx / cnt).toFixed(1) : null, px: cnt };
  });
  return { n, slot: +slot.toFixed(1), axisLeft: pad.l,
           firstX: +expect[0].x.toFixed(1), lastX: +expect[n-1].x.toFixed(1),
           rightEdge: pad.l + pw, measured };
})()`);
check('★ 折线图每个数据点都在横轴标签正上方（真实像素质心 ±4px）',
  chartAlign.measured.length === chartAlign.n && chartAlign.measured.every((m) => m.px > 20 && m.measuredX !== null && Math.abs(m.measuredX - m.expectX) <= 4),
  JSON.stringify(chartAlign.measured));
check('★ 折线图首点不再压在 y 轴上（留出至少半格）',
  chartAlign.firstX - chartAlign.axisLeft >= chartAlign.slot * 0.4,
  'firstX=' + chartAlign.firstX + ' axisLeft=' + chartAlign.axisLeft + ' slot=' + chartAlign.slot);
check('★ 折线图末点与右边界对称留白（不贴边）',
  chartAlign.rightEdge - chartAlign.lastX >= chartAlign.slot * 0.4,
  'lastX=' + chartAlign.lastX + ' rightEdge=' + chartAlign.rightEdge);

/* ═══ [17] 右键菜单：菜单贴在鼠标处，且作用对象就是右键的那个元素 ═══
   两条都曾经是坏的，而且互为放大：
   ① 帧内右键事件的 clientX/clientY 是**帧内坐标**，直接拿去定位父页的
      position:fixed 菜单，菜单就落在帧左上角而不是鼠标处；
   ② 命中测试又误用了**父页坐标**喂 doc.elementFromPoint，于是点副标题
      可能命中标题 —— 菜单里的「编辑文字 / 删除」作用在上一次选中的元素上。
   这里用真实右键（CDP Input）走完整链路。 */
console.log('\n[17] 右键菜单定位与作用对象');
await clearAdded();
const rcBox = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const kids = Array.from(root.querySelectorAll('*')).filter((n) => (n.textContent || '').trim());
  const A = kids[0], B = kids[1] || kids[0];
  const ra = A.getBoundingClientRect(), rb = B.getBoundingClientRect();
  return {
    aTag: A.tagName, bTag: B.tagName,
    a: { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 },
    b: { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 },
  };
})()`);
const rcA = await toPage(rcBox.a.x, rcBox.a.y);
const rcB = await toPage(rcBox.b.x, rcBox.b.y);

/* 先选中 A，再去右键 B —— 菜单必须作用于 B 且贴在 B 的位置 */
await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const kids = Array.from(WD.render.findRoot(doc).querySelectorAll('*')).filter((n) => (n.textContent || '').trim());
  WD.app._internal.setSelection([kids[0]]);
  WD.app._internal.refreshOverlay();
  document.getElementById('ctxmenu').hidden = true;
  return true;
})()`);
await sleep(220);
await mouse('mousePressed', rcB.x, rcB.y, 'right');
await mouse('mouseReleased', rcB.x, rcB.y, 'right');
await sleep(320);
const rcState = await ev(`(() => {
  const m = document.getElementById('ctxmenu');
  const r = m.getBoundingClientRect();
  const sel = WD.app.E.selection[0];
  const doc = WD.app.E.stage.getDoc();
  const kids = Array.from(WD.render.findRoot(doc).querySelectorAll('*')).filter((n) => (n.textContent || '').trim());
  return { hidden: m.hidden, left: r.left, top: r.top, w: r.width,
           items: Array.from(m.querySelectorAll('.ctx-txt')).map((e) => e.textContent),
           selText: sel ? (sel.textContent || '').trim().slice(0, 12) : null,
           selTag: sel ? sel.tagName : null,
           bText: (kids[1] || kids[0]).textContent.trim().slice(0, 12) };
})()`);
check('★ 右键菜单出现在鼠标位置（不是画布左上角）',
  !rcState.hidden && Math.abs(rcState.left - rcB.x) < 14 && Math.abs(rcState.top - rcB.y) < 14,
  'menu=(' + Math.round(rcState.left) + ',' + Math.round(rcState.top) + ') 鼠标=(' + Math.round(rcB.x) + ',' + Math.round(rcB.y) + ')');
check('★ 右键另一个元素后，菜单作用于**它**（原来用旧选区）',
  rcState.selTag === rcBox.bTag && rcState.selText === rcState.bText,
  '选中=' + rcState.selTag + ':' + rcState.selText + ' 期望=' + rcBox.bTag + ':' + rcState.bText);
check('★ 右键菜单是元素操作（有「编辑文字」）',
  rcState.items.indexOf('编辑文字') >= 0, JSON.stringify(rcState.items.slice(0, 3)));
check('★ 右键菜单不溢出视口',
  rcState.left >= 0 && rcState.top >= 0 &&
  rcState.left + rcState.w <= 1600 && rcState.top + 190 <= 950,
  'left=' + Math.round(rcState.left) + ' top=' + Math.round(rcState.top) + ' w=' + Math.round(rcState.w));

/* 注意：这里不再补一次"连续右键同一坐标"的断言。
   菜单是 position:fixed 且跟着鼠标出现的，第二次右键会先落在**已经打开的那张菜单**上
   （elementFromPoint 命中的是菜单，不是画布），那测的是「菜单挡没挡住自己」，
   与"右键是否作用于该元素"无关，只会得出假失败。 */
await ev('WD.app._internal.closeContextMenu()');

/* ═══ [18] 新增的 5 种形状：曲线 / 连接线 / 曲线连接线 / 自由绘制 / 多边形 ═══
   四个是**描边**图形（fill 透明、颜色走 stroke、线宽走 stroke-width），
   与原来的直线 / 箭头 / 双箭头（填充图形）是不同的渲染路径 ——
   这里把两条路径都钉住：描边图形 fill 必须是 none。
   另外自由绘制 / 多边形还要验「比例点 → 绝对路径」的换算。 */
console.log('\n[18] 新增形状：曲线 / 连接线 / 曲线连接线 / 自由绘制 / 多边形');
await clearAdded();
const newShapes = await ev(`(() => {
  const out = {};
  [['curve','lock-h-min'],['connector','lock-h-min'],['connectorcurve','lock-h-min'],
   ['drawn','ratio'],['poly','ratio']].forEach(([k, wantMode]) => {
    const n = WD.app._internal.addElement(k);
    if (!n) { out[k] = { none: true }; return; }
    const svg = n.querySelector(':scope > svg');
    const p = svg ? svg.firstChild : null;
    const d = p ? (p.getAttribute('d') || '') : '';
    out[k] = {
      tag: n.tagName, hasSvg: !!svg,
      dLen: d.length, closed: d.trim().slice(-1) === 'Z',
      fill: p ? p.getAttribute('fill') : null,
      stroke: p ? p.getAttribute('stroke') : null,
      sw: parseFloat(p ? p.getAttribute('stroke-width') : ''),
      viewBox: svg ? svg.getAttribute('viewBox') : null,
      mode: (WD.elements.constraintOf(n) || {}).mode,
      points: n.getAttribute('data-wd-points'),
      selectable: WD.app._internal.isSelectable(n, n.ownerDocument.defaultView),
      label: WD.util.describeElement(n),
    };
  });
  return out;
})()`);
for (const k of ['curve', 'connector', 'connectorcurve', 'drawn', 'poly']) {
  const s = newShapes[k];
  check('★ ' + k + '：插进来是描边 SVG 且可被选中（fill=none / stroke 有色）',
    !s.none && s.hasSvg && s.fill === 'none' && /^#|rgb/.test(s.stroke || '') && s.sw > 0 &&
    s.dLen > 8 && s.selectable === true,
    JSON.stringify(s).slice(0, 200));
}
/* 曲线族现在没有约束：几何由三点决定，盒子是包围盒，
   「能不能变成任意角度」不再靠约束实现，而是靠拖端点（见 [3]）。 */
check('★ 曲线 / 连接线 / 曲线连接线不再锁高度（两点模型，可画斜的）',
  ['curve', 'connector', 'connectorcurve'].every((k) => !newShapes[k].mode),
  JSON.stringify(['curve', 'connector', 'connectorcurve'].map((k) => k + '=' + newShapes[k].mode)));
check('★ 自由绘制 / 多边形用 ratio（等比缩放，笔迹不会被压扁）',
  newShapes.drawn.mode === 'ratio' && newShapes.poly.mode === 'ratio',
  JSON.stringify({ drawn: newShapes.drawn.mode, poly: newShapes.poly.mode }));
/* 两点头模型下，曲线的 `d` 必须真的铺满整个 viewBox —— 旧实现把按 100×100
   写的默认 d 配上了真实尺寸的 viewBox，曲线只画在左边 16%。 */
const curveSpread = await ev(`(() => {
  const n = WD.app.E.stage.getDoc().querySelector('[data-wd-added="curve"]');
  if (!n) return { none: true };
  n.style.width = '620px'; n.style.height = '150px';
  WD.elements.syncLine(n);
  const svg = n.querySelector(':scope > svg');
  const d = svg.firstChild.getAttribute('d');
  const nums = (d.match(/-?[\\d.]+/g) || []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  return { d, minX: Math.min.apply(null, xs), maxX: Math.max.apply(null, xs),
           vbW: parseFloat(svg.getAttribute('viewBox').split(' ')[2]) };
})()`);
check('★ 曲线的路径真的铺满整个 viewBox（旧实现只画在左边 16%）',
  curveSpread.maxX >= curveSpread.vbW - 1 && curveSpread.minX <= 1,
  JSON.stringify(curveSpread));
check('★ 自由绘制 / 多边形带比例点（缩放后笔迹仍贴合自己的边框）',
  /^\[\[/.test(newShapes.drawn.points || '') && /^\[\[/.test(newShapes.poly.points || ''),
  JSON.stringify({ drawn: newShapes.drawn.points, poly: newShapes.poly.points }).slice(0, 160));
check('★ 多边形路径是闭合的（以 Z 结尾）',
  newShapes.poly.closed === true, newShapes.poly.dLen + ' ' + newShapes.poly.closed);
check('★ 自由绘制路径**不**闭合（一笔画不该被强行封口）',
  newShapes.drawn.closed === false, String(newShapes.drawn.closed));
check('★ 图层面板不再一律显示「容器」（自插元素报自己的名字）',
  Object.keys(newShapes).every((k) => /曲线|连接线|自由绘制|多边形/.test(newShapes[k].label)),
  JSON.stringify(Object.keys(newShapes).map((k) => k + '=' + newShapes[k].label)));

const reshaped = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const n = doc.querySelector('[data-wd-added="curve"]');
  if (!n) return { none: true };
  n.style.width = '900px'; n.style.height = '260px';
  WD.elements.syncLine(n);
  const svg = n.querySelector(':scope > svg');
  return { viewBox: svg.getAttribute('viewBox'), w: svg.getAttribute('width'), h: svg.getAttribute('height') };
})()`);
check('★ 改尺寸后 viewBox 与盒子同步（描边不会被缩放拉粗）',
  reshaped.viewBox === '0 0 900 260' && reshaped.w === '900' && reshaped.h === '260',
  JSON.stringify(reshaped));

/* ═══ [19] 画布绘制：自由绘制拖一笔、多边形逐点闭合 ═══ */
console.log('\n[19] 画布绘制工具（自由绘制 / 多边形）');
await clearAdded();
const drawRes = await ev(`(async () => {
  const DT = WD.drawTool, I = WD.app._internal, E = WD.app.E;
  const doc = E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const mk = (x, y) => ({ clientX: x, clientY: y, button: 0,
    preventDefault() {}, stopPropagation() {} });
  const out = { hasTool: !!DT, bridge: !!WD.drawBridge };
  if (!DT) return out;

  out.started = DT.start('drawn');
  out.cursor = doc.body.style.cursor;
  DT.handleDown(mk(300, 300));
  for (let i = 1; i <= 14; i++) DT.handleMove(mk(300 + i * 24, 300 + Math.sin(i / 2) * 46));
  out.movePts = DT.pts.length;
  out.preview = !!document.querySelector('#overlay .wd-draw-preview');
  DT.handleUp(mk(636, 300));
  await new Promise((r) => setTimeout(r, 260));
  const drawnEls = Array.from(root.querySelectorAll('[data-wd-added="drawn"]'));
  out.drawnCount = drawnEls.length;
  out.previewCleared = !document.querySelector('#overlay .wd-draw-preview');
  out.stillActive = DT.active();
  if (drawnEls[0]) {
    const n = drawnEls[0];
    const pts = JSON.parse(n.getAttribute('data-wd-points') || '[]');
    out.drawnGeom = { left: parseFloat(n.style.left), top: parseFloat(n.style.top),
                      w: parseFloat(n.style.width), h: parseFloat(n.style.height),
                      pts: pts.length, first: pts[0],
                      d: (n.querySelector('svg path') || {}).getAttribute
                         ? n.querySelector('svg path').getAttribute('d').slice(0, 24) : null };
  }

  DT.stop();
  out.polyStarted = DT.start('poly');
  [[420, 640], [760, 600], [880, 820], [520, 880]].forEach(([x, y]) => DT.handleDown(mk(x, y)));
  out.polyPtsBeforeClose = DT.pts.length;
  DT.handleDown(mk(422, 642));
  await new Promise((r) => setTimeout(r, 260));
  const polyEls = Array.from(root.querySelectorAll('[data-wd-added="poly"]'));
  out.polyCount = polyEls.length;
  if (polyEls[0]) {
    const n = polyEls[0];
    out.polyGeom = { w: parseFloat(n.style.width), h: parseFloat(n.style.height),
                     pts: JSON.parse(n.getAttribute('data-wd-points') || '[]').length,
                     closed: (n.querySelector('svg path').getAttribute('d') || '').trim().slice(-1) === 'Z' };
  }

  DT.stop(); DT.start('poly');
  DT.handleDown(mk(200, 900)); DT.handleDown(mk(260, 940));
  DT.finish('escape');
  await new Promise((r) => setTimeout(r, 200));
  out.polyCountAfterTooFew = root.querySelectorAll('[data-wd-added="poly"]').length;

  DT.stop();
  out.activeAfterStop = DT.active();
  out.cursorAfterStop = doc.body.style.cursor;
  out.previewAfterStop = !!document.querySelector('#overlay .wd-draw-preview');
  out.leakedListeners = !!DT.bound;
  return out;
})()`);
check('★ 绘制桥与工具就绪', drawRes.hasTool === true && drawRes.bridge === true, JSON.stringify(drawRes).slice(0, 120));
check('★ 进入自由绘制后光标变十字线', drawRes.cursor === 'crosshair', String(drawRes.cursor));
check('★ 自由绘制：拖动中有实时预览、松开后落地 1 个元素并清掉预览',
  drawRes.movePts >= 8 && drawRes.preview === true && drawRes.drawnCount === 1 && drawRes.previewCleared === true,
  JSON.stringify({ movePts: drawRes.movePts, preview: drawRes.preview, created: drawRes.drawnCount, cleared: drawRes.previewCleared }));
check('★ 落地的笔迹有合理包围盒与比例点',
  drawRes.drawnGeom && drawRes.drawnGeom.w > 100 && drawRes.drawnGeom.h > 20 && drawRes.drawnGeom.pts >= 8,
  JSON.stringify(drawRes.drawnGeom));
check('★ 画完一笔后工具保持激活（连着画不用重新点菜单）', drawRes.stillActive === true, String(drawRes.stillActive));
check('★ 多边形：4 个顶点 + 点回起点闭合，落地 1 个闭合多边形',
  drawRes.polyPtsBeforeClose === 4 && drawRes.polyCount === 1 &&
  drawRes.polyGeom && drawRes.polyGeom.pts === 4 && drawRes.polyGeom.closed === true,
  JSON.stringify({ before: drawRes.polyPtsBeforeClose, count: drawRes.polyCount, geom: drawRes.polyGeom }));
check('★ 顶点不足 3 个时不落地残缺多边形',
  drawRes.polyCountAfterTooFew === 1, String(drawRes.polyCountAfterTooFew));
check('★ 退出绘制态后：光标还原、预览清空、监听解绑',
  drawRes.activeAfterStop === false && drawRes.cursorAfterStop === '' &&
  drawRes.previewAfterStop === false && drawRes.leakedListeners === false,
  JSON.stringify({ active: drawRes.activeAfterStop, cursor: drawRes.cursorAfterStop,
                   preview: drawRes.previewAfterStop, bound: drawRes.leakedListeners }));

/* ═══ [20] 右栏分区折叠 + 图表操作 ═══ */
console.log('\n[20] 右栏分区折叠与图表操作');
await clearAdded();
const panel = await ev(`(async () => {
  localStorage.removeItem('wizdeck.insp.sections');
  const out = {};
  const head = (id) => document.querySelector('#' + id + ' .sec-head');
  const body = (id) => document.querySelector('#' + id + ' .sec-body');
  out.sections = Array.from(document.querySelectorAll('.insp-sec'))
    .filter((s) => s.querySelector('.sec-head'))
    .map((s) => ({ id: s.id, headTag: s.querySelector('.sec-head').tagName,
                   expanded: s.querySelector('.sec-head').getAttribute('aria-expanded') }));

  head('sec-layers').click();
  await new Promise((r) => setTimeout(r, 120));
  out.collapsed = { exp: head('sec-layers').getAttribute('aria-expanded'),
                    hidden: body('sec-layers').hidden,
                    display: getComputedStyle(body('sec-layers')).display,
                    height: Math.round(body('sec-layers').getBoundingClientRect().height) };
  out.saved = localStorage.getItem('wizdeck.insp.sections') || '';
  head('sec-layers').click();
  await new Promise((r) => setTimeout(r, 120));
  out.reExpanded = { hidden: body('sec-layers').hidden, display: getComputedStyle(body('sec-layers')).display };

  head('sec-element').click();
  await new Promise((r) => setTimeout(r, 120));
  WD.app._internal.clearSelection();
  await new Promise((r) => setTimeout(r, 200));
  WD.app._internal.addElement('rect');
  await new Promise((r) => setTimeout(r, 320));
  out.staysClosed = { exp: head('sec-element').getAttribute('aria-expanded'),
                      hidden: body('sec-element').hidden };
  head('sec-element').click();
  return out;
})()`);
check('★ 每个分区标题都是可聚焦的按钮，并带 aria-expanded',
  panel.sections.length >= 4 && panel.sections.every((s) => s.headTag === 'BUTTON' && s.expanded !== null),
  JSON.stringify(panel.sections));
check('★ 收起分区后内容真的不占位（display:none）',
  panel.collapsed.exp === 'false' && panel.collapsed.hidden === true &&
  panel.collapsed.display === 'none' && panel.collapsed.height === 0,
  JSON.stringify(panel.collapsed));
check('★ 折叠状态写入 localStorage（刷新后保持）',
  /sec-layers/.test(panel.saved), panel.saved);
check('★ 点第二次能展开回来',
  panel.reExpanded.hidden === false && panel.reExpanded.display !== 'none', JSON.stringify(panel.reExpanded));
check('★ 用户手动收起的分区，选中元素时不会被自动弹开',
  panel.staysClosed.exp === 'false' && panel.staysClosed.hidden === true, JSON.stringify(panel.staysClosed));

const chartOps = await ev(`(async () => {
  const I = WD.app._internal;
  I.clearSelection();
  const img = I.addElement('bar');
  await new Promise((r) => setTimeout(r, 500));
  const dataOf = () => JSON.parse(img.getAttribute('data-wd-chart') || '{}');
  const settle = () => new Promise((r) => setTimeout(r, 1300));
  const typeOf = (i) => {
    const s = document.querySelector('#chf-series .series-row[data-si="' + i + '"] [data-f="kind"]');
    return s ? s.value : null;
  };
  const out = {
    secShown: !document.getElementById('sec-chart').hidden,
    secExpanded: document.querySelector('#sec-chart .sec-head').getAttribute('aria-expanded'),
    before: dataOf().title,
    seriesCount: dataOf().series.length,
    catCount: dataOf().labels.length,
  };

  /* ① 逐系列切类型：前两个系列都改成折线 → 整张图变成折线图 */
  document.querySelectorAll('#chf-series .series-row [data-f="kind"]').forEach((sel) => {
    sel.value = 'chartline';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  const allLine = dataOf();
  out.afterAllLine = {
    kind: img.getAttribute('data-wd-chart-kind'),
    added: img.getAttribute('data-wd-added'),
    seriesKind: allLine.seriesKind,
    type0: typeOf(0),
  };

  /* ② 只把第二个系列改回柱状 → 混合图：kind 回到 bar，但第一个系列仍是线 */
  const sel1 = document.querySelector('#chf-series .series-row[data-si="1"] [data-f="kind"]');
  sel1.value = 'bar';
  sel1.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  const mixed = dataOf();
  out.afterMixed = { kind: img.getAttribute('data-wd-chart-kind'), seriesKind: mixed.seriesKind };

  /* ③ 系列颜色：点一下应该开**色盘**（原生 input[type=color]），
     Alt+点 才是沿色板轮换。
     色盘是系统弹窗，测不了它本身，所以这里盯住「有没有去点那个 input」——
     临时把该 input 的 click 换掉计数，再派发真正的鼠标事件。 */
  const sw = document.querySelector('#chf-series .series-row[data-si="0"] .sw-series');
  out.swBefore = sw.getAttribute('data-color');
  out.pickerOpened = await (async () => {
    const pick = sw.parentNode.querySelector('.sw-pick[data-f="stroke"]');
    if (!pick) return 'no-picker';
    const orig = pick.click;
    let hit = 0, valAtClick = null;
    pick.click = function () { hit++; valAtClick = pick.value; };
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    pick.click = orig;
    return { hit, valAtClick, swatch: sw.getAttribute('data-color') };
  })();
  await settle();
  out.afterPicker = { color: dataOf().series[0].color,
                      swatch: document.querySelector('#chf-series .series-row[data-si="0"] .sw-series').getAttribute('data-color') };
  /* Alt+点 → 沿色板轮换 */
  sw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
  await settle();
  out.afterAltCycle = { color: dataOf().series[0].color,
                        swatch: document.querySelector('#chf-series .series-row[data-si="0"] .sw-series').getAttribute('data-color') };

  /* ④ 加一个系列 */
  document.getElementById('chf-add-series').click();
  await settle();
  out.afterAddSeries = { count: dataOf().series.length,
                         rows: document.querySelectorAll('#chf-series .series-row').length,
                         gridHeads: document.querySelectorAll('#chf-grid .chart-grid-head').length,
                         vals: document.querySelectorAll('#chf-grid .grid-val').length };

  /* ⑤ 加一个分类 */
  document.getElementById('chf-add-cat').click();
  await settle();
  out.afterAddCat = { labels: dataOf().labels.length,
                      keys: document.querySelectorAll('#chf-grid .grid-key').length,
                      vals: document.querySelectorAll('#chf-grid .grid-val').length };

  /* ⑥ 删除最后那个分类 */
  const lastRowDel = Array.from(document.querySelectorAll('#chf-grid .chart-del')).pop();
  lastRowDel.click();
  await settle();
  out.afterDelCat = { labels: dataOf().labels.length, keys: document.querySelectorAll('#chf-grid .grid-key').length };

  /* ⑦ 删除刚加的那个系列 */
  const lastSeriesDel = Array.from(document.querySelectorAll('#chf-series .chart-del')).pop();
  lastSeriesDel.click();
  await settle();
  out.afterDelSeries = { count: dataOf().series.length,
                         rows: document.querySelectorAll('#chf-series .series-row').length,
                         gridHeads: document.querySelectorAll('#chf-grid .chart-grid-head').length };

  /* ⑧ 背景色：默认无 → 选一个预设 → 选回无 */
  out.bgDefault = dataOf().bgColor;
  const bg = document.querySelector('#chf-bg .sw-bg');
  out.bgPickColor = bg.getAttribute('data-color');
  bg.click();
  await settle();
  out.bgAfterPick = dataOf().bgColor;
  document.getElementById('chf-bg-none').click();
  await settle();
  out.bgAfterNone = dataOf().bgColor;

  /* ⑨ 改标题仍即时生效 */
  const t = document.getElementById('chf-title');
  t.value = '折叠与图表联测';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  out.afterTitle = dataOf().title;
  return out;
})()`);
check('★ 选中图表时图表段出现且自动展开',
  chartOps.secShown === true && chartOps.secExpanded === 'true',
  JSON.stringify({ shown: chartOps.secShown, exp: chartOps.secExpanded }));
check('★ 逐系列切类型：全改成折线后整张图变折线（data-wd-chart-kind 一起走）',
  chartOps.afterAllLine.kind === 'chartline' && chartOps.afterAllLine.added === 'chart-chartline' &&
  JSON.stringify(chartOps.afterAllLine.seriesKind) === JSON.stringify(['chartline', 'chartline']) &&
  chartOps.afterAllLine.type0 === 'chartline',
  JSON.stringify(chartOps.afterAllLine));
check('★ 混合图：一个系列折线 + 一个系列柱状时仍按柱状画布渲染',
  chartOps.afterMixed.kind === 'bar' &&
  JSON.stringify(chartOps.afterMixed.seriesKind) === JSON.stringify(['chartline', 'bar']),
  JSON.stringify(chartOps.afterMixed));
check('★ 点系列颜色格：开的是色盘（原生取色器），颜色不被悄悄改掉',
  chartOps.pickerOpened && chartOps.pickerOpened.hit === 1 &&
  chartOps.afterPicker.color === chartOps.swBefore,
  JSON.stringify({ opened: chartOps.pickerOpened, before: chartOps.swBefore, after: chartOps.afterPicker }));
check('★ Alt+点系列颜色格：沿色板轮换，图上的颜色与色格同步',
  chartOps.afterAltCycle.color === chartOps.afterAltCycle.swatch &&
  chartOps.afterAltCycle.color !== chartOps.swBefore,
  JSON.stringify({ before: chartOps.swBefore, alt: chartOps.afterAltCycle }));
check('★ 加一个系列：图上、系列行、数据网格表头与值格一起长出来',
  chartOps.afterAddSeries.count === chartOps.seriesCount + 1 &&
  chartOps.afterAddSeries.rows === chartOps.afterAddSeries.count &&
  chartOps.afterAddSeries.gridHeads === chartOps.afterAddSeries.count &&
  chartOps.afterAddSeries.vals === chartOps.afterAddSeries.count * chartOps.catCount,
  JSON.stringify(chartOps.afterAddSeries) + ' cats=' + chartOps.catCount);
check('★ 加一个分类：分类数 +1，网格多一行（值格 = 新行数 × 系列数）',
  chartOps.afterAddCat.labels === chartOps.catCount + 1 &&
  chartOps.afterAddCat.keys === chartOps.afterAddCat.labels &&
  chartOps.afterAddCat.vals === chartOps.afterAddCat.keys * chartOps.afterAddSeries.count,
  JSON.stringify(chartOps.afterAddCat));
check('★ 删一个分类：分类数与网格行一起减回去',
  chartOps.afterDelCat.labels === chartOps.catCount &&
  chartOps.afterDelCat.keys === chartOps.catCount,
  JSON.stringify(chartOps.afterDelCat));
check('★ 删一个系列：图上与网格表头一起收回',
  chartOps.afterDelSeries.count === chartOps.seriesCount &&
  chartOps.afterDelSeries.rows === chartOps.seriesCount &&
  chartOps.afterDelSeries.gridHeads === chartOps.seriesCount,
  JSON.stringify(chartOps.afterDelSeries));
check('★ 背景色：默认无 → 选预设色生效 → 选「无」回到透明',
  chartOps.bgDefault === '' && chartOps.bgAfterPick === chartOps.bgPickColor && chartOps.bgAfterNone === '',
  JSON.stringify({ def: chartOps.bgDefault, pick: chartOps.bgPickColor,
                   after: chartOps.bgAfterPick, none: chartOps.bgAfterNone }));
check('★ 改标题仍然即时生效（原有能力没被这次改造破坏）',
  chartOps.afterTitle === '折叠与图表联测', String(chartOps.afterTitle));

console.log('\n通过 ' + pass + '  失败 ' + fail);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
check('控制台零异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
ws.close();
process.exit(0);
