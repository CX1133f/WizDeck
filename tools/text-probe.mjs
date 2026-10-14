/* 诊断某一页的文本块收集情况：哪些块被识别、每个块算出几行。
   用法：node tools/text-probe.mjs <port> <fixtureFile> <pageIndex 1-based> */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.argv[2] || 9336);
const FIXTURE = process.argv[3] || 'samples/patterns/reveal-slides.html';
const PAGE = Number(process.argv[4] || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolvePageWs(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      const made = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      if (made && made.webSocketDebuggerUrl) return made.webSocketDebuggerUrl;
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

const html = fs.readFileSync(FIXTURE, 'utf8');
const out = await ev(`(async () => {
  const WD = window.WD;
  const I = WD.pptx._internals;
  const r = await WD.parse.loadHtml(${JSON.stringify(html)}, { baseUrl: location.href, onProgress: () => {}, onAssetError: () => {} });
  const slide = r.slides[${PAGE - 1}];
  const m = await WD.render.mountFrame(slide.doc, { timeout: 15000 });
  const doc = m.doc, win = m.win;
  const blocks = I.collectTextBlocks(doc, win);

  /* 记录解析结果里每页根容器的烘焙几何，用于排查定位异常 */
  const baked = r.slides.map(function (s, si) {
    const d2 = new DOMParser().parseFromString(s.doc, 'text/html');
    const rootEl = d2.querySelector('[data-wd-root]');
    const first = rootEl && rootEl.firstElementChild;
    return {
      page: si + 1,
      rootWH: rootEl ? [rootEl.style.width, rootEl.style.height] : null,
      childTag: first ? first.tagName : null,
      childAttr: first ? String(first.getAttribute('style')).slice(0, 150) : null
    };
  });

  /* 定点诊断：某个选择器命中的元素是否被当成文本块收集，以及能算出几行 */
  const targetSel = ${JSON.stringify(process.argv[5] || '.formula')};
  let target = null;
  if (targetSel) {
    const f = doc.querySelector(targetSel);
    if (f) {
      const fcs = win.getComputedStyle(f);
      const kids = [];
      for (let qi = 0; qi < f.childNodes.length; qi++) {
        const cn = f.childNodes[qi];
        kids.push(cn.nodeType === 3 ? ('#text(' + JSON.stringify(String(cn.nodeValue).slice(0, 24)) + ')') : cn.tagName);
      }
      let fblock = null;
      for (let bi = 0; bi < blocks.length; bi++) if (blocks[bi].node === f) fblock = blocks[bi];
      let lineCount = null, lineTexts = null, err = null, raw = null;
      if (fblock) {
        try {
          const ls = I.textLines(fblock.node, fblock.cs, fblock.box);
          lineCount = ls.length;
          lineTexts = ls.map(function (l) { return String(l.text).slice(0, 30); });
        } catch (e) { err = e.message; }
      }
      /* 逐层拆开 textLines 的内部：行盒、逐字符测量、按行切字 */
      if (fblock) {
        try {
          const rects = WD.render.textRects(fblock.node);
          const doc2 = fblock.node.ownerDocument;
          const walker = doc2.createTreeWalker(fblock.node, NodeFilter.SHOW_TEXT, null);
          let segCount = 0, zeroWidth = 0, textNodes = 0;
          let n;
          while ((n = walker.nextNode())) {
            textNodes++;
            const v = n.nodeValue || '';
            const rng = doc2.createRange();
            for (let ci = 0; ci < v.length; ci++) {
              rng.setStart(n, ci); rng.setEnd(n, ci + 1);
              const rr = rng.getClientRects()[0];
              if (rr && rr.width > 0.01) segCount++; else zeroWidth++;
            }
          }
          raw = {
            textNodeCount: textNodes,
            clientRectCount: rects.length,
            firstRects: rects.slice(0, 4).map(function (r) {
              return [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)];
            }),
            charSegments: segCount,
            zeroWidthChars: zeroWidth,
            nodeTextFirst40: (fblock.node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
          };
        } catch (e) { raw = { err: e.message }; }
      }
      target = {
        sel: targetSel, exists: true,
        textLen: (f.textContent || '').replace(/\\s+/g, '').length,
        childNodes: kids,
        display: fcs.display, visibility: fcs.visibility,
        rect: JSON.stringify(WD.render.boxInFrame(f)),
        inBlocks: !!fblock,
        clientRects: WD.render.textRects(f).length,
        lineCount: lineCount, lineTexts: lineTexts, err: err, raw: raw,
        /* 逐层向上检查：是不是某一层被 shouldSkip 或 display 判掉了 */
        ancestry: (function () {
          var chain = [], n = f, guard = 0;
          while (n && n.nodeType === 1 && guard++ < 8) {
            var cs2 = win.getComputedStyle(n);
            chain.push({
              tag: n.tagName, cls: String(n.className || '').slice(0, 20),
              skip: WD.util.shouldSkip(n),
              display: cs2.display, visibility: cs2.visibility, opacity: cs2.opacity
            });
            if (n === doc.body) break;
            n = n.parentElement;
          }
          return chain;
        })(),
        /* 直接子元素里有几个是块级 */
        blockKids: (function () {
          var out2 = [];
          for (var ci = 0; ci < f.children.length; ci++) {
            var ce = f.children[ci];
            out2.push({ tag: ce.tagName, display: win.getComputedStyle(ce).display });
          }
          return out2;
        })()
      };
    } else {
      target = { sel: targetSel, exists: false };
    }
  }

  const info = blocks.map(function (b) {
    var lines = [];
    try { lines = I.textLines(b.node, b.cs, b.box); } catch (e) { lines = [{ text: 'ERR:' + e.message, box: b.box }]; }
    return {
      tag: b.node.tagName,
      cls: String(b.node.className || '').slice(0, 26),
      text: (b.node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 34),
      box: [Math.round(b.box.x), Math.round(b.box.y), Math.round(b.box.w), Math.round(b.box.h)],
      lineCount: lines.length,
      lines: lines.map(function (l) { return { t: l.text.slice(0, 26), w: Math.round(l.box.w), x: Math.round(l.box.x) }; })
    };
  });

  /* 手工复刻 visit 的判定：从 root 的一级子元素走一层，逐层记录为什么没继续下钻 */
  var walkLog = [];
  /* 顺带检查帧里常见行内元素的 UA 默认 display 是否正常 */
  var inlineProbe = {};
  ['span', 'small', 'em', 'strong', 'a', 'code', 'b', 'i', 'label'].forEach(function (tg) {
    inlineProbe[tg] = win.getComputedStyle(doc.body).display === null ? null : (function () {
      var e = doc.createElement(tg);
      doc.body.appendChild(e);
      var d = win.getComputedStyle(e).display;
      e.remove();
      return d;
    })();
  });
  var root2 = WD.render.findRoot(doc);
  for (var rk = 0; rk < root2.children.length; rk++) {
    var lvl1 = root2.children[rk];
    walkLog.push({ depth: 1, tag: lvl1.tagName, cls: String(lvl1.className || '').slice(0, 20),
      skip: WD.util.shouldSkip(lvl1), display: win.getComputedStyle(lvl1).display });
    for (var ck = 0; ck < lvl1.children.length; ck++) {
      var lvl2 = lvl1.children[ck];
      var kids2 = [];
      for (var kk = 0; kk < lvl2.children.length; kk++) {
        var kc = lvl2.children[kk];
        var kcs = win.getComputedStyle(kc);
        kids2.push({ tag: kc.tagName, display: kcs.display, visibility: kcs.visibility,
          isBlock: !/^(inline|ruby)/.test(kcs.display) });
      }
      walkLog.push({ depth: 2, tag: lvl2.tagName, cls: String(lvl2.className || '').slice(0, 20),
        skip: WD.util.shouldSkip(lvl2), display: win.getComputedStyle(lvl2).display,
        hasBlockChild: kids2.some(function (x) { return x.isBlock && x.visibility !== 'hidden' && x.display !== 'none'; }),
        kids: kids2 });
    }
  }
  m.frame.remove();
  return { slideTitle: slide.title, count: blocks.length, baked: baked, inlineProbe: inlineProbe, target: target, blocks: info };
})()`);
console.log(JSON.stringify(out, null, 1));
ws.close();
