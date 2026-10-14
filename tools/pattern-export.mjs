/* 把 samples/patterns 下每个 HTML 用 WizDeck 解析并导出 PPTX，写到 tmp/patterns/。
   用法：node tools/pattern-export.mjs <port> [outDir] */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9336);
const OUT = process.argv[3] || 'tmp/patterns';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 等页面目标就绪（Chromium 刚启动时 /json/list 可能还是空的） */
async function resolvePageWs(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      const made = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      if (made && made.webSocketDebuggerUrl) return made.webSocketDebuggerUrl;
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error('无法连接 Chromium: ' + (lastErr && lastErr.message));
}

const ws = new WebSocket(await resolvePageWs(PORT));
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map();
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
    throw new Error(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 5).join(' | '));
  }
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2500);

fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync('samples/patterns').filter((f) => /\.html?$/i.test(f)).sort();

for (const f of files) {
  const html = fs.readFileSync(path.join('samples/patterns', f), 'utf8');
  const res = await ev(`(async () => {
    const WD = window.WD;
    const r = await WD.parse.loadHtml(${JSON.stringify(html)}, { baseUrl: location.href, onProgress: () => {}, onAssetError: () => {} });
    const model = { title: r.title, style: r.style, slides: r.slides };
    const exp = await WD.pptx.exportPptx(model, {});
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < exp.bytes.length; i += CH) bin += String.fromCharCode.apply(null, exp.bytes.subarray(i, i + CH));
    return { b64: btoa(bin), slides: exp.slides, bytes: exp.bytes.length, size: r.slides.length };
  })()`);
  const name = f.replace(/\.html?$/i, '.pptx');
  fs.writeFileSync(path.join(OUT, name), Buffer.from(res.b64, 'base64'));
  console.log(`${f}  ->  ${name}  (${res.size} 页, ${Math.round(res.bytes / 1024)} KB)`);
}
ws.close();
