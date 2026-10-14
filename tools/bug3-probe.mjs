/* 三个现象一起量：
   A. 左侧某些页「无内容」但实际有内容（切换页面之后尤其明显）
   B. 刚载入时点击导致排版错误
   C. 撤销 / 重做快捷键无效果
   用法：node tools/bug3-probe.mjs [chrome.exe] [port] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9464);
const INPUT = process.argv[4] || '';        /* 留空 = 用内置示例；否则用这个 HTML */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-b3-'));
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
const key = async (k, mods = 2) => {          /* mods: 2 = Ctrl */
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: k === 'z' ? 90 : 89, modifiers: mods });
  }
};
const mouse = async (type, p) => send('Input.dispatchMouseEvent', {
  type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1
});

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(INPUT
  ? `(async () => { await WD.app.importHtml(${JSON.stringify(fs.readFileSync(path.resolve(INPUT), 'utf8'))}); return true; })()`
  : `(async () => { await WD.app.loadSample(); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(3000);
console.log('\n输入文档: ' + (INPUT || '(内置示例)'));
{
  const p = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const page = root.firstElementChild;
    const pr = page ? page.getBoundingClientRect() : null;
    return { pages: WD.store.count(), rootBox: [Math.round(root.getBoundingClientRect().width), Math.round(root.getBoundingClientRect().height)],
             pageBox: pr ? [Math.round(pr.width), Math.round(pr.height)] : null };
  })()`);
  console.log('  ' + JSON.stringify(p));
}

/* ══ A. 翻页过程中的缩略图 ══ */
console.log('\n[A] 翻页过程中的缩略图');
const thumbState = () => ev(`(() => Array.from(document.querySelectorAll('.rail-item')).map(it => {
  const img = it.querySelector('.thumb-poster');
  return { i: it.getAttribute('data-index'), ok: !!(img && img.naturalWidth > 0), w: img ? img.naturalWidth : 0 };
}))()`);
const line = (t) => t.map((x) => `${x.i}${x.ok ? '✓' : '✗空'}`).join(' ');
console.log('  初始(第1页)      : ' + line(await thumbState()));

/* 快速连点左栏翻页 —— 用户最常见的操作 */
for (let p = 1; p <= 5; p++) {
  await ev(`(() => { const it = document.querySelectorAll('.rail-item')[${p}]; if (it) it.click(); return true; })()`);
  await sleep(120);
  if (p === 1) console.log('  切到第2页后120ms : ' + line(await thumbState()));
}
console.log('  连点翻到第6页后  : ' + line(await thumbState()));
await sleep(2500);
console.log('  等 2.5s          : ' + line(await thumbState()));
const tA = await thumbState();
const emptyA = tA.filter((x) => !x.ok);
console.log(emptyA.length ? `  ✗ 有 ${emptyA.length} 页缩略图是空的：页 ${emptyA.map((x) => x.i).join(',')}` : '  ✓ 全部有图');

