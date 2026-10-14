/* 「文本框定位准不准」——在真实示例课件上量。
   判据：pin 之后、以及拖动之后，元素里**文字行盒**的位置是否与预期一致。
   用行盒而不是边框盒，因为用户看到的是文字，不是盒子的边。
   用法：node tools/textpos-test.mjs <chrome.exe> <port> */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9440);
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
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 90000);
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
await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => {
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (WD.app.E.stage.ready && WD.store.count() > 0 && WD.app._internal.layerNodes().length) return true;
  }
  return false;
})()`);

/* 在页面里装一个「文字行盒」测量器 */
await ev(`(() => {
  window.__textBox = function (sel) {
    const doc = WD.app.E.stage.getDoc();
    const n = typeof sel === 'string' ? doc.querySelector(sel) : sel;
    if (!n) return null;
    const root = WD.render.findRoot(doc).getBoundingClientRect();
    const rects = WD.render.textRects(n);
    if (!rects.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    rects.forEach(r => {
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    return { x: Math.round(x0 - root.left), y: Math.round(y0 - root.top),
             w: Math.round(x1 - x0), h: Math.round(y1 - y0),
             lines: rects.length };
  };
  return true;
})()`);

const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const at = (x, y) => ({ x: Math.round(st.left + x * st.scale), y: Math.round(st.top + y * st.scale) });

/* ══ 1. 行内元素不该被选中 ══ */
console.log('\n[1] 行内元素（<em>）不该被单独选中');
{
  /* H1 里有 <em>意义</em>，点在 em 上必须选中 H1 而不是 em */
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const em = doc.querySelector('em');
    if (!em) return { skip: true };
    const root = WD.render.findRoot(doc).getBoundingClientRect();
    const b = em.getBoundingClientRect();
    return { skip: false,
             emBox: [Math.round(b.left - root.left), Math.round(b.top - root.top), Math.round(b.width), Math.round(b.height)],
             emSelectable: (function () { try { return WD.app._internal.isSelectable(em, WD.app.E.stage.getWin()); } catch (e) { return 'err:' + e.message; } })() };
  })()`);
  check('存在行内 <em> 元素', r.skip !== true, JSON.stringify(r));
  if (!r.skip) {
    check('<em> 被判定为不可选中', r.emSelectable === false, JSON.stringify(r));
    const cx = r.emBox[0] + r.emBox[2] / 2, cy = r.emBox[1] + r.emBox[3] / 2;
    const picked = await ev(`(() => {
      const n = WD.app._internal.pickAt(${Math.round(cx)}, ${Math.round(cy)});
      return n ? n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : '') : null;
    })()`);
    check('点在 <em> 上选中的是它所在的标题', /^H1|^H2/.test(String(picked)), `选中了 ${picked}`);
  }
}

/* ══ 2. 点在页面空白处 → 不选中整页底板 ══ */
console.log('\n[2] 页面空白处不该选中整页');
{
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const page = root.children[0];
    return { pageTag: page.tagName + '.' + String(page.className).split(' ')[0],
             pageBackdrop: (function () { try { return WD.app._internal.isPageBackdrop(page, WD.app.E.stage.getWin()); } catch (e) { return 'err:' + e.message; } })(),
             pageSelectable: WD.app._internal.isSelectable(page, WD.app.E.stage.getWin()) };
  })()`);
  check('整页底板被判定为不可选中', r.pageSelectable === false, JSON.stringify(r));

  /* 真实点击页面上的空白处：
     先扫描出一条「elementFromPoint 正好是整页底板」的点，才是真空白；
     之前随便取右下角，其实那里被 "1/2" 大卡片盖住了，属于选错点。 */
  const blank = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    const page = root.children[0];
    const pr = page.getBoundingClientRect();
    for (let fy = 0.06; fy <= 0.96; fy += 0.04) {
      for (let fx = 0.06; fx <= 0.96; fx += 0.04) {
        const px = pr.left + pr.width * fx, py = pr.top + pr.height * fy;
        if (doc.elementFromPoint(px, py) !== page) continue;
        /* 再确认这个点上确实没有可选中元素 */
        const picked = WD.app._internal.pickAt(Math.round(px - rb.left), Math.round(py - rb.top));
        if (picked) continue;
        return { x: Math.round(px - rb.left), y: Math.round(py - rb.top) };
      }
    }
    return null;
  })()`);
  check('能找到一块真正的页面空白', !!blank, JSON.stringify(blank));
  if (blank) {
    const p = at(blank.x, blank.y);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
    const sel = await ev(`(() => (WD.app.E.selection || []).map(n => n.tagName))()`);
    check('点空白处不选中任何元素', sel.length === 0, JSON.stringify(sel));
  } else {
    check('能找到页面空白点', false, '四个候选点都被子元素覆盖');
  }
}

