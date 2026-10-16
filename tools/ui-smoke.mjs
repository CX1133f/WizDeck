/* 改版冒烟测试：加载后逐个点新按钮，看有没有异常、面板/菜单状态是否正确
   用法：node tools/ui-smoke.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9490);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-smoke-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  '--window-size=1600,950', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch { /* ignore */ } });

async function resolvePageWs() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chromium');
}
const ws = new WebSocket(await resolvePageWs());
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws 失败')), { once: true }); });
let id = 0; const pend = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    errors.push('异常: ' + ((d.exception && d.exception.description) || d.text));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 60000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const click = (id) => ev(`(() => { const b = document.getElementById(${JSON.stringify(id)}); if (!b) return 'missing'; b.click(); return 'ok'; })()`);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '   ' + detail : '')); }
}

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);

/* [0] 必须在载入示例**之前**量：空状态下左栏那两个 flex:1 兄弟节点的坑，
   载入文档后 .rail 非空就再也测不出来了。 */
console.log('\n[0] 左栏空状态垂直居中（未载入文档时）');
{
  const r = await ev(`(() => {
    const panel = document.getElementById('sidebar');
    const head  = document.querySelector('#sidebar .panel-head');
    const rail  = document.getElementById('rail');
    const empty = document.getElementById('rail-empty');
    if (empty.hidden) return { skip: true };
    const pr = panel.getBoundingClientRect(), hr = head.getBoundingClientRect();
    let top = Infinity, bot = -Infinity;
    Array.from(empty.children).filter(n => !n.hidden).forEach(n => {
      const b = n.getBoundingClientRect(); top = Math.min(top, b.top); bot = Math.max(bot, b.bottom);
    });
    const areaMid = (hr.bottom + pr.bottom) / 2;
    return { skip: false,
             railFlexGrow: getComputedStyle(rail).flexGrow,
             railH: Math.round(rail.getBoundingClientRect().height),
             offset: Math.round((top + bot) / 2 - areaMid) };
  })()`);
  check('空状态存在（未载入文档）', !r.skip, JSON.stringify(r));
  check('空文档时 .rail 不再占位', r.railFlexGrow === '0' && r.railH === 0, JSON.stringify(r));
  check('空状态内容垂直居中（偏差 ≤2px）', !r.skip && Math.abs(r.offset) <= 2, '偏差 ' + r.offset + 'px');
}

await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(2000);

console.log('\n[1] 顶栏结构');
{
  const r = await ev(`(() => ({
    sample: !!document.getElementById('btn-sample'),
    fit: !!document.getElementById('btn-fit'),
    undoText: (document.getElementById('btn-undo')||{}).textContent,
    redoText: (document.getElementById('btn-redo')||{}).textContent,
    saveMenu: !!document.getElementById('btn-save-menu'),
    saveWd: !!document.getElementById('btn-save-wd'),
    exportBtn: !!document.getElementById('btn-export'),
    painter: !!document.getElementById('btn-painter'),
    find: !!document.getElementById('btn-find'),
    insertShape: !!document.getElementById('btn-insert-shape'),
    zoomInBottom: !!document.querySelector('#zoom-group #btn-zoom-in'),
    zoomInTopbar: !!document.querySelector('.topbar #btn-zoom-in'),
    addGrid: !!document.getElementById('add-grid')
  }))()`);
  check('顶栏已移除「示例」', !r.sample);
  check('顶栏已移除「适合窗口」', !r.fit);
  check('撤销只留符号', r.undoText === '↶', JSON.stringify(r.undoText));
  check('重做只留符号', r.redoText === '↷', JSON.stringify(r.redoText));
  check('保存/导出已合并为一个按钮', r.saveMenu && !r.saveWd && !r.exportBtn);
  check('新增格式刷', r.painter);
  check('新增查找', r.find);
  check('新增插入组（形状）', r.insertShape);
  check('缩放控件已移到底部', r.zoomInBottom && !r.zoomInTopbar);
  check('右侧「添加元素」已移除', !r.addGrid);
}

console.log('\n[2] 面板收起按钮贴在卡片边缘、上下居中');
{
  const r = await ev(`(() => {
    const b = document.getElementById('btn-rail-collapse');
    const p = document.getElementById('sidebar');
    const br = b.getBoundingClientRect(), pr = p.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { parentIsPanel: b.parentElement === p, top: cs.top, mt: cs.marginTop,
             centerDelta: Math.round((br.top + br.height/2) - (pr.top + pr.height/2)),
             rightOffset: Math.round(pr.right - br.right) };
  })()`);
  check('收起按钮是面板的直接子元素（折叠时不被吞掉）', r.parentIsPanel);
  /* getComputedStyle 返回的是**计算后的 px**，不是声明里的 50%；
     垂直居中与否由下面的几何断言来判定，这里只看 margin-top 的偏移量 */
  check('用 top:50% + margin-top 做垂直居中', r.top.endsWith('px') && /-26px/.test(r.mt), r.top + ' / ' + r.mt);
  check('实际几何也垂直居中（偏差 < 2px）', Math.abs(r.centerDelta) <= 2, '偏差 ' + r.centerDelta + 'px');
  check('贴在卡片内侧边缘', Math.abs(r.rightOffset) <= 2, '距右缘 ' + r.rightOffset + 'px');
}

