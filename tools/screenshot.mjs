/* 干净地截取 WizDeck 工作台界面（不触发任何测试动作），用于目视检查 bento 风格 UI。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 9333);
const OUT = process.argv[3] || 'tmp/verify/editor-ui.png';
const W = Number(process.argv[4] || 1680);
const H = Number(process.argv[5] || 1000);
const LOAD_SAMPLE = process.argv[6] !== 'empty';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2600);

if (LOAD_SAMPLE) {
  await ev(`(async () => {
    const t = await (await fetch('samples/sample-fractions.html')).text();
    WD.app.importHtml(t, 'sample-fractions.html');
    return true;
  })()`);
  for (let i = 0; i < 80; i++) {
    const ok = await ev(`(() => !!(WD.store.model && WD.app.E.stage && WD.app.E.stage.ready))()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(1800);
  /* 选中第 4 页的第一个元素，展示选择框与属性面板 */
  await ev(`(() => {
    const doc = WD.app.E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    const el = root.querySelector('h2, h1, h3, .title, div');
    if (el) {
      WD.app.E.selection = [el];
      WD.app.E.selection[0].scrollIntoView();
    }
    return true;
  })()`);
  /* 用内部 API 画选择框 */
  await ev(`(() => { window.dispatchEvent(new Event('resize')); return true; })()`);
  await sleep(900);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('screenshot ->', OUT, fs.statSync(OUT).size, 'bytes');
ws.close();
