/* ============================================================================
   分页识别压力测试
     把 samples/patterns 下每种分页写法的 HTML 用 WizDeck 真正的解析器跑一遍，
     检查：切出几页、每页画布尺寸、识别模式与置信度、以及能否顺利导出 PPTX。
     用法：node tools/pattern-test.mjs <chrome.exe> <port>
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.argv[2];
const PORT = Number(process.argv[3] || 9336);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PATTERN_DIR = 'samples/patterns';
const EXPECT = {
  'reveal-slides.html': { slides: 4, note: '.slides 容器里的一级 <section>' },
  'single-page.html': { slides: 1, note: '无分页标记 → 整篇 1 页' },
  'fixed-pages.html': { slides: 3, note: 'fixed 铺满视口的 .page' },
};

/* ── 极简 CDP 客户端（与 tools/verify.mjs 同源，这里只做解析检查） ────── */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  on(m, fn) {
    if (!this.handlers.has(m)) this.handlers.set(m, []);
    this.handlers.get(m).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 120000);
    });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result.value;
  }
}

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

/* ── 主流程 ──────────────────────────────────────────────────────────── */

const files = fs.readdirSync(PATTERN_DIR).filter((f) => /\.html?$/i.test(f)).sort();
if (!files.length) { console.error('samples/patterns 下没有 HTML'); process.exit(1); }

const ws = new WebSocket(await resolvePageWs(PORT));
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
});
const cdp = new CDP(ws);
const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails || {};
  errors.push((d.exception && d.exception.description) || d.text);
});
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
});

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const url = pathToFileURL(path.resolve('WizDeck.html')).href;
await cdp.send('Page.navigate', { url });
await sleep(2500);

let pass = 0, fail = 0;
console.log('页面'.padEnd(24) + '页数  模式            置信度   画布            导出');
console.log('-'.repeat(92));

for (const f of files) {
  const html = fs.readFileSync(path.join(PATTERN_DIR, f), 'utf8');
  const expr = `(async () => {
    const WD = window.WD;
    const text = ${JSON.stringify(html)};
    try {
      const r = await WD.parse.loadHtml(text, { baseUrl: location.href, onProgress: () => {}, onAssetError: () => {} });
      const sizes = r.slides.map(function (s) {
        var d = new DOMParser().parseFromString(s.doc, 'text/html');
        var root = d.querySelector('[data-wd-root]');
        if (!root) return null;
        return Math.round(parseFloat(root.style.width) || 0) + 'x' + (root.style.height === 'auto' ? 'auto' : Math.round(parseFloat(root.style.height) || 0));
      });
      var uniqSizes = Array.from(new Set(sizes));
      // 用解析结果直接跑一次导出，确认不炸
      var model = { title: r.title, style: r.style, slides: r.slides };
      var exp = await WD.pptx.exportPptx(model, {});
      return {
        ok: true,
        title: r.title,
        slides: r.slides.length,
        mode: r.plan.mode,
        confidence: r.plan.confidence,
        sizes: uniqSizes,
        applied: r.applied,
        missing: r.missing,
        pptxBytes: exp.bytes.length,
        pptxSlides: exp.slides,
        warnings: exp.warnings,
      };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  })()`;

  let res;
  try {
    res = await cdp.eval(expr);
  } catch (e) {
    res = { ok: false, error: e.message };
  }

  const exp = EXPECT[f] || {};
  const wantSlides = exp.slides;
  const canonOk = res.ok && (!wantSlides || res.slides === wantSlides);
  const sizeOk = res.ok && res.sizes.every((s) => s === '1920x1080');
  const exportOk = res.ok && res.pptxSlides === res.slides && res.pptxBytes > 5000;
  const good = canonOk && sizeOk && exportOk;

  const sizeStr = res.ok ? res.sizes.join(',') : '—';
  console.log(
    f.padEnd(24) +
    String(res.ok ? res.slides : 'ERR').padEnd(6) +
    String(res.ok ? res.mode : res.error).slice(0, 15).padEnd(16) +
    String(res.ok ? res.confidence : '—').padEnd(9) +
    sizeStr.padEnd(16) +
    (res.ok ? (res.pptxSlides + '页/' + Math.round(res.pptxBytes / 1024) + 'KB') : '—') +
    (good ? '  ✓' : '  ✗')
  );
  if (!res.ok) console.log('     错误: ' + res.error);
  else if (!good) {
    console.log('     期望页数=' + (wantSlides ?? '?') + ' 实际=' + res.slides +
      ' | 尺寸=' + sizeStr + ' | 导出页数=' + res.pptxSlides +
      (res.warnings && res.warnings.length ? ' | 警告=' + res.warnings.join(';') : ''));
  }
  if (exp.note) console.log('     规则: ' + exp.note);

  good ? pass++ : fail++;
}

console.log('-'.repeat(92));
console.log(`结果: ${pass} 通过 / ${fail} 失败`);

const realErrors = errors.filter((e) => !/Failed to fetch|net::ERR/i.test(e));
if (realErrors.length) {
  console.log('\n控制台错误:');
  realErrors.slice(0, 10).forEach((e) => console.log('  ! ' + String(e).slice(0, 200)));
}

ws.close();
process.exit(fail ? 2 : 0);
