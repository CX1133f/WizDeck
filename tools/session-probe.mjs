/* 真实编辑序列下同时盯两个现象：
   A. 缩略图在 commit 之后会不会出现空档 / 缺图 / 重复图
   B. 点击 / 拖动 / 改样式 / 翻页之后，画布排版有没有被改坏
   用法：node tools/session-probe.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9458);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sess-'));
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
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push('[console] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    logs.push('[error] ' + ((d.exception && d.exception.description) || d.text));
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

/* 页面里的观测工具 */
const install = `(() => {
  window.__thumbs = function () {
    const items = Array.from(document.querySelectorAll('.rail-item'));
    return items.map(it => {
      const imgs = it.querySelectorAll('.thumb-poster');
      const i = it.getAttribute('data-index');
      return { i, n: imgs.length, loaded: imgs.length ? Array.from(imgs).filter(x => x.naturalWidth > 0).length : 0 };
    });
  };
  window.__layout = function () {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    const out = [];
    let k = 0;
    for (const n of doc.querySelectorAll('*')) {
      if (n === doc.body || n === doc.documentElement || n === root) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push(k++ + ':' + n.tagName + '.' + (typeof n.className === 'string' ? n.className.split(' ')[0] : '') +
        '|' + (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 10) +
        '|' + Math.round(r.left - rb.left) + ',' + Math.round(r.top - rb.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return out;
  };
  window.__diff = function (a, b) {
    const ma = new Map(a.map(s => [s.split('|')[0] + '|' + s.split('|')[1], s]));
    const mb = new Map(b.map(s => [s.split('|')[0] + '|' + s.split('|')[1], s]));
    const moved = [];
    for (const [k, v] of ma) {
      const w = mb.get(k);
      if (!w) { moved.push(k + ' 消失了'); continue; }
      if (w !== v) moved.push(v.split('|')[2] + ' → ' + w.split('|')[2] + '   [' + k.split('|')[0] + ']');
    }
    for (const [k] of mb) if (!ma.has(k)) moved.push(k + ' 新出现');
    return moved;
  };
  return true;
})()`;

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(3000);
await ev(install);

const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const at = (cx, cy) => ({ x: Math.round(st.left + cx * st.scale), y: Math.round(st.top + cy * st.scale) });
const mouse = async (type, p, extra = {}) => send('Input.dispatchMouseEvent', {
  type, x: p.x, y: p.y, button: 'left', clickCount: 1,
  buttons: type === 'mouseReleased' ? 0 : 1, ...extra
});

const thumbLine = (t) => t.map((x) => `${x.i}:${x.loaded}/${x.n}`).join('  ');
const problems = [];

