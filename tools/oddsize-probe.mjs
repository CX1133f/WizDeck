/* 用一份**非 1920×1080** 的课件跑一遍，看画布与缩略图是不是完整：
   - 舞台里根元素的实际盒子 vs 画布 1920×1080
   - 缩略图画出来的像素比例 vs 内容实际占比
   - 点一下元素后有没有跳位
   用法：node tools/oddsize-probe.mjs [chrome.exe] [port] [html] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9459);
const HTML = process.argv[4] || 'samples/patterns/odd-size-1280x720.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-odd-'));
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
  else if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; logs.push('[error] ' + ((d.exception && d.exception.description) || d.text)); }
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

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.importHtml(${JSON.stringify(fs.readFileSync(path.resolve(HTML), 'utf8'))}); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(3000);

const info = await ev(`(() => {
  const I = WD.app._internal;
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const rr = root.getBoundingClientRect();
  const st = WD.app.E.stage;
  const sr = st.el.getBoundingClientRect();
  const page = root.firstElementChild;
  const pr = page ? page.getBoundingClientRect() : null;
  return {
    pages: WD.store.count(),
    canvas: [WD.util.CANVAS_W, WD.util.CANVAS_H],
    stageElSize: [st.el.offsetWidth, st.el.offsetHeight],
    stageScale: Math.round(st.scale * 1000) / 1000,
    rootBox: [Math.round(rr.width), Math.round(rr.height)],
    rootStyle: root.getAttribute('style'),
    pageBox: pr ? [Math.round(pr.width), Math.round(pr.height)] : null,
    pageTransform: page ? getComputedStyle(page).transform : null
  };
})()`);
console.log('\n输入文档: ' + HTML);
console.log(JSON.stringify(info, null, 2));

/* 缩略图：内容在图里占了多少 */
const thumbs = await ev(`(() => {
  const out = [];
  document.querySelectorAll('.rail-item').forEach(it => {
    const img = it.querySelector('.thumb-poster');
    const rec = { i: it.getAttribute('data-index'), has: !!img, w: 0, h: 0 };
    if (img) { rec.w = img.naturalWidth; rec.h = img.naturalHeight; rec.src = img.src.slice(0, 24); }
    out.push(rec);
  });
  return out;
})()`);
console.log('\n缩略图:');
for (const t of thumbs) console.log(`  页${t.i}: ${t.has ? t.w + '×' + t.h : '缺图'}`);

/* 截图：舞台区域，看内容有没有填满画布 */
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync('tmp/oddsize-stage.png', Buffer.from(shot.data, 'base64'));
console.log('\n已保存 tmp/oddsize-stage.png');

/* 点一下元素，看有没有跳位 */
const pin = await ev(`(() => {
  const I = WD.app._internal;
  const doc = WD.app.E.stage.getDoc();
  const out = [];
  const root = WD.render.findRoot(doc);
  for (const n of doc.querySelectorAll('*')) {
    if (n === root || n === doc.body || n === doc.documentElement) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const b = { x: r.left, y: r.top, w: r.width, h: r.height };
    try { I.pinElement(n); } catch (e) {}
    const a = n.getBoundingClientRect();
    out.push({
      tag: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : ''),
      dx: Math.round(a.left - b.x), dy: Math.round(a.top - b.y),
      dw: Math.round(a.width - b.w), dh: Math.round(a.height - b.h)
    });
  }
  return out;
})()`);
const bad = pin.filter((r) => Math.abs(r.dx) > 1 || Math.abs(r.dy) > 1 || Math.abs(r.dw) > 1 || Math.abs(r.dh) > 1);
console.log('\npin 后位移：' + bad.length + ' / ' + pin.length + ' 个元素异常');
for (const b of bad.slice(0, 12)) console.log(`  ${b.tag}  dx=${b.dx} dy=${b.dy} dw=${b.dw} dh=${b.dh}`);
/* 点一下画布中央（空白区），看选中了什么、有没有把排版改坏 */
const st0 = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
const at = (cx, cy) => ({ x: Math.round(st0.left + cx * st0.scale), y: Math.round(st0.top + cy * st0.scale) });
const layoutOf = () => ev(`(() => {
  const doc = WD.app.E.stage.getDoc();
  const root = WD.render.findRoot(doc);
  const rr = root.getBoundingClientRect();
  const page = root.firstElementChild;
  const pr = page ? page.getBoundingClientRect() : null;
  return {
    rootStyle: root.getAttribute('style') || '',
    rootPos: getComputedStyle(root).position,
    rootBox: [Math.round(rr.width), Math.round(rr.height)],
    pageBox: pr ? [Math.round(pr.width), Math.round(pr.height)] : null,
    pageStyle: page ? (page.getAttribute('style') || '') : ''
  };
})()`);