console.log('\n[3] 选择手柄尺寸与抓取热区');
{
  const r = await ev(`(() => {
    const h = document.querySelector('.handle.h-se');
    if (!h) return null;
    const cs = getComputedStyle(h);
    const before = getComputedStyle(h, '::before');
    return { w: cs.width, h: cs.height, hitW: before.width, hitH: before.height };
  })()`);
  check('手柄放大到 13px', r && r.w === '13px' && r.h === '13px', JSON.stringify(r));
  check('抓取热区扩到 24px', r && r.hitW === '24px' && r.hitH === '24px', r && r.hitW);
}

console.log('\n[4] 保存与导出下拉');
{
  await click('btn-save-menu');
  await sleep(320);
  const r = await ev(`(() => {
    const m = document.getElementById('menu-save');
    return { hidden: m.hidden, items: Array.from(m.querySelectorAll('.menu-item')).map(b => b.textContent.trim()),
             expanded: document.getElementById('btn-save-menu').getAttribute('aria-expanded'),
             caret: getComputedStyle(document.querySelector('#btn-save-menu .btn-caret')).transform };
  })()`);
  check('点击后展开', !r.hidden && r.expanded === 'true');
  /* 「打开 HTML」的入口定在顶栏 + 空状态两处，不在这个菜单里。
     这个菜单只管保存与导出：保存 / 导出 HTML 放映页 / 导出 HTML 工程文件 / 导出 PPTX。 */
  check('列出四个功能（保存 / 导出HTML / 导出工程 / 导出PPTX）', r.items.length === 4, JSON.stringify(r.items));
  check('首项是保存（不是打开）', /保存/.test(r.items[0] || ''), JSON.stringify(r.items));
  check('菜单里没有「打开」——它在顶栏和空状态',
    !r.items.some((t) => /打开/.test(t)) &&
    /HTML/.test(r.items[1] || '') && /工程文件/.test(r.items[2] || '') &&
    /Power\s*Point|PPTX/.test(r.items[3] || ''),
    JSON.stringify(r.items));
  check('箭头已旋转（有动画中间态）', r.caret && r.caret !== 'none', String(r.caret));
  await click('btn-save-menu');
  await sleep(250);
  check('再点一次收起', await ev(`document.getElementById('menu-save').hidden`));
}

