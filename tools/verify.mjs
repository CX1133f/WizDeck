/* ============================================================================
   WizDeck 无头验证驱动
     用 Chrome DevTools Protocol 直接驱动本机 Chromium（零依赖）：
       · 打开 WizDeck.html，收集控制台错误
       · 载入示例课件并解析
       · 逐页导出 PPTX，把生成的字节写盘
     用法：node tools/verify.mjs <chrome.exe> <debugPort> <outDir>
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.argv[2];
const PORT = Number(process.argv[3] || 9333);
const OUT_DIR = process.argv[4] || 'tmp/verify';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 极简 CDP 客户端 ─────────────────────────────────────────────────── */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const list = this.handlers.get(msg.method);
        if (list) list.forEach((fn) => fn(msg.params));
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 180000);
    });
  }
  /* 求值：返回 JSON 可序列化结果 */
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面异常: ' + desc);
    }
    return r.result.value;
  }
}

async function resolveWsUrl(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      /* 优先复用已有页面目标；没有就新建一个 */
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      const made = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      if (made && made.webSocketDebuggerUrl) return made.webSocketDebuggerUrl;
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error('无法连接 Chromium 页面目标: ' + (lastErr && lastErr.message));
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const wsUrl = await resolveWsUrl(PORT);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  const cdp = new CDP(ws);
  const consoleErrors = [];
  const consoleLogs = [];

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error') consoleErrors.push(text);
    else consoleLogs.push(p.type + ': ' + text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    consoleErrors.push('未捕获异常: ' + ((d.exception && d.exception.description) || d.text));
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error') consoleErrors.push('[log] ' + e.text);
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  const fileUrl = 'file:///' + path.resolve('WizDeck.html').replace(/\\/g, '/');
  console.log('→ 打开', fileUrl);
  await cdp.send('Page.navigate', { url: fileUrl });
  await sleep(2500);

  /* 1. 基本可用性 */
  const boot = await cdp.eval(`(() => {
    const WD = window.WD;
    return {
      hasWD: !!WD,
      modules: WD ? Object.keys(WD) : [],
      hasApp: !!(WD && WD.app),
      title: document.title,
      shellOk: !!document.getElementById('stage-frame'),
    };
  })()`);
  console.log('→ 启动检查', JSON.stringify(boot));

  /* 2. 载入示例课件 */
  console.log('→ 载入示例课件…');
  const parsed = await cdp.eval(`(async () => {
    const WD = window.WD;
    const res = await fetch('samples/sample-fractions.html');
    const text = await res.text();
    WD.__sampleText = text;
    return { bytes: text.length };
  })()`);
  console.log('   示例文件', parsed.bytes, '字节');

  await cdp.eval(`(() => { WD.app.importHtml(WD.__sampleText, 'sample-fractions.html'); return true; })()`);

  /* 等解析完成（同时把页面里的报错抛出来，避免干等超时） */
  let lastInfo = null;
  const deckInfo = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const info = await cdp.eval(`(() => {
        const s = WD.store;
        return {
          model: !!s.model,
          slides: s.model ? s.model.slides.length : 0,
          stageReady: !!(WD.app.E && WD.app.E.stage && WD.app.E.stage.ready),
          busy: !document.getElementById('busy').hidden,
          busyText: document.getElementById('busy-title').textContent + ' / ' +
                    document.getElementById('busy-sub').textContent,
          toasts: Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent),
          modalOpen: !document.getElementById('modal').hidden,
          modalTitle: document.getElementById('modal-title').textContent,
        };
      })()`);
      if (info.model && info.slides && info.stageReady) {
        const title = await cdp.eval(`(() => WD.store.model.title)()`);
        return { title, slides: info.slides, stageReady: info.stageReady };
      }
      if (info.modalOpen) {
        const detail = await cdp.eval(`(() => document.getElementById('modal-body').textContent)()`);
        throw new Error('页面弹窗：' + info.modalTitle + ' | ' + detail + ' | toasts=' + JSON.stringify(info.toasts));
      }
      lastInfo = info;
      await sleep(400);
    }
    throw new Error('解析超时，最后状态：' + JSON.stringify(lastInfo));
  })();
  console.log('→ 解析结果', JSON.stringify(deckInfo));

  /* 3. 内部几何自检：分页质量 */
  const geom = await cdp.eval(`(() => {
    const WD = window.WD;
    const out = [];
    WD.store.model.slides.forEach((s, i) => {
      const doc = new DOMParser().parseFromString(s.doc, 'text/html');
      const root = doc.querySelector('[data-wd-root]');
      out.push({
        i: i + 1,
        rootW: root ? Math.round(parseFloat(root.style.width)) : null,
        rootH: root ? Math.round(parseFloat(root.style.height)) : null,
        els: doc.querySelectorAll('*').length,
        textLen: (doc.body.textContent || '').replace(/\\s+/g, '').length,
      });
    });
    return out;
  })()`);
  console.log('→ 分页几何');
  geom.forEach((g) => console.log('   ', JSON.stringify(g)));

  /* 4. 导出 PPTX */
  console.log('→ 开始导出 PPTX…');
  const exported = await cdp.eval(`(async () => {
    const WD = window.WD;
    const t0 = performance.now();
    const r = await WD.pptx.exportPptx(WD.store.model, { onProgress: () => {} });
    const bytes = r.bytes;
    // base64 分块，避免超长字符串
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    const b64 = btoa(bin);
    WD.__pptxB64 = b64;
    return {
      b64len: b64.length,
      sizeBytes: bytes.length,
      slides: r.slides,
      files: r.files,
      media: r.media,
      warnings: r.warnings,
      exportMs: Math.round(performance.now() - t0),
    };
  })()`);
  console.log('→ 导出完成', JSON.stringify({ ...exported, b64len: exported.b64len }));

  /* 5. 取回字节 */
  const b64 = await cdp.eval(`(() => { const b = WD.__pptxB64; delete WD.__pptxB64; return b; })()`);
  const outPath = path.join(OUT_DIR, 'wizdeck-export.pptx');
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('→ 已写入', outPath, fs.statSync(outPath).size, '字节');

  /* 6. 导出「浏览器渲染基线」PNG，供与 PPTX 渲染结果做保真度比对 */
  console.log('→ 生成浏览器渲染基线…');
  const pngs = await cdp.eval(`(async () => WD.app.renderSlidePngs(1920))()`);
  const renderDir = path.join(OUT_DIR, 'render');
  fs.mkdirSync(renderDir, { recursive: true });
  pngs.forEach((d, i) => {
    if (!d) { console.log('   slide', i + 1, '渲染失败'); return; }
    const b64 = d.split(',')[1];
    const p = path.join(renderDir, `slide-${i + 1}.png`);
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    console.log('   ', p, fs.statSync(p).size, '字节');
  });

  /* 7. 页面素材统计 */
  const shapeStats = await cdp.eval(`(() => {
    const out = [];
    WD.store.model.slides.forEach((s, i) => {
      out.push({
        i: i + 1,
        gradients: (s.doc.match(/gradient\\(/g) || []).length,
        shadows: (s.doc.match(/box-shadow/g) || []).length,
        radius: (s.doc.match(/border-radius/g) || []).length,
      });
    });
    return out;
  })()`);
  console.log('→ 页面素材统计');
  shapeStats.forEach((g) => console.log('   ', JSON.stringify(g)));

  /* 8. 给编辑器工作台截图，便于目视检查 bento 风格 UI */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(OUT_DIR, 'editor-ui.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('→ 编辑器界面截图:', shotPath, fs.statSync(shotPath).size, '字节');

  /* 9. 编辑器交互自检：选中元素、改样式、撤销 */
  const interact = await cdp.eval(`(async () => {
    const WD = window.WD;
    const E = WD.app.E;
    const doc = E.stage.getDoc();
    const root = WD.render.findRoot(doc);
    // 找第一个有文字的元素，模拟选中并改色
    const target = root.querySelector('h1, h2, h3, p, div');
    const before = target ? target.style.color : null;
    if (target) { target.style.color = 'rgb(255, 0, 0)'; }
    const changed = target ? target.style.color : null;
    // 序列化一次，确认修改会被写回模型
    const html = WD.parse.buildSlideDoc({ bodyHtml: root.outerHTML });
    return {
      found: !!target,
      tag: target ? target.tagName : null,
      before: before,
      changed: changed,
      serialized: html.length,
    };
  })()`);
  console.log('→ 编辑自检', JSON.stringify(interact));

  console.log('\\n=== 控制台错误 ===');
  if (!consoleErrors.length) console.log('（无）');
  else consoleErrors.slice(0, 40).forEach((e) => console.log(' ! ' + e));

  console.log('\\n=== 控制台日志（末 15 条） ===');
  consoleLogs.slice(-15).forEach((e) => console.log('   ' + e));

  ws.close();
  process.exit(consoleErrors.length ? 2 : 0);
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
