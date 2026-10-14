/* 只测 setStyleSmart 一件事：在内联存在 `background: rgb(...)` 简写时，
   设 background-color 到底发生了什么。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9350);
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
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 8).join(' | '));
  }
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

await ev(`(() => {
  const W = WD.util.CANVAS_W, H = WD.util.CANVAS_H;
  const body = '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#ffffff">'
    + '<div id="card" style="position:absolute;left:200px;top:200px;width:600px;height:360px;background:rgb(238, 242, 247)"></div></div>';
  WD.app.loadDeck({ title: 't', style: '', slides: [
    { id: 's1', name: 'p1', title: 'p1', layout: 'content', notes: '', doc: WD.parse.buildSlideDoc({ title: 't', bodyHtml: body }) }
  ]}, 't.html');
  return true;
})()`);
await sleep(1600);

const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const p = { x: Math.round(st.left + 500 * st.scale), y: Math.round(st.top + 380 * st.scale) };
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(250);

/* 逐步复现 setStyleSmart 的逻辑，看每一步 inline 与 computed 的变化 */
console.log(JSON.stringify(await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const win = WD.app.E.stage.getWin();
  const el = doc.querySelector('#card');
  const style = el.style;
  const steps = [];
  const snap = (tag) => steps.push({
    tag: tag,
    inline: (el.getAttribute('style') || '').slice(0, 200),
    computedBg: win.getComputedStyle(el).backgroundColor,
    hasBgShorthand: !!style.getPropertyValue('background'),
    bgColorLonghand: style.getPropertyValue('background-color') || '(空)',
  });
  snap('初始');

  // 第 1 步：清掉 background 简写
  style.removeProperty('background');
  snap('清掉 background 简写后');

  // 第 2 步：补回其它子属性（模拟 setStyleSmart 的 restore）
  style.setProperty('background-color', 'rgb(238, 242, 247)');
  snap('补回 background-color');

  // 第 3 步：设置新颜色
  style.setProperty('background-color', '#ff0000');
  snap('设成 #ff0000');

  return { steps: steps, inlineFull: el.getAttribute('style') };
})()`, null, 1)));

/* 再看 setStyleSmart 是通过什么路径暴露的：检查 UI 是否真的用了它 */
console.log('\n=== 检查 06-ui 里 background-color 的实际调用路径 ===');
console.log(JSON.stringify(await ev(`(() => {
  const el = WD.app.E.stage.getDoc().querySelector('#card');
  // 直接触发检查器 text 输入框的 change，并观察 setProperty 调用
  const calls = [];
  const origSet = el.style.setProperty.bind(el.style);
  const origRemove = el.style.removeProperty.bind(el.style);
  el.style.setProperty = function (k, v, pr) { calls.push('set(' + k + ',' + v + ')'); return origSet(k, v, pr); };
  el.style.removeProperty = function (k) { calls.push('remove(' + k + ')'); return origRemove(k); };
  const inp = document.getElementById('f-fill-text');
  inp.value = '#00ff00';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return { calls: calls, computedAfter: WD.app.E.stage.getWin().getComputedStyle(el).backgroundColor,
           inlineAfter: (el.getAttribute('style')||'').slice(0, 180) };
})()`, null, 1)));

/* 打开调试日志，直接调用内部改色函数并读取日志 */
console.log('\n=== 直接调用 styleChanged + 调试日志 ===');
console.log(JSON.stringify(await ev(`(() => {
  WD.app.debug.on();
  const doc = WD.app.E.stage.getDoc();
  const win = WD.app.E.stage.getWin();
  const el = doc.querySelector('#card');
  // 先恢复到干净状态
  el.setAttribute('style', 'position:absolute;left:200px;top:200px;width:600px;height:360px;background:rgb(238, 242, 247)');
  const before = win.getComputedStyle(el).backgroundColor;
  WD.app._internal.styleChanged('background-color', '#0000ff', '测试');
  const after = win.getComputedStyle(el).backgroundColor;
  return {
    before, after,
    inline: el.getAttribute('style'),
    log: WD.app.debug.log(),
    sel: (WD.app.E.selection || []).length,
  };
})()`, null, 1)));

console.log('\n=== 直接调用 setStyleSmart ===');
console.log(JSON.stringify(await ev(`(() => {
  WD.app.debug.clear();
  const doc = WD.app.E.stage.getDoc();
  const win = WD.app.E.stage.getWin();
  const el = doc.querySelector('#card');
  el.setAttribute('style', 'position:absolute;left:200px;top:200px;width:600px;height:360px;background:rgb(238, 242, 247)');
  const before = win.getComputedStyle(el).backgroundColor;
  WD.app._internal.setStyleSmart(el, 'background-color', '#0000ff');
  const after = win.getComputedStyle(el).backgroundColor;
  return { before, after, inline: el.getAttribute('style'), log: WD.app.debug.log() };
})()`, null, 1)));

/* 关键对照：分别用「程序化触发」与「真实键盘输入」两条路径 */
console.log('\n=== 对照 A：程序化设值 + dispatchEvent(change) ===');
console.log(JSON.stringify(await ev(`(() => {
  WD.app.debug.clear();
  const doc = WD.app.E.stage.getDoc();
  const win = WD.app.E.stage.getWin();
  const el = doc.querySelector('#card');
  el.setAttribute('style', 'position:absolute;left:200px;top:200px;width:600px;height:360px;background:rgb(238, 242, 247)');
  const inp = document.getElementById('f-fill-text');
  const info = { isTextInput: inp.tagName + '/' + inp.type, beforeStylePE: el.style.getPropertyValue('background') };
  inp.value = '#0000ff';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return Object.assign(info, {
    after: win.getComputedStyle(el).backgroundColor,
    inline: el.getAttribute('style'),
    log: WD.app.debug.log(),
  });
})()`, null, 1)));

console.log('\n=== 对照 B：检查 setStyleSmart 是否被别处覆盖（看源码里所有调用点） ===');
console.log(JSON.stringify(await ev(`(() => {
  const el = WD.app.E.stage.getDoc().querySelector('#card');
  // 逐步手动复刻 setStyleSmart 的实际逻辑，但把每一步的真实返回值打出来
  const style = el.style;
  const win = WD.app.E.stage.getWin();
  const cs = win.getComputedStyle(el);
  const out = {
    hasBackgroundProp: style.getPropertyValue('background'),
    hasBgColorProp: style.getPropertyValue('background-color'),
    length: style.length,
    cssText: style.cssText,
    computedBg: cs.backgroundColor,
    computedBgImage: cs.backgroundImage,
  };
  const restore = {};
  ['background-color','background-image','background-repeat','background-position','background-size','background-attachment','background-clip','background-origin'].forEach(function (sub) {
    const v = cs.getPropertyValue(sub);
    if (v) restore[sub] = v;
  });
  out.restoreCount = Object.keys(restore).length;
  style.removeProperty('background');
  out.afterRemoveBg = { bg: style.getPropertyValue('background'), bgc: style.getPropertyValue('background-color'), cssText: style.cssText };
  Object.keys(restore).forEach(function (sub) { if (!style.getPropertyValue(sub)) style.setProperty(sub, restore[sub]); });
  out.afterRestore = { cssText: style.cssText, computed: win.getComputedStyle(el).backgroundColor };
  style.setProperty('background-color', '#0000ff');
  out.finalComputed = win.getComputedStyle(el).backgroundColor;
  return out;
})()`, null, 1)));

console.log('\n=== 对照 C：getComputedStyle 之后再读内联样式 ===');
console.log(JSON.stringify(await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const win = WD.app.E.stage.getWin();
  const el = doc.querySelector('#card');
  el.setAttribute('style', 'position:absolute;left:200px;top:200px;width:600px;height:360px;background:rgb(238, 242, 247)');
  const style = el.style;
  const out = {};
  out.beforeRead = style.getPropertyValue('background');
  const cs = win.getComputedStyle(el);
  out.afterGetComputedStyle = style.getPropertyValue('background');
  out.afterGCS_bgc = style.getPropertyValue('background-color');
  out.afterGCS_len = style.length;
  out.afterGCS_cssText = style.cssText;
  // 试着写
  const removed = style.removeProperty('background');
  out.removeReturned = removed;
  out.afterRemove = style.cssText;
  style.setProperty('background-color', '#0000ff');
  out.afterSet = style.cssText;
  out.computed = win.getComputedStyle(el).backgroundColor;
  return out;
})()`, null, 1)));

ws.close();
