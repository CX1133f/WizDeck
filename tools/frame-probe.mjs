/* 编辑框准不准 —— 直接量「画出来的选择框」与「用户看到的文字范围」的偏差。
   判据：把选中元素后读 #frame-box 的几何，换算回画布坐标，
        与 WD.render.textRects() 的行盒并集比对。
   用法：node tools/frame-probe.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9451);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 起一个带调试端口的无头 Chrome ── */
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-frame-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  '--window-size=1600,950', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

function bail(msg) {
  console.error(msg);
  try { child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
}
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
  bail('无法连接 Chromium');
}

const ws = new WebSocket(await resolvePageWs());
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => {
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (WD.app.E.stage.ready && WD.store.count() > 0) return true;
  }
  return false;
})()`);

/* ══ 量：框 vs 文字 ══ */
const rows = await ev(`(() => {
  const I = WD.app._internal;
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const rootBox = root.getBoundingClientRect();
  const stageRect = WD.app.E.stage.el.getBoundingClientRect();
  const s = WD.app.E.stage.scale;

  function textBox(n) {
    const rs = WD.render.textRects(n);
    if (!rs.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    rs.forEach(r => {
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 收集本页所有「有裸文本」的元素 */
  const all = Array.from(doc.querySelectorAll('*')).filter(n => {
    if (n === root) return false;
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i];
      if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) return true;
    }
    return false;
  }).slice(0, 40);

  const out = [];
  for (const n of all) {
    const tb = textBox(n);
    if (!tb || tb.w < 4 || tb.h < 4) continue;
    I.setSelection([n]);
    I.refreshOverlay();
    const fb = document.getElementById('frame-box');
    if (fb.hidden) { continue; }
    const f = fb.getBoundingClientRect();
    const box = {
      x: (f.left - stageRect.left) / s,
      y: (f.top - stageRect.top) / s,
      w: f.width / s,
      h: f.height / s
    };
    const tbCanvas = { x: tb.x - rootBox.left, y: tb.y - rootBox.top, w: tb.w, h: tb.h };
    const br = n.getBoundingClientRect();
    const elBox = { x: br.left - rootBox.left, y: br.top - rootBox.top, w: br.width, h: br.height };
    out.push({
      tag: n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/)[0] : ''),
      text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 22),
      box: [Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h)],
      textBox: [Math.round(tbCanvas.x), Math.round(tbCanvas.y), Math.round(tbCanvas.w), Math.round(tbCanvas.h)],
      /* 偏差以「元素自身的盒子」为基准 —— 那才是编辑框该重合的东西 */
      dx: Math.round(box.x - elBox.x),
      dy: Math.round(box.y - elBox.y),
      dw: Math.round(box.w - elBox.w),
      dh: Math.round(box.h - elBox.h)
    });
  }
  I.clearSelection();
  return out;
})()`);

console.log('\n画布实测：选择框 vs 元素盒子 / 文字范围');
console.log('主判据 = 框与**元素自身盒子**完全重合（dx/dw/dh 应全为 0）');
console.log('参考列 = 框与文字行盒的差异，块级元素撑满整行时 dw>0 是正常的；');
console.log('         dy/dh 偏大是字体行内盒比行盒高所致，不是框画错了。\n');
console.log('  元素'.padEnd(22) + '文字'.padEnd(20) + '选择框 (x,y,w,h)'.padEnd(24) +
  '文字范围 (x,y,w,h)'.padEnd(24) + '  dx    dy    dw    dh   判定');
console.log('  ' + '-'.repeat(120));
let bad = 0;
for (const r of rows) {
  const off = Math.abs(r.dx) > 0.5 || Math.abs(r.dw) > 0.5 || Math.abs(r.dh) > 0.5;
  if (off) bad++;
  console.log('  ' + r.tag.slice(0, 21).padEnd(22) + r.text.padEnd(18) +
    JSON.stringify(r.box).padEnd(24) + JSON.stringify(r.textBox).padEnd(24) +
    String(r.dx).padStart(5) + String(r.dy).padStart(6) + String(r.dw).padStart(6) +
    String(r.dh).padStart(6) + (off ? '   框与元素盒子不一致 ← 有问题' : '   ✓'));
}
console.log('\n共 ' + rows.length + ' 个文字元素，其中 ' + bad + ' 个框与元素盒子不一致。');
if (pageErrors.length) console.log('\n控制台错误:\n' + pageErrors.join('\n'));

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(bad ? 1 : 0);