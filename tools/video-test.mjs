/* 插入视频回归。
   重点是封面：原 bug 是「loadeddata 抓第 0 帧」，而实测 MediaRecorder 录出的
   WebM 第 0 帧整幅纯黑（非黑像素 0%），抓到的封面就是一张黑图 ——
   画布、缩略图、导出的 PPTX 全变黑块，看起来「功能做了」，实际是废的。
   这里既验插入链路，也**量像素**验封面不是黑的；
   最后走真实重开路径（blob: 必然失效）确认封面还在。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[3] || 9480);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = pathToFileURL(path.resolve('WizDeck.html')).href;

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
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('ws 失败')), { once: true });
});
let id = 0; const pend = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    pageErrors.push((d.exception && d.exception.description) || d.text);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 60000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result.value;
};

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? '   ' + detail : '')); }
}
/* 量一张 data URI 图片的像素：封面黑不黑、是不是那个红底白 W，只能靠它 */
const PIX_FN = `window.__px = function (url) {
  return new Promise(function (res) {
    if (!url) return res(null);
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      var g = c.getContext('2d'); g.drawImage(img, 0, 0);
      var at = function (x, y) { return Array.prototype.slice.call(g.getImageData(x, y, 1, 1).data, 0, 3); };
      var d = g.getImageData(0, 0, c.width, c.height).data;
      var lit = 0, total = 0;
      for (var i = 0; i < d.length; i += 4 * 13) { total++; if (d[i] + d[i+1] + d[i+2] > 42) lit++; }
      res({ w: img.width, h: img.height, corner: at(6, 6), mid: at(c.width >> 1, c.height >> 1),
            lit: +(lit / total).toFixed(3) });
    };
    img.onerror = function () { res(null); };
    img.src = url;
  });
};`;
const isRed = (p) => !!p && p.corner[0] > 150 && p.corner[1] < 120 && p.corner[2] < 120;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(2600);
await ev(PIX_FN);
await ev('(async () => { await WD.app.loadSample(); return true; })()');
await ev('(async () => { for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if (WD.app.E.stage.ready && WD.store.count()>0) return true;} return false; })()');
await sleep(800);

/* ── [1] 顶栏的视频按钮：点了要真的弹文件选择器 ───────────────── */
console.log('\n[1] 顶栏「视频」按钮');
const btn = await ev(`(() => {
  const b = document.getElementById('btn-insert-video');
  if (!b) return { exists: false };
  const r = b.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { exists: true, visible: r.width > 1 && r.height > 1 && !b.hidden,
           text: b.textContent.replace(/\\s+/g, ''), hittable: b === top || b.contains(top) };
})()`);
check('顶栏存在独立的「视频」按钮', btn.exists === true, JSON.stringify(btn));
check('「视频」按钮可见可点', btn.visible === true && btn.hittable === true, JSON.stringify(btn));
const opened = await ev(`(() => {
  const inp = document.getElementById('video-input');
  if (!inp) return { hasInput: false };
  let hit = 0;
  inp.click = function () { hit++; };
  document.getElementById('btn-insert-video').click();
  return { hasInput: true, accept: inp.getAttribute('accept'), hit };
})()`);
check('背后有 accept="video/*" 的隐藏 input', opened.hasInput === true && /video/.test(opened.accept || ''), JSON.stringify(opened));
check('点按钮确实弹出了文件选择器', opened.hit === 1, 'click 调用 ' + opened.hit + ' 次');

