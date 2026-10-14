/* 复现两个现象：
   A. 左侧缩略图「没有完全渲染」——量每张缩略图是否存在、尺寸、以及是否画出了东西（像素方差）
   B. 画布上点一下就「排版直接错误」——点击前后 diff 画布内所有元素的几何
   用法：node tools/click-thumb-probe.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9456);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-repro-'));
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
const consoleLog = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    consoleLog.push('[console] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    consoleLog.push('[error] ' + ((d.exception && d.exception.description) || d.text));
  }
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
const click = async (x, y, mods = 0) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0, modifiers: mods });
  }
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(2500);   /* 给缩略图异步生成留时间 */

/* ══ A. 缩略图 ══ */
const thumbs = await ev(`(async () => {
  const items = Array.from(document.querySelectorAll('.rail-item'));
  const out = [];
  for (const it of items) {
    const i = it.getAttribute('data-index');
    const img = it.querySelector('.thumb-poster');
    const rec = { i, hasImg: !!img, w: 0, h: 0, blank: null, src: null };
    if (img) {
      rec.w = img.naturalWidth; rec.h = img.naturalHeight;
      rec.src = (img.getAttribute('src') || '').slice(0, 30);
      /* 画进 canvas 看有没有真的画出内容 */
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let min = 255, max = 0, sum = 0, n = 0;
        for (let p = 0; p < d.length; p += 4 * 97) {
          const v = (d[p] + d[p+1] + d[p+2]) / 3;
          if (v < min) min = v; if (v > max) max = v; sum += v; n++;
        }
        rec.blank = { min: Math.round(min), max: Math.round(max), avg: Math.round(sum / n) };
      } catch (e) { rec.blank = 'err:' + e.message; }
    }
    out.push(rec);
  }
  return out;
})()`);

console.log('\n[A] 左侧缩略图状态');
console.log('  页  有图  像素尺寸   亮度(min/max/avg)  判定');
console.log('  ' + '-'.repeat(66));
for (const t of thumbs) {
  const b = t.blank;
  const verdict = !t.hasImg ? '缺图'
    : (!t.w ? '未加载' : (b === 'null' ? '空白/未画' : (b.max - b.min < 12 ? '近乎纯色（内容缺失）' : '有内容 ✓')));
  console.log('  ' + String(t.i).padEnd(4) + String(t.hasImg).padEnd(6) +
    (t.w ? t.w + '×' + t.h : '-').padEnd(11) +
    (typeof b === 'object' ? `${b.min}/${b.max}/${b.avg}` : String(b)).padEnd(21) + verdict);
}

/* ══ B. 点击后布局是否被改坏 ══ */
const stageInfo = await ev(`(() => {
  const r = WD.app.E.stage.el.getBoundingClientRect();
  return { left: r.left, top: r.top, scale: WD.app.E.stage.scale };
})()`);
const at = (cx, cy) => ({ x: Math.round(stageInfo.left + cx * stageInfo.scale), y: Math.round(stageInfo.top + cy * stageInfo.scale) });

/* 在页面里装一个「画布快照」工具：给每个元素一个稳定 id，返回几何表 */
await ev(`(() => {
  window.__snap = function () {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    const out = [];
    let k = 0;
    for (const n of doc.querySelectorAll('*')) {
      if (n === doc.body || n === doc.documentElement) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      out.push({
        k: k++,
        tag: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/)[0] : ''),
        pinned: n.getAttribute('data-wd-orig-pos'),
        pos: getComputedStyle(n).position,
        txt: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 14),
        x: Math.round(r.left - rb.left), y: Math.round(r.top - rb.top),
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
    return out;
  };
  return true;
})()`);

console.log('\n[B] 画布点击前后几何 diff');
/* 依次点几个不同类型的元素 */
const targets = await ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const rb = root.getBoundingClientRect();
  const pick = (sel) => {
    const n = doc.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { tag: n.tagName.toLowerCase() + (typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''),
             x: r.left - rb.left + r.width / 2, y: r.top - rb.top + r.height / 2 };
  };
  return ['h1', 'p', '.big', '.kicker'].map(s => pick(s)).filter(Boolean);
})()`);

let worstTotal = 0;
for (const t of targets) {
  const before = await ev(`window.__snap()`);
  const p = at(t.x, t.y);
  await click(p.x, p.y);
  await sleep(600);
  const after = await ev(`window.__snap()`);
  const bmap = new Map(before.map((r) => [r.k, r]));
  const moved = [];
  for (const a of after) {
    const b = bmap.get(a.k);
    if (!b) { moved.push({ ...a, why: '新增元素' }); continue; }
    const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
    if (d > 1) moved.push({ ...a, was: `${b.x},${b.y} ${b.w}x${b.h}`, now: `${a.x},${a.y} ${a.w}x${a.h}`, d });
  }
  const gone = before.filter((b) => !after.some((a) => a.k === b.k));
  worstTotal = Math.max(worstTotal, moved.length + gone.length);
  console.log(`\n  点击 ${t.tag} @canvas(${Math.round(t.x)},${Math.round(t.y)})`);
  console.log(`    几何变化 ${moved.length} 个元素，消失 ${gone.length} 个`);
  for (const m of moved.slice(0, 8)) {
    console.log(`      · ${m.tag} "${m.txt}" ${m.was || ''} → ${m.now || ''}  (Δ${m.d}${m.why ? ' ' + m.why : ''})`);
  }
  if (moved.length > 8) console.log(`      … 还有 ${moved.length - 8} 个`);
}

console.log('\n  单次点击最多影响 ' + worstTotal + ' 个元素的排版。');
if (consoleLog.length) {
  console.log('\n[页面日志]');
  for (const l of consoleLog.slice(0, 20)) console.log('  ' + l);
}

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);