/* ══ 3. pin 不移动文字 ══ */
console.log('\n[3] 钉住元素后文字位置不变');
{
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const out = [];
    /* 逐个测量「有文字的元素」pin 前后 */
    const cands = [];
    root.querySelectorAll('*').forEach(function (n) {
      if (n.hasAttribute('data-wd-orig-pos')) return;
      const cs = WD.app.E.stage.getWin().getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      let own = false;
      for (const c of n.childNodes) if (c.nodeType === 3 && c.nodeValue.trim()) own = true;
      if (!own) return;
      if (!WD.app._internal.isSelectable(n, WD.app.E.stage.getWin())) return;
      cands.push(n);
    });
    for (const n of cands.slice(0, 12)) {
      const before = window.__textBox(n);
      const bx = n.getBoundingClientRect();
      const bbox = [Math.round(bx.width), Math.round(bx.height)];
      WD.app._internal.pinElement(n);
      const after = window.__textBox(n);
      const ax = n.getBoundingClientRect();
      if (before && after) {
        out.push({
          tag: n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''),
          text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 10),
          dx: after.x - before.x, dy: after.y - before.y,
          dw: after.w - before.w, dh: after.h - before.h,
          boxBefore: bbox, boxAfter: [Math.round(ax.width), Math.round(ax.height)],
          inlineWidth: n.style.width || '(auto)',
          align: WD.app.E.stage.getWin().getComputedStyle(n).textAlign,
        });
      }
    }
    return out;
  })()`, null, 1);
  console.log('  pin 前后文字位移:', JSON.stringify(r));
  const worst = r.reduce((m, x) => Math.max(m, Math.abs(x.dx), Math.abs(x.dy)), 0);
  check('pin 后文字位置没有可见位移（≤1px）', worst <= 1, `最大位移 ${worst}px`);
  check('测到了若干文字元素', r.length >= 3, `只有 ${r.length} 个`);
}

/* ══ 4. 拖动跟手且准 ══ */
console.log('\n[4] 拖动跟手');
{
  /* 重新载入，避免上一步 pin 影响 */
  await ev(`(async () => { WD.app.reload(); return true; })()`);
  await ev(`(async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (WD.app.E.stage.ready && WD.app.E.stage.getDoc().querySelector('#dummy, .kicker')) return true;
    }
    return true;
  })()`);

  const target = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const n = doc.querySelector('.kicker') || doc.querySelector('h2');
    if (!n) return null;
    const root = WD.render.findRoot(doc).getBoundingClientRect();
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.left - root.left + b.width / 2), y: Math.round(b.top - root.top + b.height / 2),
             box: [Math.round(b.left - root.left), Math.round(b.top - root.top)] };
  })()`);
  check('找到可拖动的文字元素', !!target, JSON.stringify(target));
  if (target) {
    const from = at(target.x, target.y);
    const to = at(target.x + 140, target.y + 90);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', buttons: 1, button: 'left',
        x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8,
      });
      await sleep(12);
    }
    const during = await ev(`(() => {
      const doc = WD.app.E.stage.getDoc();
      const n = doc.querySelector('.kicker') || doc.querySelector('h2');
      const root = WD.render.findRoot(doc).getBoundingClientRect();
      const b = n.getBoundingClientRect();
      return [Math.round(b.left - root.left), Math.round(b.top - root.top)];
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
    const after = await ev(`(() => {
      const doc = WD.app.E.stage.getDoc();
      const n = doc.querySelector('.kicker') || doc.querySelector('h2');
      const root = WD.render.findRoot(doc).getBoundingClientRect();
      const b = n.getBoundingClientRect();
      return [Math.round(b.left - root.left), Math.round(b.top - root.top)];
    })()`);
    const dx = after[0] - target.box[0];
    const dy = after[1] - target.box[1];
    /* 吸附可能把结果拉到 6px 内的整齐位置，所以给一点容差 */
    check('拖动位移与鼠标一致（吸附容差内）',
      Math.abs(dx - 140) <= 7 && Math.abs(dy - 90) <= 7,
      `实际 dx=${dx} dy=${dy}（期望 140 / 90）；拖动中 ${JSON.stringify(during)}`);
    check('拖动过程跟手（拖动中已移动）',
      Math.abs(during[0] - target.box[0]) > 100,
      `拖动中位移 ${during[0] - target.box[0]}`);
  }
}

/* ══ 5. 点选卡片仍然可行（回归） ══ */
console.log('\n[5] 卡片仍可点选');
{
  const r = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const out = [];
    root.querySelectorAll('*').forEach(function (n) {
      const cs = WD.app.E.stage.getWin().getComputedStyle(n);
      if (cs.display === 'none') return;
      const rr = n.getBoundingClientRect();
      if (rr.width < 80 || rr.height < 60) return;
      if (!WD.app._internal.isSelectable(n, WD.app.E.stage.getWin())) return;
      out.push(n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''));
    });
    return out.slice(0, 20);
  })()`);
  check('页面里存在多个可选中的块级元素', r.length >= 3, JSON.stringify(r));
}