/* ── [2] 插入 + 封面 ──────────────────────────────────────────── */
console.log('\n[2] 插入视频并检查封面');
const ins = await ev(`(async () => {
  /* 造一段红底白 W 的 WebM（只有真视频才测得出「首帧是黑的」这个坑） */
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  const draw = () => { g.fillStyle = '#d0342c'; g.fillRect(0, 0, 320, 180);
                       g.fillStyle = '#fff'; g.font = 'bold 90px sans-serif'; g.fillText('W', 130, 118); };
  draw();
  const rec = new MediaRecorder(c.captureStream(12), { mimeType: 'video/webm' });
  const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(); const t = setInterval(draw, 60);
  await new Promise(r => setTimeout(r, 1100));
  clearInterval(t); rec.stop(); await stopped;

  const dt = new DataTransfer();
  dt.items.add(new File(chunks, 'demo.webm', { type: 'video/webm' }));
  const inp = document.getElementById('video-input');
  inp.click = function () {};
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));

  /* 抓帧可能要往后 seek，等封面连续两轮不再变化 = 抓完了 */
  let last = null, stable = 0;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 120));
    const v = WD.app.E.stage.getDoc().querySelector('[data-wd-added="video"]');
    const p = v ? (v.getAttribute('poster') || '') : '';
    if (p && p === last) { if (++stable >= 2) break; } else { stable = 0; last = p; }
  }
  await new Promise(r => setTimeout(r, 400));

  const v = WD.app.E.stage.getDoc().querySelector('[data-wd-added="video"]');
  if (!v) return { has: false, bytes: chunks.reduce((s, x) => s + x.size, 0) };
  const r = v.getBoundingClientRect();
  const poster = v.getAttribute('poster') || '';
  return {
    has: true, bytes: chunks.reduce((s, x) => s + x.size, 0),
    posterLen: poster.length, px: await window.__px(poster),
    srcBlob: /^blob:/.test(v.getAttribute('src') || ''),
    controls: v.hasAttribute('controls'),
    rect: [Math.round(r.width), Math.round(r.height)],
    selected: (WD.app.E.selection || []).indexOf(v) >= 0,
    dirty: WD.store.dirty,
  };
})()`);
check('视频元素已插入画布', ins.has === true, JSON.stringify({ bytes: ins.bytes }));
check('生成的测试视频有真实体积（' + ins.bytes + ' 字节）', ins.bytes > 2000, String(ins.bytes));
check('带 controls 且 src 是 blob:', ins.controls === true && ins.srcBlob === true, JSON.stringify(ins));
check('画布尺寸 720×405', ins.rect && ins.rect[0] === 720 && ins.rect[1] === 405, JSON.stringify(ins.rect));
check('插入后处于选中状态', ins.selected === true, String(ins.selected));
check('工程标记为「有未保存的修改」', ins.dirty === true, String(ins.dirty));
check('封面已生成（' + ins.posterLen + ' 字节）', ins.posterLen > 800, 'posterLen=' + ins.posterLen);
check('★ 封面不是黑图 ← 曾经的 bug', isRed(ins.px), JSON.stringify(ins.px));
check('★ 封面非黑像素占比足够高', ins.px && ins.px.lit > 0.5, JSON.stringify(ins.px));

/* ── [3] 真实重开：blob: 必然失效，封面必须还在 ───────────────── */
console.log('\n[3] 存盘 → 让 objectURL 作废 → 重新打开工程');
const proj = await ev('WD.parse.serializeProject(WD.store.model)');
check('工程文件里有 video 节点', proj.indexOf('data-wd-added=\\"video\\"') >= 0, '');
check('工程文件里有 poster（封面随工程走）', /poster=\\?"data:image\/jpeg/.test(proj), '');
await send('Page.navigate', { url: 'about:blank' });   /* blob: 到此彻底作废 */
await sleep(1000);
await send('Page.navigate', { url: APP });
await sleep(2600);
await ev(PIX_FN);
await ev('window.__projText = ' + JSON.stringify(proj));
const back = await ev(`(async () => {
  await WD.app.importHtml(window.__projText, 'reopen.wd.html');
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 150));
    const d = WD.app.E.stage.getDoc();
    if (d && d.querySelector('[data-wd-added="video"]')) return true;
  }
  return false;
})()`);
check('重开后视频节点回到画布（版面没塌）', back === true, String(back));
const re = await ev(`(async () => {
  const v = WD.app.E.stage.getDoc().querySelector('[data-wd-added="video"]');
  if (!v) return { has: false };
  const poster = v.getAttribute('poster') || '';
  const r = v.getBoundingClientRect();
  return { has: true, posterLen: poster.length, px: await window.__px(poster),
           errCode: v.error ? v.error.code : 0,
           rect: [Math.round(r.width), Math.round(r.height)] };
})()`);
check('blob: src 如预期失效（error code 4）', re.errCode === 4, 'errCode=' + re.errCode);
check('重开后尺寸仍是 720×405', re.rect && re.rect[0] === 720 && re.rect[1] === 405, JSON.stringify(re.rect));
check('重开后封面数据完好（' + re.posterLen + ' 字节）', re.posterLen > 800, 'posterLen=' + re.posterLen);
check('★ 重开后封面仍是那一帧画面', isRed(re.px), JSON.stringify(re.px));

const full = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync('tmp/video-test.png', Buffer.from(full.data, 'base64'));
console.log('\n  截图: tmp/video-test.png');

console.log('\n通过 ' + pass + '  失败 ' + fail);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
check('控制台零异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
ws.close();
process.exit(0);