console.log('\n【点击画布中央空白区】');
{
  const before = await layoutOf();
  for (const [label, cx, cy] of [['正中央(960,540)', 960, 540], ['右下(1500,900)', 1500, 900], ['标题上(400,200)', 400, 200]]) {
    const p = at(cx, cy);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(350);
    const sel = await ev(`(() => {
      const s = WD.app.E.selection || [];
      return s.map(n => n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : '')
        + (n.hasAttribute('data-wd-root') ? ' [data-wd-root]' : '') + ' pinned=' + !!n.getAttribute('data-wd-orig-pos'));
    })()`);
    const after = await layoutOf();
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    console.log(`  点 ${label} → 选中 [${sel.join(', ') || '无'}]` + (changed ? '  ← 排版被改了！' : ''));
    if (changed) {
      console.log('     前 root: ' + before.rootStyle.slice(0, 90));
      console.log('     后 root: ' + after.rootStyle.slice(0, 90));
      console.log('     前 page: ' + before.pageStyle.slice(0, 90));
      console.log('     后 page: ' + after.pageStyle.slice(0, 90));
      break;
    }
  }
}

/* 串扰判据：倒序再 pin 一遍。
   逐个 pin 会让先被 pin 的元素脱离文档流，**它的兄弟会跟着挪**，
   于是后面元素测到的「pin 后位移」里混进了别人的影响。
   如果倒序结果与正序不同（尤其是变成 0），说明这些位移是探针串扰，不是产品 bug。 */
console.log('\n【串扰判据：倒序再 pin 一遍】');
{
  const rev = await ev(`(() => {
    const I = WD.app._internal;
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const all = Array.from(doc.querySelectorAll('*')).filter(n => {
      if (n === root || n === doc.body || n === doc.documentElement) return false;
      const r = n.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    }).reverse();
    const out = [];
    for (const n of all) {
      if (n.hasAttribute('data-wd-orig-pos')) continue;   // 已经 pin 过，跳过
      const r = n.getBoundingClientRect();
      const b = { x: r.left, y: r.top, w: r.width, h: r.height };
      try { I.pinElement(n); } catch (e) {}
      const a = n.getBoundingClientRect();
      out.push({
        tag: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : ''),
        dx: Math.round(a.left - b.x), dy: Math.round(a.top - b.y),
        dw: Math.round(a.width - b.w), dh: Math.round(a.height - b.h)
      });
    }
    return out;
  })()`);
  const badRev = rev.filter((r) => Math.abs(r.dx) > 1 || Math.abs(r.dy) > 1 || Math.abs(r.dw) > 1 || Math.abs(r.dh) > 1);
  console.log('  倒序剩余异常 ' + badRev.length + ' 个（正序为 ' + bad.length + ' 个）');
  for (const b of badRev.slice(0, 10)) console.log(`    ${b.tag}  dx=${b.dx} dy=${b.dy}`);
  if (badRev.length < bad.length) console.log('  → 正序里多出来的位移来自「先 pin 的元素脱离流、兄弟跟着挪」，属探针串扰');
}

if (logs.length) { console.log('\n[页面日志]'); for (const l of logs.slice(0, 10)) console.log('  ' + l); }

try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);