/* ══ B. 刚载入时点击 ══ */
console.log('\n[B] 刚切到某页后立刻点击（不做任何编辑）');
await ev(`(() => { const it = document.querySelectorAll('.rail-item')[2]; if (it) it.click(); return true; })()`);
await sleep(700);
{
  const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
  const at = (cx, cy) => ({ x: Math.round(st.left + cx * st.scale), y: Math.round(st.top + cy * st.scale) });
  const layout = () => ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const rb = root.getBoundingClientRect();
    const out = [];
    let k = 0;
    for (const n of doc.querySelectorAll('*')) {
      if (n === doc.body || n === doc.documentElement) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push(k++ + '|' + n.tagName + '|' + (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,10) + '|' +
        Math.round(r.left-rb.left)+','+Math.round(r.top-rb.top)+','+Math.round(r.width)+'x'+Math.round(r.height));
    }
    return out;
  })()`);
  for (const [label, cx, cy] of [['中部(960,540)', 960, 540], ['左中(600,540)', 600, 540], ['下部(960,800)', 960, 800]]) {
    const before = await layout();
    const p = at(cx, cy);
    await mouse('mousePressed', p); await mouse('mouseReleased', p);
    await sleep(500);
    const after = await layout();
    const moved = await ev(`window.__d3 ? window.__d3(${JSON.stringify(before)}, ${JSON.stringify(after)}) : (() => {
      const ma = new Map(${JSON.stringify(before)}.map(s => [s.split('|').slice(0,3).join('|'), s]));
      const mb = new Map(${JSON.stringify(after)}.map(s => [s.split('|').slice(0,3).join('|'), s]));
      const out = [];
      for (const [k,v] of ma) { const w = mb.get(k); if (!w) out.push(k+' 消失'); else if (w!==v) out.push(v.split('|').pop()+' → '+w.split('|').pop()+'  ['+k+']'); }
      return out;
    })()`);
    console.log(`  点 ${label}: 变化 ${moved.length} 处` + (moved.length ? '  ← 排版被改了' : ' ✓'));
    for (const m of moved.slice(0, 5)) console.log('      · ' + m);
  }
}

/* ══ C. 撤销 / 重做 ══ */
console.log('\n[C] 撤销 / 重做快捷键');
{
  await ev(`(() => { const it = document.querySelectorAll('.rail-item')[0]; if (it) it.click(); return true; })()`);
  await sleep(800);
  const target = await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const n = doc.querySelector('h1');
    const r = n.getBoundingClientRect(), rb = root.getBoundingClientRect();
    return { x: r.left - rb.left + r.width/2, y: r.top - rb.top + r.height/2 };
  })()`);
  const st = await ev(`(() => { const r = WD.app.E.stage.el.getBoundingClientRect(); return { left: r.left, top: r.top, scale: WD.app.E.stage.scale }; })()`);
  const p = { x: Math.round(st.left + target.x * st.scale), y: Math.round(st.top + target.y * st.scale) };
  await mouse('mousePressed', p); await mouse('mouseReleased', p);
  await sleep(300);

  const selInfo = await ev(`(() => { const s = WD.app.E.selection || []; return s.length + ' 个: ' + s.map(n=>n.tagName+(typeof n.className==='string'&&n.className?'.'+n.className.split(' ')[0]:'')).join(','); })()`);
  console.log('  当前选中: ' + selInfo);

  /* 用方向键移动 30px，产生一次可撤销的修改 */
  for (let i = 0; i < 3; i++) { await key('ArrowRight', 0); await sleep(80); }
  await sleep(400);
  const posAfter = await ev(`(() => { const doc = WD.app.E.stage.getDoc(); const h = doc.querySelector('h1') || doc.querySelector('h2'); if (!h) return 'no h1'; return Math.round(h.getBoundingClientRect().left); })()`);
  const hist = await ev(`(() => { try { return JSON.stringify(Object.keys(WD.store)); } catch(e) { return 'err ' + e.message; } })()`);
  console.log('  按 3 次 → 后 left = ' + posAfter);
  console.log('  store 字段: ' + hist);

  await key('z', 2);            /* Ctrl+Z */
  await sleep(700);
  const posUndo = await ev(`(() => { const doc = WD.app.E.stage.getDoc(); const h = doc.querySelector('h1') || doc.querySelector('h2'); return h ? Math.round(h.getBoundingClientRect().left) : 'none'; })()`);
  console.log(`  Ctrl+Z 后 left = ${posUndo}` + (posUndo !== posAfter ? '  ✓ 撤销生效' : '  ✗ 无变化'));

  await key('z', 10);           /* Ctrl+Shift+Z */
  await sleep(700);
  const posRedo = await ev(`(() => { const doc = WD.app.E.stage.getDoc(); const h = doc.querySelector('h1') || doc.querySelector('h2'); return h ? Math.round(h.getBoundingClientRect().left) : 'none'; })()`);
  console.log(`  Ctrl+Shift+Z 后 left = ${posRedo}` + (posRedo !== posUndo ? '  ✓ 重做生效' : '  ✗ 无变化'));

  /* 再看历史栈本身 */
  const h2 = await ev(`(() => {
    const s = WD.store;
    return JSON.stringify({ undo: s.history ? s.history.length : 'n/a', canUndo: typeof s.canUndo === 'function' ? s.canUndo() : 'n/a', canRedo: typeof s.canRedo === 'function' ? s.canRedo() : 'n/a' });
  })()`);
  console.log('  历史栈: ' + h2);
}

if (logs.length) { console.log('\n[页面日志]'); for (const l of logs.slice(0, 12)) console.log('  ' + l); }
try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);