/* ══ 6. 顶栏文字格式工具条 ══ */
console.log('\n[6] 顶栏文字格式工具条');
{
  await ev(`(async () => { WD.app.reload(); return true; })()`);
  await ev(`(async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (WD.app.E.stage.ready && WD.app.E.stage.getDoc().querySelector('.kicker')) return true;
    }
    return true;
  })()`);

  const hiddenAtStart = await ev(`(() => document.getElementById('fmt-group').hidden)()`);
  check('未选中元素时格式条隐藏', hiddenAtStart === true);

  /* 选中一个文字元素 */
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    WD.app._internal.setSelection([doc.querySelector('.kicker')]);
    return true;
  })()`);
  await sleep(200);
  const shown = await ev(`(() => ({
    hidden: document.getElementById('fmt-group').hidden,
    size: document.getElementById('fmt-size-label').textContent,
  }))()`);
  check('选中文字元素后格式条出现', shown.hidden === false, JSON.stringify(shown));
  check('格式条显示当前字号', /px$/.test(shown.size), shown.size);

  /* 真实点击「加粗」。
     注意：.kicker 本身已经是 700（设计上就是加粗的小标），
     所以第一次点击的效果是**取消**加粗，第二次再恢复 —— 两个方向都要验证。 */
  const boldBtn = await ev(`(() => {
    const b = document.getElementById('fmt-bold');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const weightOf = () => ev(`(() => parseFloat(WD.app.E.stage.getWin().getComputedStyle(WD.app.E.stage.getDoc().querySelector('.kicker')).fontWeight))()`);
  const w0 = await weightOf();
  check('起始字重与按钮状态一致（.kicker 本来就是粗体）', w0 >= 600, `起始 ${w0}`);
  const btnOn = await ev(`(() => document.getElementById('fmt-bold').classList.contains('on'))()`);
  check('格式条的加粗按钮正确高亮', btnOn === true);

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: boldBtn.x, y: boldBtn.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: boldBtn.x, y: boldBtn.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boldBtn.x, y: boldBtn.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(340);
  const w1 = await weightOf();
  check('点「加粗」把粗体切成常规体', w1 < 600, `${w0} → ${w1}`);
  const btnOff = await ev(`(() => document.getElementById('fmt-bold').classList.contains('on'))()`);
  check('按钮高亮随之取消', btnOff === false);

  /* 再点一次应恢复粗体 */
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: boldBtn.x, y: boldBtn.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boldBtn.x, y: boldBtn.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(340);
  const w2 = await weightOf();
  check('再点一次恢复粗体', w2 >= 600, `${w1} → ${w2}`);

  /* 字号 A+ */
  const incBtn = await ev(`(() => {
    const b = document.getElementById('fmt-size-inc');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const sizeBefore = await ev(`(() => parseFloat(WD.app.E.stage.getWin().getComputedStyle(WD.app.E.stage.getDoc().querySelector('.kicker')).fontSize))()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: incBtn.x, y: incBtn.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: incBtn.x, y: incBtn.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(320);
  const sizeAfter = await ev(`(() => parseFloat(WD.app.E.stage.getWin().getComputedStyle(WD.app.E.stage.getDoc().querySelector('.kicker')).fontSize))()`);
  check('点 A+ 放大字号 2px', Math.abs((sizeAfter - sizeBefore) - 2) < 0.6,
    `${sizeBefore} → ${sizeAfter}`);

  /* 居中 */
  const cBtn = await ev(`(() => {
    const b = document.getElementById('fmt-align-center');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cBtn.x, y: cBtn.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cBtn.x, y: cBtn.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(320);
  const align = await ev(`(() => WD.app.E.stage.getWin().getComputedStyle(WD.app.E.stage.getDoc().querySelector('.kicker')).textAlign)()`);
  check('点居中按钮设置 text-align', align === 'center', align);

  /* 聚焦输入框时不能因为「正在打字」而挡住快捷键 —— 这里验证格式条不抢焦点 */
  const focusOk = await ev(`(() => {
    const ae = document.activeElement;
    return { tag: ae ? ae.tagName : null, id: ae ? ae.id : null };
  })()`);
  check('点格式按钮后焦点没有落在文本输入框', focusOk.id !== 'fmt-color-input', JSON.stringify(focusOk));
}

console.log('\n' + '='.repeat(60));
console.log(`文本框定位 / 操作手感回归: ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败项:'); failures.forEach(f => console.log('  - ' + f)); }
if (pageErrors.length) { console.log('\n页面错误:'); pageErrors.slice(0, 6).forEach(e => console.log('  ! ' + String(e).slice(0, 160))); }
ws.close();
process.exit(fail ? 2 : 0);
