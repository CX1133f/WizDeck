/* 精确量：在 cw_33.html 上，微调是否真的生效、撤销是否真的回退
   用法：node tools/undo-probe.mjs [chrome.exe] [port] [html] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9473);
const HTML = process.argv[4] || 'samples/cw_33.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-undo-'));
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
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
const key = async (k, mods = 0) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: k === 'z' ? 90 : 39, modifiers: mods });
  }
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.importHtml(${JSON.stringify(fs.readFileSync(path.resolve(HTML), 'utf8'))}); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(2500);

/* 页面里的状态读取 */
await ev(`(() => {
  window.__sel = function () {
    const s = WD.app.E.selection || [];
    if (!s.length) return null;
    const n = s[0];
    const r = n.getBoundingClientRect();
    return { tag: n.tagName.toLowerCase() + '.' + (typeof n.className==='string'?n.className.split(' ')[0]:''),
             x: Math.round(r.left), y: Math.round(r.top),
             inlineLeft: n.style.left, inlinePos: n.style.position,
             pinned: n.hasAttribute('data-wd-orig-pos') };
  };
  window.__hist = function () {
    const s = WD.store;
    return { len: s.history.length, hIndex: s.hIndex,
             labels: s.history.map(h => h.label),
             docLens: s.history.map(h => (h.slides[0]||{}).doc ? h.slides[0].doc.length : -1) };
  };
  return true;
})()`);

console.log('\n输入: ' + HTML);
const pick = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const n = doc.querySelector('.cover-title') || doc.querySelector('h1') || doc.querySelectorAll('*')[1];
  WD.app._internal.setSelection([n]);
  WD.app._internal.refreshOverlay();
  const r = n.getBoundingClientRect(), rb = root.getBoundingClientRect();
  return { x: r.left - rb.left + r.width/2, y: r.top - rb.top + r.height/2, tag: n.tagName + '.' + n.className };
})()`);
await sleep(400);
console.log('选中: ' + pick.tag);
console.log('起始: ' + JSON.stringify(await ev('window.__sel()')));
console.log('历史: ' + JSON.stringify(await ev('window.__hist()')));

for (let i = 1; i <= 3; i++) {
  await key('ArrowRight', 0);
  await sleep(450);
  const s = await ev('window.__sel()');
  const h = await ev('window.__hist()');
  console.log(`  → 右键 ${i} 次: x=${s ? s.x : '?'} inlineLeft=${s ? s.inlineLeft : '?'} pinned=${s ? s.pinned : '?'} | 历史 len=${h.len} hIndex=${h.hIndex}`);
}

await key('z', 2);
await sleep(900);
const afterUndo = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const n = doc.querySelector('.cover-title') || doc.querySelector('h1');
  const r = n ? n.getBoundingClientRect() : null;
  return { x: r ? Math.round(r.left) : 'none', inlineLeft: n ? n.style.left : '', sel: WD.app.E.selection.length,
           hist: WD.store.history.length, hIndex: WD.store.hIndex,
           toast: (document.querySelector('.toast') || {}).textContent || '' };
})()`);
console.log('\nCtrl+Z 之后: ' + JSON.stringify(afterUndo));

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);