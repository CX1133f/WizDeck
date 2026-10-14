/* 编辑框坐标系诊断：把缩放、overlay 归属、写入值全部打出来。
   用法：node tools/frame-diag.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9452);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-diag-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  '--window-size=1600,950', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch {} });

async function resolvePageWs() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  console.error('无法连接 Chromium'); process.exit(1);
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
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 90000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);

const out = await ev(`(() => {
  const I = WD.app._internal;
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const rootBox = root.getBoundingClientRect();
  const stageEl = WD.app.E.stage.el;
  const sr = stageEl.getBoundingClientRect();
  const overlay = document.getElementById('overlay');
  const fb = document.getElementById('frame-box');

  /* overlay 到底挂在谁下面 */
  let anc = [], p = overlay;
  while (p && p !== document.body) { anc.push((p.id || '') + '.' + (p.className || '').toString().split(' ')[0]); p = p.parentElement; }

  const h1 = doc.querySelector('h1');
  I.setSelection([h1]);
  I.refreshOverlay();

  const cs = WD.app.E.stage.getWin().getComputedStyle(h1);
  const r = h1.getBoundingClientRect();
  const vb = I.visualBox(h1, WD.app.E.stage.getWin());
  const rs = WD.render.textRects(h1);

  return {
    scale: WD.app.E.stage.scale,
    stageTag: stageEl.id + '.' + stageEl.className,
    stageTransform: getComputedStyle(stageEl).transform,
    stageRect: [sr.left, sr.top, sr.width, sr.height],
    stageOffsetWH: [stageEl.offsetWidth, stageEl.offsetHeight],
    overlayAncestors: anc,
    overlayTransform: getComputedStyle(overlay).transform,
    frameOffsetParent: (fb.offsetParent && (fb.offsetParent.id || fb.offsetParent.className)) || 'none',
    frameInline: { left: fb.style.left, top: fb.style.top, width: fb.style.width, height: fb.style.height },
    frameRect: (() => { const f = fb.getBoundingClientRect(); return [f.left, f.top, f.width, f.height]; })(),
    frameComputedTransform: getComputedStyle(fb).transform,
    h1BorderRectCanvas: [r.left - rootBox.left, r.top - rootBox.top, r.width, r.height],
    h1VisualBoxCanvas: [vb.x - rootBox.left, vb.y - rootBox.top, vb.w, vb.h],
    h1TextRects: rs.map(t => [Math.round(t.x - rootBox.left), Math.round(t.y - rootBox.top), Math.round(t.w), Math.round(t.h)]),
    h1ComputedWidth: cs.width,
    h1Display: cs.display,
    rootBox: [rootBox.left, rootBox.top, rootBox.width, rootBox.height]
  };
})()`);

console.log(JSON.stringify(out, null, 2));
try { child.kill(); } catch {}
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(0);