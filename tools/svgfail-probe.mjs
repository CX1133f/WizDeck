/* 抓 SVG 栅格化失败的真正原因：把生成的 SVG 按 XML 解析，读浏览器的 parsererror
   用法：node tools/svgfail-probe.mjs [chrome.exe] [port] [html] */
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[3] || 9471);
const HTML = process.argv[4] || 'samples/cw_33.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-svg-'));
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

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/') });
await sleep(2800);
await ev(`(async () => { await WD.app.importHtml(${JSON.stringify(fs.readFileSync(path.resolve(HTML), 'utf8'))}); return true; })()`);
await ev(`(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()`);
await sleep(1500);

const res = await ev(`(async () => {
  const out = [];
  for (let i = 0; i < WD.store.count(); i++) {
    const slide = WD.store.slideAt(i);
    const m = await WD.render.mountFrame(slide.doc, { timeout: 20000 });
    const root = WD.render.findRoot(m.doc);
    /* 复刻 buildSvg 的输出 */
    let svg = '';
    try {
      /* 用内部能力拿不到 buildSvg，就自己拼一份等价物：直接拿 cloneWithInlineStyles 的结果不可见，
         所以改为把整段 slide.doc 的 body 塞进 foreignObject 解析，足够暴露 XML 问题 */
      const bodyHtml = m.doc.body.innerHTML;
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">' +
            '<foreignObject x="0" y="0" width="1920" height="1080">' +
            '<div xmlns="http://www.w3.org/1999/xhtml">' + bodyHtml + '</div>' +
            '</foreignObject></svg>';
    } catch (e) { out.push({ i, err: 'build: ' + e.message }); m.frame.remove(); continue; }

    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const perr = doc.querySelector('parsererror');
    const entry = { i, len: svg.length, xmlErr: perr ? (perr.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220) : null };
    if (!perr) {
      /* 再试真正的图片解码 */
      entry.decode = await new Promise((res2) => {
        const img = new Image();
        img.onload = () => res2('ok');
        img.onerror = () => res2('decode-error');
        setTimeout(() => res2('timeout'), 15000);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }
    out.push(entry);
    m.frame.remove();
  }
  return out;
})()`);

console.log('\n逐页 SVG 解析结果（' + HTML + '）\n');
for (const r of res) {
  const tag = '页' + r.i;
  if (r.err) { console.log('  ' + tag + '  ' + r.err); continue; }
  if (r.xmlErr) { console.log('  ' + tag + '  ✗ XML 解析失败: ' + r.xmlErr); }
  else if (r.decode && r.decode !== 'ok') { console.log('  ' + tag + '  ✗ ' + r.decode + '（XML 合法但图片解不开）  svg=' + r.len + ' 字符'); }
  else { console.log('  ' + tag + '  ✓ XML 合法，图片解码 ok  svg=' + r.len + ' 字符'); }
}
try { child.kill(); } catch { /* ignore */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);