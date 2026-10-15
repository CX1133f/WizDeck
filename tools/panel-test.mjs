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
/* 内容块宽度必须与**各自**面板一致：rail 跟左栏比，insp-body 跟右栏比。
   断言要能真的区分「跟随」与「锁宽」，所以还要求采样点足够靠后（面板已明显变窄）。 */
function mid_ok(m) {
  return m.panelW > 4 && m.panelW < m.inspPanelW &&
         Math.abs(m.railW - m.panelW) <= 1 && Math.abs(m.bodyW - m.inspPanelW) <= 1;
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

/* ══ 5. 收起动画的收尾：缩放值不能停在中间态，也不能重画两次 ══
   坑：原来的收尾是 setTimeout(..., 60)，而过渡有 220ms ——
   measure() 落在动画中途，量到「还没收完」的宽度：画布在动画进行到 27% 时猛缩一次，
   动画走完后再没人量第二次，缩放值就永久停在那个中间值上（实测 0.551 vs 正确 0.65）。
   另外 #stage-canvas 上的 ResizeObserver（debounce 120ms）也会再触发一次，
   两次都改写 transform 就是肉眼可见的「二次渲染」卡顿。 */
console.log('\n[5] 收起动画的收尾时机');
{
  const probe = await ev(`(async () => {
    const st = WD.app.E.stage;
    const sb = document.getElementById('sidebar');
    const insp = document.getElementById('inspector');
    const out = {};

    /* 监视 transform 被真正改写了几次 —— 这才是「重画几次」 */
    let lastTf = st.el.style.transform;
    const writes = [];
    const mo = new MutationObserver(() => {
      const tf = st.el.style.transform;
      if (tf !== lastTf) { lastTf = tf; writes.push({ tf, t: Math.round(performance.now()) }); }
    });
    mo.observe(st.el, { attributes: true, attributeFilter: ['style'] });

    /* 动画期间的缩放轨迹 */
    const traj = []; let running = true;
    const tick = () => { traj.push({ t: Math.round(performance.now()), s: st.scale });
                         if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    /* 两栏都展开着，从这个状态收起左栏 */
    if (sb.classList.contains('collapsed')) document.getElementById('btn-rail-open').click();
    if (insp.classList.contains('collapsed')) document.getElementById('btn-insp-open').click();
    await new Promise(r => setTimeout(r, 420));
    writes.length = 0;
    const beforeScale = st.scale;

    /* ★ t 的原点必须打在「点击那一刻」。
       早先 t0 打在循环刚起来的时候，后面清空 traj 却不重置 t0，
       于是 filter(t <= 200) 取到的是**点击之前**那 420ms 静止期的帧 ——
       缩放当然不变，断言恒真，等于什么都没测。 */
    traj.length = 0;
    const tClick = performance.now();
    document.getElementById('btn-rail-collapse').click();
    await new Promise(r => setTimeout(r, 900));
    running = false;

    /* 收尾之后再盯 420ms：动画早已结束（过渡 220ms + 跟随 260ms + 兜底 340ms），
       这段时间里若还有改写，就是 transitionend 与 ResizeObserver 两条路径
       各写一次造成的「二次渲染」—— 那才是这个坑真正要防的东西。 */
    const tailFrom = writes.length;
    await new Promise(r => setTimeout(r, 420));
    mo.disconnect();

    const afterScale = st.scale;
    /* 「正确值」= 现在这个最终布局重新量一次应该得到的结果 */
    st.measure();
    const truth = st.scale;
    st.el.style.transform = lastTf;
    st.scale = afterScale;

    /* 动画窗口内的轨迹（0–300ms，覆盖 220ms 过渡 + 跟随余量） */
    const anim = traj.filter(x => x.t - tClick <= 300);
    const seq = anim.map(x => x.s);
    /* 单调性：跟随是「面板越宽、画布越大」，中途回头就说明有第二次独立重算 */
    let monotonic = true;
    for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1] - 1e-9) monotonic = false;
    out.beforeScale = beforeScale;
    out.afterScale = afterScale;
    out.truth = truth;
    out.stale = Math.abs(afterScale - truth) > 1e-6;
    out.writes = writes.length;
    out.tailWrites = writes.length - tailFrom;
    out.animFrames = anim.length;
    out.animDistinct = new Set(seq.map(s => s.toFixed(6))).size;
    out.monotonic = monotonic;
    out.animEndScale = seq.length ? seq[seq.length - 1] : null;
    return out;
  })()`);

  check('收起动画结束后缩放值是最终值（不是中途的陈旧值）',
    probe.stale === false,
    `结束后 ${probe.afterScale.toFixed(5)} / 重新量应为 ${probe.truth.toFixed(5)}`);

  /* 画布是**逐帧跟随**面板宽度的，所以动画窗口内缩放本来就应该连续变化
     （早先这条写成「一次都不能变」，与逐帧跟随的设计直接矛盾）。
     真正要防的是「中途猛跳一下」—— 表现为轨迹只有一个值。
     断言盯的是**不同缩放值的个数**而不是采样帧数：
     帧数取决于机器当时的 rAF 频率，机器一忙就掉到 2 帧，
     那是环境噪声不是缺陷（实测繁忙时会把这条误判成红）。
     而「只有一个缩放值」恰恰就是原来那个 bug 的特征，判据依然有效。 */
  check('动画窗口内画布是连续跟随的（不是原地不动后猛跳一下）',
    probe.animDistinct >= 3,
    `采样 ${probe.animFrames} 帧 / ${probe.animDistinct} 个不同缩放值`);
  check('跟随过程单调不回退（没有第二次独立重算造成的回头）',
    probe.monotonic === true,
    `首 ${probe.animEndScale} / 末 ${probe.animEndScale}`);

  /* 「二次渲染」的真正定义：动画彻底结束后，画布还在被改写。
     曾经的病根是 transitionend 与 ResizeObserver 两条路径各写一次。 */
  check('★ 动画结束后不再有任何改写（无二次渲染）',
    probe.tailWrites === 0,
    `收尾后仍被改写 ${probe.tailWrites} 次（整段共 ${probe.writes} 次，是逐帧跟随的正常插值）`);

  /* 恢复现场，别影响后续 */
  await ev(`(() => { const b = document.getElementById('btn-rail-open'); if (b && !b.hidden) b.click(); return true; })()`);
  await sleep(420);

  /* 内容必须跟着面板一起变窄 —— 不能把内容「锁宽」后靠 overflow 裁掉。
     坑：曾经为了省布局开销给 .rail / .insp-body 加了 width: var(--panel-w)，
     结果缩略图在收窄过程中被从中间拦腰切断、露出半截文字，一眼就是「割裂感」
     （空轨道时没东西可切，所以看着反而顺，具有迷惑性）。
     省下的那点布局（整段 220ms 共 16ms，每帧不到 0.1ms）根本不值这个视觉缺陷。
     这里把过渡拉长到 10s，在动画中途断言 rail 宽度 == 面板宽度。 */
  const follow = await ev(`(async () => {
    const sb = document.getElementById('sidebar');
    if (sb.classList.contains('collapsed')) { document.getElementById('btn-rail-open').click(); await new Promise(r => setTimeout(r, 400)); }
    const s = document.createElement('style'); s.id = 'wd-slowmo-test';
    s.textContent = '.sidebar, .inspector { transition-duration: 10s !important; }';
    document.head.appendChild(s);
    await new Promise(r => setTimeout(r, 150));

    document.getElementById('btn-rail-collapse').click();
    await new Promise(r => setTimeout(r, 2500));
    const rail = document.getElementById('rail');
    const insp = document.getElementById('inspector');
    const body = document.getElementById('insp-body');
    const mid = {
      panelW: Math.round(sb.getBoundingClientRect().width),
      railW: Math.round(rail.getBoundingClientRect().width),
      inspPanelW: Math.round(insp.getBoundingClientRect().width),
      bodyW: Math.round(body.getBoundingClientRect().width),
      collapseBtnOpacity: getComputedStyle(sb.querySelector('.panel-collapse')).opacity,
      headOpacity: getComputedStyle(sb.querySelector('.panel-head')).opacity,
    };
    s.remove();
    await new Promise(r => setTimeout(r, 700));
    return mid;
  })()`);

  check('收窄过程中内容跟着面板一起变窄（不被拦腰裁断）',
    mid_ok(follow),
    `中途 左栏 ${follow.panelW}px / rail ${follow.railW}px，右栏 ${follow.inspPanelW}px / insp-body ${follow.bodyW}px`);

  check('面板头与内侧收起按钮在收窄过程中已淡出',
    parseFloat(follow.headOpacity) < 0.5 && parseFloat(follow.collapseBtnOpacity) < 0.5,
    `head ${follow.headOpacity}，collapse 按钮 ${follow.collapseBtnOpacity}`);

  await ev(`(() => { const b = document.getElementById('btn-rail-open'); if (b && !b.hidden) b.click(); return true; })()`);
  await sleep(600);
}

console.log('\n' + '='.repeat(60));
console.log(`面板折叠回归: ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败项:'); failures.forEach(f => console.log('  - ' + f)); }
if (pageErrors.length) { console.log('\n页面错误:'); pageErrors.slice(0, 6).forEach(e => console.log('  ! ' + String(e).slice(0, 160))); }
ws.close();
process.exit(fail ? 2 : 0);