/* ══ 步骤 1：改样式（走 commit） ══ */
console.log('\n[1] 改填充色 → commit');
{
  const p = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const n = doc.querySelector('.card') || doc.querySelectorAll('*')[3];
    const r = n.getBoundingClientRect(), rb = WD.render.findRoot(doc).getBoundingClientRect();
    return { x: r.left - rb.left + r.width/2, y: r.top - rb.top + r.height/2 };
  })()`);
  const pt = at(p.x, p.y);
  await mouse('mousePressed', pt); await mouse('mouseReleased', pt);
  await sleep(300);
  const before = await ev(`window.__layout()`);
  await ev(`(() => { WD.app._internal.styleChanged('background-color', 'rgb(1, 2, 3)', '探针改色'); return true; })()`);
  const immediately = await ev(`window.__thumbs()`);
  await sleep(80);
  const t80 = await ev(`window.__thumbs()`);
  await sleep(1200);
  const tFinal = await ev(`window.__thumbs()`);
  console.log('  commit 后立刻 : ' + thumbLine(immediately));
  console.log('  +80ms         : ' + thumbLine(t80));
  console.log('  +1.3s         : ' + thumbLine(tFinal));
  const dup = tFinal.filter((x) => x.n > 1);
  const miss = tFinal.filter((x) => x.loaded === 0);
  if (dup.length) { problems.push('缩略图重复：' + dup.map((x) => `页${x.i} 有 ${x.n} 张`).join('、')); console.log('  ← ' + problems[problems.length - 1]); }
  if (miss.length) { problems.push('缩略图缺失：' + miss.map((x) => `页${x.i}`).join('、')); console.log('  ← ' + problems[problems.length - 1]); }
  const after = await ev(`window.__layout()`);
  const moved = await ev(`window.__diff(${JSON.stringify(before)}, ${JSON.stringify(after)})`);
  console.log('  改色后排版变化：' + moved.length + ' 处' + (moved.length ? '' : ' ✓'));
  for (const m of moved.slice(0, 6)) console.log('    · ' + m);
}

/* ══ 步骤 2：拖动元素 ══ */
console.log('\n[2] 拖动元素 → commit');
{
  const p = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const kids = root.querySelectorAll('*');
    const n = Array.from(kids).find(x => x.getBoundingClientRect().width > 200);
    const r = n.getBoundingClientRect(), rb = root.getBoundingClientRect();
    return { x: r.left - rb.left + r.width/2, y: r.top - rb.top + r.height/2 };
  })()`);
  const pt = at(p.x, p.y);
  const before = await ev(`window.__layout()`);
  await mouse('mousePressed', pt);
  await mouse('mouseMoved', { x: pt.x + 30, y: pt.y + 20 });
  await sleep(80);
  await mouse('mouseMoved', { x: pt.x + 60, y: pt.y + 40 });
  await sleep(80);
  await mouse('mouseReleased', { x: pt.x + 60, y: pt.y + 40 });
  await sleep(150);
  const tDuring = await ev(`window.__thumbs()`);
  await sleep(1200);
  const tEnd = await ev(`window.__thumbs()`);
  console.log('  松手瞬间 : ' + thumbLine(tDuring));
  console.log('  +1.3s    : ' + thumbLine(tEnd));
  const dup = tEnd.filter((x) => x.n > 1), miss = tEnd.filter((x) => x.loaded === 0);
  if (dup.length) { problems.push('拖动后缩略图重复：' + dup.map((x) => `页${x.i}`).join('、')); console.log('  ← ' + problems[problems.length - 1]); }
  if (miss.length) { problems.push('拖动后缩略图缺失：' + miss.map((x) => `页${x.i}`).join('、')); console.log('  ← ' + problems[problems.length - 1]); }
  const after = await ev(`window.__layout()`);
  const moved = await ev(`window.__diff(${JSON.stringify(before)}, ${JSON.stringify(after)})`);
  const unexpected = moved.filter((m) => !/→/.test(m));   /* 拖动本身应当只让被拖的那个动 */
  console.log('  拖动后排版变化：' + moved.length + ' 处，其中非位移类 ' + unexpected.length + ' 处');
  for (const m of moved.slice(0, 8)) console.log('    · ' + m);
}

/* ══ 步骤 3：连续翻页 ══ */
console.log('\n[3] 连续翻页 0→1→2→3→4→5');
{
  for (let p = 0; p < 6; p++) {
    await ev(`(() => { const it = document.querySelectorAll('.rail-item')[${p}]; if (it) it.click(); return true; })()`);
    await sleep(60);
    const t = await ev(`window.__thumbs()`);
    const dup = t.filter((x) => x.n > 1), miss = t.filter((x) => x.loaded === 0);
    const line = '  切到页 ' + p + ' : ' + thumbLine(t) + (dup.length ? '  ← 重复 ' + dup.length : '') + (miss.length ? '  ← 缺图 ' + miss.length : '');
    console.log(line);
    if (dup.length) problems.push('翻页后缩略图重复：' + dup.map((x) => `页${x.i}`).join('、'));
    if (miss.length) problems.push('翻页后缩略图缺失：' + miss.map((x) => `页${x.i}`).join('、'));
    await sleep(900);
  }
}

console.log('\n[结论]');
if (!problems.length) console.log('  本序列下未复现问题');
else for (const p of problems) console.log('  ✗ ' + p);
if (logs.length) { console.log('\n[页面日志]'); for (const l of logs.slice(0, 15)) console.log('  ' + l); }

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);