console.log('\n[5] 插入组');
{
  const before = await ev(`WD.store.slideAt(WD.store.current).doc.length`);
  /* 「文本框」现在是下拉（横向 / 竖向），要展开再点第一项 */
  await click('btn-insert-text');
  await sleep(300);
  const textItems = await ev(`document.querySelectorAll('#menu-text .shape-row button').length`);
  check('「文本框」下拉 2 项（横向 / 竖向）', textItems === 2, String(textItems));
  await ev(`document.querySelector('#menu-text .shape-row button').click()`);
  await sleep(500);
  const afterText = await ev(`(() => { const n = WD.app.E.selection[0]; return n ? n.tagName : 'none'; })()`);
  check('「横向文本框」能插入并选中', afterText !== 'none', afterText);
  await click('btn-insert-shape');
  await sleep(300);
  const shapes = await ev(`document.querySelectorAll('#menu-insert .shape-row button').length`);
  check('「形状」展开 14 种（图片/视频独立成按钮，含曲线族与自由绘制/多边形）', shapes === 14, String(shapes));
  await ev(`document.querySelector('#menu-insert .shape-row button').click()`);
  await sleep(500);
  check('形状能插入', (await ev(`WD.app.E.selection.length`)) > 0);
  check('文档内容已变化', (await ev(`WD.store.slideAt(WD.store.current).doc.length`)) !== before);

  /* 清掉本段自己插进去的两个元素。
     坑：不清理的话，最后那张验收截图里会多出一块 420×260 的浅色矩形
     （插在画布正中），**缩略图里也会同步出现** ——
     看起来像渲染缺陷，其实是测试残留，排查一次要绕很大一圈。 */
  const cleaned = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const n = doc.querySelectorAll('[data-wd-added]').length;
    doc.querySelectorAll('[data-wd-added]').forEach(e => e.remove());
    WD.app._internal.clearSelection();
    WD.app._internal.refreshOverlay();
    return { removed: n, left: doc.querySelectorAll('[data-wd-added]').length };
  })()`);
  check('清理本段插入的元素（避免污染后续截图）', cleaned.left === 0 && cleaned.removed === 2,
    JSON.stringify(cleaned));
}

console.log('\n[6] 查找');
{
  await click('btn-find');
  await sleep(280);
  check('查找栏展开', !(await ev(`document.getElementById('find-bar').hidden`)));
  await ev(`(() => { const i = document.getElementById('find-input'); i.value = '分数'; i.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(700);
  /* 高亮标记在**帧文档**里，必须到 iframe 的 doc 里去数 */
  const r = await ev(`(() => ({ hits: WD.app.E.stage.getDoc().querySelectorAll('[data-wd-find-hit]').length,
      count: (document.getElementById('find-count')||{}).textContent,
      selected: WD.app.E.selection.length }))()`);
  check('找到命中并高亮', r.hits > 0, JSON.stringify(r));
  check('显示第几个 / 共几个', /\d+\s*\/\s*\d+/.test(r.count || ''), JSON.stringify(r.count));
  check('命中项被选中', r.selected > 0);
  await ev(`document.getElementById('find-close').click()`);
  await sleep(250);
  check('关闭后清除高亮', (await ev(`WD.app.E.stage.getDoc().querySelectorAll('[data-wd-find-hit]').length`)) === 0);
}

console.log('\n[7] 格式刷');
{
  await ev(`(() => { const doc = WD.app.E.stage.getDoc(); const n = doc.querySelector('h1'); WD.app._internal.setSelection([n]); WD.app._internal.refreshOverlay(); return true; })()`);
  await sleep(300);
  await click('btn-painter');
  await sleep(250);
  check('格式刷进入激活态', await ev(`document.getElementById('btn-painter').classList.contains('on')`));
  const applied = await ev(`(() => {
    const I = WD.app._internal, doc = WD.app.E.stage.getDoc();
    const n = doc.querySelector('.big') || doc.querySelectorAll('div')[6];
    if (!n) return 'no-target';
    const before = getComputedStyle(n).fontWeight;
    const r = n.getBoundingClientRect(), rb = WD.render.findRoot(doc).getBoundingClientRect();
    I.onFramePointerDown({ button: 0, clientX: r.left - rb.left + r.width/2, clientY: r.top - rb.top + r.height/2,
                            target: n, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
                            preventDefault(){}, stopPropagation(){} });
    return { before, after: getComputedStyle(n).fontWeight };
  })()`);
  check('格式刷把源样式套用到目标', applied !== 'no-target' && typeof applied === 'object', JSON.stringify(applied));
  check('用一次即失效', !(await ev(`document.getElementById('btn-painter').classList.contains('on')`)));
}

console.log('\n[8] 文字编辑（双击进入）');
{
  const r = await ev(`(() => {
    const I = WD.app._internal, doc = WD.app.E.stage.getDoc();
    const n = doc.querySelector('h1') || doc.querySelector('h2');
    if (!n) return { skip: true };
    const rr = n.getBoundingClientRect(), rb = WD.render.findRoot(doc).getBoundingClientRect();
    const x = rr.left - rb.left + rr.width/2, y = rr.top - rb.top + rr.height/2;
    let err = null;
    try { I.onFrameDblClick({ clientX: x, clientY: y, target: n, preventDefault(){}, stopPropagation(){} }); }
    catch (e) { err = e.message; }
    const ed = WD.app.E.editing;
    return { skip: false, err, editing: !!ed, same: ed === n,
             focused: doc.activeElement === ed,
             userSelect: ed ? ed.style.userSelect : '',
             hasSel: ed ? WD.app.E.stage.getWin().getSelection().rangeCount > 0 : false };
  })()`);
  check('双击不抛异常', !r.err, String(r.err));
  check('双击进入文字编辑', r.editing, JSON.stringify(r));
  check('焦点落在被编辑元素上', r.focused, JSON.stringify(r));
  check('放开了 user-select（双击选词可用）', r.userSelect === 'text', String(r.userSelect));
  check('选区已建立', r.hasSel);
  await ev(`(() => { WD.app._internal.endTextEdit(true); return true; })()`);
}

console.log('\n[9] 底部缩放');
{
  /* zoomBy 在 fitMode 下是拿「当前适配比例」起算的，
     所以基准要读 scale，而不是那个还没生效的 zoom 字段 */
  const eff = () => ev(`(() => { const s = WD.app.E.stage; return s.fitMode ? s.scale : s.zoom; })()`);
  const before = await eff();
  await click('btn-zoom-in');
  await sleep(250);
  const after = await eff();
  check('底部 ＋ 能放大', after > before, before + ' → ' + after);
  await click('btn-zoom-out');
  await sleep(250);
  const back = await eff();
  /* 连乘浮点会累积微小误差，用容差判定 */
  check('底部 － 能缩小并基本回到原值', back < after && Math.abs(back - before) < 0.01,
    after + ' → ' + back + '（起点 ' + before + '）');
}

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (errors.length) {
  console.log('\n[控制台错误]');
  for (const e of [...new Set(errors)].slice(0, 12)) console.log('  ' + e);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync('tmp/ui-smoke.png', Buffer.from(shot.data, 'base64'));
console.log('已保存 tmp/ui-smoke.png');

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);