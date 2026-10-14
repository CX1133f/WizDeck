/* 校验 WizDeck 的 CRC32 与 deflate 是否正确：与 zlib.crc32 / Node zlib 的结果对照。
   用法：node tools/crc-check.mjs <port> [outJson] */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9337);
const OUT = process.argv[3] || 'tmp/crc-check.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolvePageWs(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
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
    throw new Error(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 6).join(' | '));
  }
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(path.resolve('WizDeck.html')).href });
await sleep(2500);

/* 1) 纯文本 / 空 / 二进制样例的 CRC 与 deflate 结果 */
const cases = ['', 'a', 'abc', 'hello world', 'x'.repeat(1000), '中文测试'.repeat(50)];
const browser = await ev(`(() => {
  const zip = new WD.pptx.ZipWriter();
  const samples = ${JSON.stringify(cases)};
  return samples.map(function (s) {
    const bytes = new TextEncoder().encode(s);
    return { text: s.slice(0, 12), len: bytes.length, crc: WD.pptx.crc32(bytes) };
  });
})()`);

console.log('样例'.padEnd(16) + '长度'.padEnd(7) + '浏览器 CRC'.padEnd(14) + 'zlib CRC'.padEnd(14) + '一致');
let bad = 0;
browser.forEach((b) => {
  const ref = zlib.crc32 ? zlib.crc32(Buffer.from(b.text.length ? cases.find((c) => c.slice(0, 12) === b.text) : '', 'utf8')) : null;
  console.log(
    String(b.text).padEnd(16) + String(b.len).padEnd(7) +
    ('0x' + b.crc.toString(16)).padEnd(14) +
    (ref === null ? '(无 zlib.crc32)' : ('0x' + ref.toString(16))).padEnd(14) +
    (ref === null ? '?' : (ref === b.crc ? 'OK' : '不一致')) 
  );
  if (ref !== null && ref !== b.crc) bad++;
});

/* 2) 真正导出一次，然后用 Python 侧读取验证每个条目 */
const deck = await ev(`(async () => {
  const WD = window.WD;
  const mk = function (layout, title) {
    return { id: 'x' + Math.random(), name: title, title: title, layout: layout, notes: '',
      doc: WD.parse.blankSlideDoc('', { layout: layout }) };
  };
  const model = { title: 'CRC 自检', style: '', slides: [
    mk('title', '封面'), mk('content', '内容页'), mk('section', '章节页')
  ]};
  const exp = await WD.pptx.exportPptx(model, {});
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < exp.bytes.length; i += CH) bin += String.fromCharCode.apply(null, exp.bytes.subarray(i, i + CH));
  return { b64: btoa(bin), bytes: exp.bytes.length, problems: exp.problems || [] };
})()`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync('tmp/crc-selftest.pptx', Buffer.from(deck.b64, 'base64'));
console.log('\n自检 PPTX 已写出: tmp/crc-selftest.pptx', deck.bytes, '字节');
console.log('导出器自查问题:', deck.problems.length ? JSON.stringify(deck.problems) : '（无）');
if (bad) console.log('\nCRC 计算与 zlib 不一致:', bad, '处');
ws.close();
process.exit(bad ? 2 : 0);
