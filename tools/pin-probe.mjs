/* pinElement 会不会把元素钉歪？
   pinElement 把 left/top 写成「相对根元素 [data-wd-root]」的偏移，
   但 CSS 里绝对定位元素的 left/top 是相对**包含块(offsetParent)**解析的。
   只要元素的包含块不是根，坐标就会差一个包含块的偏移 —— 点击即跳位。
   用法：node tools/pin-probe.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9457);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-pin-'));
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
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);

/* 逐页扫描：用真实点击左栏缩略图翻页（走的是和用户一样的路径） */
const out = [];
const pages = await ev(`(() => Array.from(document.querySelectorAll('.rail-item')).length)()`);
for (let p = 0; p < pages; p++) {
  /* 点第 p 页的缩略图 */
  const box = await ev(`(() => {
    const it = document.querySelectorAll('.rail-item')[${p}];
    if (!it) return null;
    const r = it.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box) continue;
  /* 直接触发 rail-item 的 click —— 与用户点缩略图走同一条 goSlide 路径 */
  await ev(`(() => { const it = document.querySelectorAll('.rail-item')[${p}]; if (it) it.click(); return true; })()`);
  const ready = await ev(`(async () => {
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (WD.app.E.stage.ready && WD.app.E.stage.getDoc()) return true;
    }
    return false;
  })()`);
  if (!ready) { out.push({ page: p, tag: '(page not ready)', err: 'stage not ready' }); continue; }

  const row = await ev(`(() => {
    const I = WD.app._internal;
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const nodes = Array.from(doc.querySelectorAll('*')).filter(n => {
      if (n === root || n === doc.body || n === doc.documentElement) return false;
      const r = n.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    const res = [];
    for (const n of nodes) {
      if (!doc.contains(n)) continue;
      const before = n.getBoundingClientRect();
      const b = { x: before.left, y: before.top, w: before.width, h: before.height };
      const op = n.offsetParent;
      const opDesc = !op ? 'null'
        : (op === root ? 'ROOT'
          : (op === doc.body ? 'body'
            : op.tagName.toLowerCase() + (typeof op.className === 'string' && op.className ? '.' + op.className.trim().split(/\\s+/)[0] : '')));
      let err = null;
      try { I.pinElement(n); } catch (e) { err = e.message; }
      const after = n.getBoundingClientRect();
      res.push({
        tag: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/)[0] : ''),
        txt: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 16),
        offsetParent: opDesc,
        dx: Math.round(after.left - b.x), dy: Math.round(after.top - b.y),
        dw: Math.round(after.width - b.w), dh: Math.round(after.height - b.h), err
      });
    }
    return res;
  })()`);
  for (const r of row) out.push({ page: p, ...r });
  if (process.env.WD_VERBOSE) console.log(`  page ${p}: 当前=${await ev('WD.store.current')} 元素=${row.length}`);
}
const scan = out;

const bad = scan.filter((r) => r.err && r.tag !== '(page not ready)')
  || scan.filter((r) => !r.err && (Math.abs(r.dx) > 1 || Math.abs(r.dy) > 1 || Math.abs(r.dw) > 1 || Math.abs(r.dh) > 1));
const notReady = scan.filter((r) => r.tag === '(page not ready)');
if (notReady.length) console.log('\n注意：有 ' + notReady.length + ' 页舞台未就绪，已跳过');
console.log('\npinElement 位移检查（共 ' + scan.length + ' 个可选元素）');
console.log('dx/dy = 左上角位移，dw/dh = 尺寸变化；判定基准是 1px\n');
if (!bad.length) {
  console.log('  全部 0 偏差 —— pin 本身是保位的。');
} else {
  console.log('  页  元素'.padEnd(24) + '包含块(offsetParent)'.padEnd(26) + '文字'.padEnd(18) + '   dx    dy    dw    dh');
  console.log('  ' + '-'.repeat(104));
  for (const r of bad.slice(0, 40)) {
    console.log('  ' + String(r.page).padEnd(4) + r.tag.slice(0, 23).padEnd(24) +
      r.offsetParent.slice(0, 25).padEnd(26) + r.txt.padEnd(18) +
      String(r.dx).padStart(5) + String(r.dy).padStart(6) +
      String(r.dw).padStart(6) + String(r.dh).padStart(6));
  }
  if (bad.length > 40) console.log('  … 还有 ' + (bad.length - 40) + ' 个');
  const byOp = {};
  for (const r of bad) byOp[r.offsetParent] = (byOp[r.offsetParent] || 0) + 1;
  console.log('\n  按包含块归类：');
  for (const k of Object.keys(byOp)) console.log('    ' + k.padEnd(26) + byOp[k] + ' 个错位');
}
console.log('\n共 ' + bad.length + ' / ' + scan.length + ' 个元素在 pin 后发生位移。');

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);