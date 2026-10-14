/* 压力测试 ZipWriter：用多种大小/可压缩性的数据打包，写盘后由 Python 校验。
   用法：node tools/zip-stress.mjs <port> [outDir] */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9338);
const OUT = process.argv[3] || 'tmp/zipstress';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolvePageWs(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chromium');
}

const ws = new WebSocket(await resolvePageWs(PORT));
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
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
    throw new Error(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 8).join(' | '));
  }
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2500);

fs.mkdirSync(OUT, { recursive: true });

/* 覆盖面：极小 / 中等 / 超过 64KB（会触发多块 stored）/ 高压缩比 / 随机（不可压缩）/ 含 # 前缀的 PNG */
const plan = [
  { name: 'tiny.bin', kind: 'text', n: 1 },
  { name: 'small.bin', kind: 'text', n: 500 },
  { name: 'mid.bin', kind: 'text', n: 30000 },
  { name: 'over64k.bin', kind: 'text', n: 70000 },
  { name: 'over64k2.bin', kind: 'text', n: 200000 },
  { name: 'random.bin', kind: 'random', n: 12000 },
  { name: 'pnglike.bin', kind: 'pnglike', n: 10251 },
  { name: 'many.bin', kind: 'text', n: 1024 },
];

const files = [];
for (let i = 0; i < 8; i++) {
  for (const p of plan) files.push({ name: 'g' + i + '/' + p.name, kind: p.kind, n: p.n });
}

const res = await ev(`(async () => {
  const plan = ${JSON.stringify(files)};
  function makeBytes(kind, n) {
    const out = new Uint8Array(n);
    if (kind === 'random') {
      for (let i = 0; i < n; i++) out[i] = (Math.random() * 256) | 0;
    } else if (kind === 'pnglike') {
      // 模拟 PNG：固定签名 + 中低熵数据
      const sig = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
      for (let i = 0; i < Math.min(8, n); i++) out[i] = sig[i];
      for (let i = 8; i < n; i++) out[i] = (i * 31 + ((i / 97) | 0)) & 0xff;
    } else {
      const s = 'abcdefghijklmnopqrstuvwxyz0123456789';
      for (let i = 0; i < n; i++) out[i] = s.charCodeAt(i % s.length);
    }
    return out;
  }
  const zip = new WD.pptx.ZipWriter();
  for (let i = 0; i < plan.length; i++) {
    await zip.add(plan[i].name, makeBytes(plan[i].kind, plan[i].n));
  }
  const bytes = zip.build();
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return { b64: btoa(bin), size: bytes.length, entries: zip.entries.length };
})()`);

const outFile = path.join(OUT, 'stress.zip');
fs.writeFileSync(outFile, Buffer.from(res.b64, 'base64'));
console.log('stress.zip:', res.size, '字节,', res.entries, '条目 ->', outFile);

/* 再做一个「图表清单」版本，便于 Python 按名字核对 */
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ size: res.size, entries: res.entries }));
ws.close();
