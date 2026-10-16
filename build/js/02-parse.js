/* ============================================================================
   WizDeck — HTML 解析与幻灯片切分
   ========================================================================== */
(function (global) {
  'use strict';

  var WD = global.WD = global.WD || {};
  var U = WD.util;

  var W = U.CANVAS_W, H = U.CANVAS_H;

  /* ══════════════════════════════════════════════════════════════════════
     1. 素材内联：把外部图片 / 字体 / CSS 引用变成 data URI，保证离线自包含
     ══════════════════════════════════════════════════════════════════════ */

  function isInlineableUrl(url) {
    if (!url) return false;
    var s = String(url).trim();
    if (!s || s === 'none') return false;
    if (/^(data:|blob:|about:|javascript:|#)/i.test(s)) return false;
    return true;
  }

  /* 把任意 URL 变成 data URI；失败返回 null（不阻断解析） */
  function fetchAsDataUrl(url, report) {
    return fetch(url, { mode: 'cors', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(new Error('read failed')); };
          fr.readAsDataURL(blob);
        });
      })
      .catch(function (err) {
        if (report) report(url, err && err.message ? err.message : String(err));
        return null;
      });
  }

  /* 收集文档里所有需要内联的 URL */
  function collectAssetUrls(doc, baseUrl) {
    var found = Object.create(null);
    function add(raw) {
      if (!isInlineableUrl(raw)) return;
      var abs;
      try { abs = new URL(raw, baseUrl).href; } catch (e) { return; }
      if (!isInlineableUrl(abs)) return;
      found[raw] = abs;
    }

    U.$$('img', doc).forEach(function (img) {
      add(img.getAttribute('src'));
      var srcset = img.getAttribute('srcset');
      if (srcset) {
        srcset.split(',').forEach(function (part) {
          var u = part.trim().split(/\s+/)[0];
          if (u) add(u);
        });
      }
    });
    U.$$('source', doc).forEach(function (s) { add(s.getAttribute('src')); add(s.getAttribute('srcset')); });
    U.$$('video', doc).forEach(function (v) { add(v.getAttribute('poster')); });

    var cssTexts = [];
    U.$$('style', doc).forEach(function (s) { cssTexts.push(s.textContent || ''); });
    U.$$('[style]', doc).forEach(function (n) { cssTexts.push(n.getAttribute('style') || ''); });
    cssTexts.forEach(function (css) {
      var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, m;
      while ((m = re.exec(css))) add(m[2]);
    });

    return found;
  }

  /* 用 data URI 映射改写一段 HTML 文本 */
  function applyAssetMap(html, map) {
    if (!map || !Object.keys(map).length) return html;
    var keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
    var out = html;
    keys.forEach(function (from) {
      var to = map[from];
      if (!to) return;
      out = out.split(from).join(to);
      var esc = U.escapeHtml(from);
      if (esc !== from) out = out.split(esc).join(to);
      var esc2 = from.replace(/&/g, '&amp;');
      if (esc2 !== from && esc2 !== esc) out = out.split(esc2).join(to);
    });
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. 解析 HTML 文档
     ══════════════════════════════════════════════════════════════════════ */

  function parseHtml(text, baseUrl) {
    var doc = new DOMParser().parseFromString(text, 'text/html');
    if (!doc || !doc.body) {
      doc = document.implementation.createHTMLDocument('wizdeck');
      doc.body.innerHTML = text;
    }
    var resolvedBase = baseUrl || (global.location && global.location.href) || 'about:blank';
    var baseTag = doc.querySelector('base[href]');
    if (baseTag) {
      try { resolvedBase = new URL(baseTag.getAttribute('href'), resolvedBase).href; } catch (e) { /* ignore */ }
    }
    return { doc: doc, baseUrl: resolvedBase };
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. 幻灯片切分
     ══════════════════════════════════════════════════════════════════════ */

  function classAttr(node) { return (node.getAttribute('class') || '').toLowerCase(); }

  function isSlideHinted(node) {
    if (!U.isElement(node)) return false;
    if (node.hasAttribute('data-wd-slide')) return true;
    var tag = node.tagName.toLowerCase();
    if (tag === 'section' || tag === 'article') return true;
    var cls = classAttr(node);
    if (!cls) return false;
    return /(^|[\s_-])(slide|page|screen|frame|panel|slide-item|slpage)([\s_-]|$)/.test(cls) ||
           /reveal|impress|step|slide-container/.test(cls);
  }

  /* 候选集合的“像不像幻灯片”评分 */
  function scoreCandidates(nodes) {
    if (nodes.length < 2) return -1;
    var widths = [], heights = [], vw = 0, vh = 0;
    nodes.forEach(function (n) {
      var r = n.getBoundingClientRect();
      if (r.width > vw) vw = r.width;
      if (r.height > vh) vh = r.height;
      widths.push(r.width); heights.push(r.height);
    });
    if (vw < 320 || vh < 200) return -1;
    var score = 0;
    var wVar = 0, hVar = 0;
    widths.forEach(function (w) { wVar += Math.abs(w - vw) / vw; });
    heights.forEach(function (h) { hVar += Math.abs(h - vh) / vh; });
    wVar /= widths.length; hVar /= heights.length;
    if (wVar < 0.06) score += 3;
    if (hVar < 0.12) score += 3;
    if (Math.abs(vw / vh - W / H) < 0.25) score += 3;
    if (vw >= 900) score += 1;
    if (vh >= 500) score += 1;
    if (nodes.length >= 2 && nodes.length <= 200) score += 1;
    return score;
  }

  function isFullBleed(node, rootW) {
    var r = node.getBoundingClientRect();
    if (r.width < rootW * 0.7) return false;
    var cs = global.getComputedStyle(node);
    if (cs.position !== 'absolute' && cs.position !== 'fixed' && cs.position !== 'relative') return false;
    return r.height >= 300;
  }

  /* 直接子元素中的“页”候选 */
  function isSlideCandidate(node, bodyW) {
    if (node.hasAttribute('data-wd-slide')) return true;
    if (isSlideHinted(node)) return true;
    return isFullBleed(node, bodyW);
  }

  function splitBody(body, win) {
    win = win || global;
    if (!body) return { nodes: [], mode: 'empty', confidence: 'low' };
    var direct = Array.prototype.filter.call(body.children, function (n) {
      return U.isElement(n) && !U.shouldSkip(n);
    });
    if (!direct.length) return { nodes: [], mode: 'empty', confidence: 'low' };

    /* ① 显式标记 —— 用户说了算 */
    var explicit = direct.filter(function (n) { return n.hasAttribute('data-wd-slide'); });
    if (explicit.length) return { nodes: explicit, mode: 'explicit', confidence: 'high' };

    /* ② reveal.js / impress.js 约定：容器的一级子元素就是页 */
    var framework = direct.filter(function (n) {
      var cls = classAttr(n);
      return /(^|\s)slides(\s|$)/.test(cls) || /(^|\s)impress/.test(cls) ||
             /(^|\s)step(\s|$)/.test(cls) || n.hasAttribute('data-reveal');
    });
    if (framework.length) {
      var inner = [];
      framework.forEach(function (container) {
        Array.prototype.forEach.call(container.children, function (c) {
          if (U.isElement(c) && !U.shouldSkip(c)) inner.push(c);
        });
      });
      if (inner.length) return { nodes: inner, mode: 'framework', confidence: 'high' };
    }

    var bodyW = body.getBoundingClientRect().width ||
      body.ownerDocument.documentElement.getBoundingClientRect().width || W;

    /* ③ 语义 / 类名提示，并用几何一致性打分 */
    var hinted = direct.filter(isSlideHinted);
    if (hinted.length >= 2) {
      var sc = scoreCandidates(hinted);
      if (sc >= 4) return { nodes: hinted, mode: 'hinted', confidence: sc >= 8 ? 'high' : 'medium' };
    }

    /* ④ 全幅绝对定位区块（AI 生成的 1920×1080 课件最常见） */
    var full = direct.filter(function (n) { return isFullBleed(n, bodyW); });
    if (full.length >= 2 && scoreCandidates(full) >= 4) {
      return { nodes: full, mode: 'fullbleed', confidence: 'high' };
    }

    /* ⑤ 统一几何检定 */
    var cand = direct.filter(function (n) { return isSlideCandidate(n, bodyW); });
    if (cand.length >= 2) {
      var sc3 = scoreCandidates(cand);
      if (sc3 >= 4) return { nodes: cand, mode: 'geometric', confidence: sc3 >= 8 ? 'high' : 'medium' };
    }

    /* ⑥ 唯一容器：往里再找一层 */
    if (direct.length === 1) {
      var only = direct[0];
      var grand = Array.prototype.filter.call(only.children, function (n) {
        return U.isElement(n) && !U.shouldSkip(n);
      });
      if (grand.length >= 2) {
        var gHinted = grand.filter(function (n) { return isSlideHinted(n) || isFullBleed(n, bodyW); });
        if (gHinted.length >= 2 && scoreCandidates(gHinted) >= 4) {
          return { nodes: gHinted, mode: 'nested', confidence: 'high' };
        }
        if (scoreCandidates(grand) >= 4) {
          return { nodes: grand, mode: 'nested-generic', confidence: 'medium' };
        }
      }
    }

    /* ⑦ 弱提示 */
    if (hinted.length >= 2) {
      var sc2 = scoreCandidates(hinted);
      if (sc2 >= 1) return { nodes: hinted, mode: 'hinted-weak', confidence: 'low' };
    }

    /* ⑧ 兜底：整篇当作一页 */
    if (direct.length === 1) return { nodes: [direct[0]], mode: 'single', confidence: 'low' };
    return { nodes: [body], mode: 'single-body', confidence: 'low' };
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. 单页自包含文档
     ══════════════════════════════════════════════════════════════════════ */

  function docTitle(doc) {
    var t = doc.querySelector('title');
    return t && t.textContent.trim() ? t.textContent.trim() : '';
  }

  /* 收集 <style> 文本，并尽量把可读的外链样式表内容并进来 */
  function collectStyleText(doc) {
    var out = [];
    U.$$('style', doc).forEach(function (s) { if (s.textContent.trim()) out.push(s.textContent); });
    try {
      var sheets = doc.styleSheets || [];
      for (var i = 0; i < sheets.length; i++) {
        var sh = sheets[i];
        if (sh.ownerNode && sh.ownerNode.tagName === 'STYLE') continue;
        try {
          var rules = sh.cssRules;
          if (!rules) continue;
          var buf = [];
          for (var j = 0; j < rules.length; j++) buf.push(rules[j].cssText);
          if (buf.length) out.push(buf.join('\n'));
        } catch (e) { /* 跨域样式表读不到规则 */ }
      }
    } catch (e) { /* ignore */ }
    return out.join('\n\n');
  }

  var STAGE_BASE_CSS = [
    'html,body{margin:0;padding:0;width:100%;height:100%;}',
    'body{overflow:hidden;}',
    '*{-webkit-tap-highlight-color:transparent;}',
    'img,svg,video{max-width:100%;}',
    '[data-wd-hidden]{display:none !important;}'
  ].join('\n');

  function buildSlideDoc(opts) {
    var title = U.escapeHtml(opts.title || '');
    var style = opts.style || '';
    var bodyHtml = opts.bodyHtml || '';
    return '<!DOCTYPE html>\n<html lang="' + U.escapeHtml(opts.lang || 'zh-CN') + '">\n<head>\n' +
      '<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=' + W + ', initial-scale=1">\n' +
      '<meta name="wizdeck-slide" content="1">\n' +
      '<title>' + title + '</title>\n' +
      '<style data-wd-skip>\n' + STAGE_BASE_CSS + '\n</style>\n' +
      '<style data-wd-skip data-wd-userstyle>\n' + style + '\n</style>\n' +
      '</head>\n<body>\n' + bodyHtml + '\n</body>\n</html>';
  }

  /* ══════════════════════════════════════════════════════════════════════
     5. 载入：HTML → 幻灯片数组
     ══════════════════════════════════════════════════════════════════════ */

  function measureNodes(nodes) {
    return nodes.map(function (n) {
      var r = n.getBoundingClientRect();
      return { node: n, x: r.left, y: r.top, w: r.width, h: r.height };
    });
  }

  /* 把 HTML 装进离屏（但仍可绘制）的 iframe，才能拿到真实几何 */
  function mountMeasure(html) {
    return WD.render.mountFrame(html, { timeout: 25000 });
  }

  function loadHtml(text, opts) {
    opts = opts || {};
    var report = opts.onAssetError || function () {};
    var progress = opts.onProgress || function () {};

    var parsed = parseHtml(text, opts.baseUrl);
    var doc = parsed.doc;
    var title = docTitle(doc);

    progress('正在定位幻灯片…', 0.08);

    /* 先把外链样式表内容并进 <style>，保证离屏帧与最终产物样式一致 */
    var styleText = collectStyleText(doc);
    if (styleText) {
      var merged = doc.createElement('style');
      merged.setAttribute('data-wd-merged', '1');
      merged.textContent = styleText;
      (doc.head || doc.documentElement).appendChild(merged);
    }

    progress('正在内联素材（图片 / 字体）…', 0.18);

    var assetMap = collectAssetUrls(doc, parsed.baseUrl);
    var urls = Object.keys(assetMap);
    var steps = urls.map(function (raw) { return { raw: raw, abs: assetMap[raw] }; });
    var appliedCount = 0;   /* 跨 then 使用，需在外层作用域声明 */

    return chainAll(steps, function (step, i) {
      if (i % 6 === 0) {
        progress('正在内联素材 ' + (i + 1) + '/' + steps.length,
          0.18 + 0.42 * (i / Math.max(1, steps.length)));
      }
      return fetchAsDataUrl(step.abs, report).then(function (dataUrl) {
        return { raw: step.raw, dataUrl: dataUrl };
      });
    }).then(function (results) {
      var resolved = Object.create(null);
      results.forEach(function (r) { if (r && r.dataUrl) resolved[r.raw] = r.dataUrl; });
      appliedCount = Object.keys(resolved).length;

      var mountHtml = doc.documentElement.outerHTML;
      if (!/^<!DOCTYPE/i.test(mountHtml)) mountHtml = '<!DOCTYPE html>\n' + mountHtml;
      if (appliedCount) mountHtml = applyAssetMap(mountHtml, resolved);

      progress('正在测量版面…', 0.66);
      return mountMeasure(mountHtml);
    }).then(function (m) {
      var result;
      try {
        var liveDoc = m.doc;
        var liveWin = m.win;
        if (!liveDoc || !liveDoc.body) throw new Error('帧文档没有可用的 body');

        /* 这类「一次只显示一页」的文档（reveal / Bento 风格），
           未激活的页是 display:none，直接量会得到 0×0，最后被烘焙成零尺寸而整页空白。
           先临时恢复可见再测量，量完立刻还原，保证克隆出来还是原始状态。 */
        var restoreHidden = forceHiddenVisible(liveDoc, liveWin);

        var plan, nodes, boxes;
        try {
          plan = splitBody(liveDoc.body, liveWin);
          nodes = plan.nodes;
          if (!nodes.length) throw new Error('没有在文档里找到任何可用的内容');
          boxes = measureNodes(nodes);
        } finally {
          restoreHidden();
        }

        /* 对还是 0×0 的候选（CSS 无法简单恢复的隐藏方式）单独挂帧测量 */
        return measureIndividually(boxes, progress).then(function (fixedBoxes) {
          progress('正在拆分页面…', 0.82);
          return buildSlides(liveDoc, plan, fixedBoxes, styleText, title, appliedCount, urls, progress);
        });
      } catch (e) {
        try { m.frame.remove(); } catch (e2) { /* ignore */ }
        throw e;
      } finally {
        try { m.frame.remove(); } catch (e3) { /* ignore */ }
      }
    });
  }

  /* 临时让被 display:none / visibility:hidden 收起的页恢复可见，返回还原函数。
     只动内联样式，量完即还原，不会污染最终的页面文档。 */
  function forceHiddenVisible(doc, win) {
    var saved = [];
    var nodes = doc.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var cs;
      try { cs = win.getComputedStyle(nodes[i]); } catch (e) { continue; }
      var hidden = (cs.display === 'none' || cs.visibility === 'hidden');
      if (!hidden) continue;
      /* 跳过编辑器自己的辅助节点 */
      if (U.shouldSkip(nodes[i])) continue;
      saved.push({ node: nodes[i], display: cs.display, visibility: cs.visibility });
      nodes[i].style.setProperty('display', 'block', 'important');
      nodes[i].style.setProperty('visibility', 'visible', 'important');
    }
    void doc.body.offsetHeight;
    return function () {
      saved.forEach(function (s) {
        s.node.style.removeProperty('display');
        s.node.style.removeProperty('visibility');
      });
      void doc.body.offsetHeight;
    };
  }

  /* 对仍然量不出尺寸的候选，逐页单独装帧测量它的真实大小 */
  function measureIndividually(boxes, progress) {
    var todo = [];
    boxes.forEach(function (b, i) {
      if (b.w < 1 || b.h < 1) todo.push(i);
    });
    if (!todo.length) return Promise.resolve(boxes);

    return todo.reduce(function (p, i) {
      return p.then(function () {
        var node = boxes[i].node;
        var html = buildSlideDoc({
          title: 'measure',
          bodyHtml: '<div data-wd-root style="position:relative;width:' + W + 'px;height:' + H +
            'px;overflow:hidden;">' + node.outerHTML + '</div>'
        });
        return mountMeasure(html).then(function (fm) {
          var inner = fm.doc.querySelector('[data-wd-root]').firstElementChild;
          if (inner) {
            var r = inner.getBoundingClientRect();
            if (r.width >= 1 && r.height >= 1) {
              boxes[i].w = r.width;
              boxes[i].h = r.height;
              boxes[i].isolated = true;
            }
          }
          fm.frame.remove();
        });
      });
    }, Promise.resolve()).then(function () { return boxes; });
  }

  /* 依据测量结果生成每一页的自包含文档 */
  function buildSlides(liveDoc, plan, boxes, styleText, title, appliedCount, urls, progress) {
    var slides = [];
    boxes.forEach(function (box, idx) {
      var wrap = liveDoc.createElement('div');
      wrap.setAttribute('data-wd-root', '1');
      wrap.style.cssText = 'position:relative;width:' + W + 'px;height:' + H +
        'px;overflow:hidden;margin:0;padding:0;';

      if (plan.mode === 'single-body' || plan.mode === 'empty') {
        wrap.innerHTML = liveDoc.body.innerHTML;
        wrap.style.height = 'auto';
        wrap.style.minHeight = H + 'px';
      } else {
        var clone = box.node.cloneNode(true);
        bakePosition(clone, box);
        wrap.appendChild(clone);
      }

      var titleGuess = guessSlideTitle(box.node) ||
        ((title || '演示') + ' · 第 ' + (idx + 1) + ' 页');

      slides.push({
        id: U.uid('slide'),
        name: '第 ' + (idx + 1) + ' 页',
        title: titleGuess,
        doc: buildSlideDoc({
          title: titleGuess,
          style: styleText,
          bodyHtml: wrap.outerHTML
        }),
        notes: '',
        layout: idx === 0 ? 'title' : 'content'
      });
    });

    progress('完成', 1);
    return {
      title: title || '未命名演示',
      style: styleText,
      slides: slides,
      plan: plan,
      applied: appliedCount,
      missing: urls.length - appliedCount
    };
  }

  /* 把候选区块烘焙成画布内的绝对定位。
     关键：每页都要锚到「它自己的」左上角。多页文档里各页的自然流位置本来就不同
     （第 2 页 top = 1112px、第 3 页 2224px …），若按某个全局锚点做减法，
     整页仍会停在原位、落到 1080 高的画布之外，渲染出来就是空白页。
     这里用 box 与自身包围盒相减，等价于把该页平移到原点；这样无论候选元素
     在原始文档里位于何处，落到单页文档里都从 (0,0) 开始。

     另外把页面**归一化到画布**：源文档不是 1920×1080 时（1280×720 很常见），
     不缩放的话内容就缩在画布左上角，右边 1/3、下边 1/3 全空 ——
     缩略图只画得出左上角那一块，导出的 PPTX 也是个没铺满版面的形状。
     策略：
       · 宽高比与画布一致 → 等比放大铺满（1280×720 这类同比例的直接填满）
       · 宽高比不同       → 等比缩放到「装得下」再居中留白，绝不拉伸变形

     ⚠ 这里引入了 transform:scale()，它会让页面元素成为后代的**新包含块**，
     于是子元素的 left/top 要用它自己的坐标系。UI 侧的 containingBlock()
     必须同步除以这个缩放比，否则点一下就会跳位。 */
  function bakePosition(clone, box) {
    var st = clone.style;
    st.position = 'absolute';
    st.right = 'auto';
    st.bottom = 'auto';
    st.margin = '0';
    st.maxWidth = 'none';
    st.maxHeight = 'none';
    st.boxSizing = 'border-box';

    var w = box.w > 1 ? box.w : W;
    var h = box.h > 1 ? box.h : H;
    var sx = W / w, sy = H / h;
    var sameAspect = Math.abs(w / h - W / H) <= 0.01 * (W / H);
    var s = sameAspect ? Math.max(sx, sy) : Math.min(sx, sy);

    st.width = U.round(w, 2) + 'px';
    st.height = U.round(h, 2) + 'px';

    if (Math.abs(s - 1) > 0.0005) {
      var prev = (st.transform || '').trim();
      st.transformOrigin = '0 0';
      st.transform = (prev ? prev + ' ' : '') + 'scale(' + U.round(s, 6) + ')';
    }
    /* 不同比例时留边居中；同比例铺满时保持 (0,0) */
    if (!sameAspect) {
      st.left = U.round((W - w * s) / 2, 2) + 'px';
      st.top = U.round((H - h * s) / 2, 2) + 'px';
    } else {
      st.left = '0px';
      st.top = '0px';
    }
  }

  /* 用标题类元素猜一个页名 */
  function guessSlideTitle(node) {
    var h = node.querySelector('h1,h2,h3,[class*=title],[class*=heading]');
    if (h) {
      var t = (h.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 30);
    }
    var t2 = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return t2 ? t2.slice(0, 24) : '';
  }

  /* 顺序执行异步任务，限制并发，避免一次性打爆网络 */
  function chainAll(items, fn, concurrency) {
    var limit = concurrency || 6;
    var results = new Array(items.length);
    var cursor = 0;
    function worker() {
      if (cursor >= items.length) return Promise.resolve();
      var i = cursor++;
      return Promise.resolve(fn(items[i], i)).then(function (r) {
        results[i] = r;
        return worker();
      });
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(worker());
    if (!runners.length) return Promise.resolve(results);
    return Promise.all(runners).then(function () { return results; });
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. 工程文件（.wd.html）读写
     ══════════════════════════════════════════════════════════════════════ */

  var PROJECT_OPEN = '<script type="application/wizdeck+json" id="wizdeck-doc">';
  var PROJECT_CLOSE = '<\/script>';

  /* 工程 JSON 区块 —— 全工程只有这一处生成它。
     type 不是 javascript，浏览器当数据块不执行；WizDeck 靠它无损还原全部页面。
     「保存」与「导出为 HTML」共用这一块，避免同一份课件在文件里存两遍。 */
  function projectJson(model) {
    var payload = {
      format: 'wizdeck',
      version: 1,
      title: model.title,
      createdAt: model.createdAt || new Date().toISOString(),
      style: model.style || '',
      slides: model.slides.map(function (s) {
        return {
          id: s.id, name: s.name, title: s.title, layout: s.layout,
          notes: s.notes || '', doc: s.doc
        };
      })
    };
    /* JSON 里的 "<" 全部转义，避免提前闭合 script 标签 */
    return PROJECT_OPEN + JSON.stringify(payload).replace(/</g, '\\u003c') + PROJECT_CLOSE;
  }

  function serializeProject(model) {
    return '<!--\n  WizDeck 工程文件 / WizDeck project file\n' +
      '  用「智演引擎 WizDeck」打开即可继续编辑，也可以直接当普通 HTML 预览。\n' +
      '  下面 id="wizdeck-doc" 的区块内是可读 JSON（所有 "<" 已转义为 \\u003c）。\n-->\n' +
      '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="generator" content="wizdeck">\n' +
      '<title>' + U.escapeHtml(model.title || 'WizDeck 工程') + '</title>\n' +
      '</head>\n<body>\n' +
      '<div id="wizdeck-runner" data-wd-skip></div>\n' +
      projectJson(model) + '\n' +
      '<script data-wd-skip>\n' +
      '/* 直接用浏览器打开时的简易翻页预览；在 WizDeck 里打开则进入完整编辑。 */\n' +
      '(function(){var d=document.getElementById("wizdeck-doc");if(!d)return;' +
      'var m;try{m=JSON.parse(d.textContent)}catch(e){return}' +
      'var i=0,s=m.slides||[],f=document.createElement("iframe"),r=document.getElementById("wizdeck-runner");' +
      'f.style.cssText="position:fixed;inset:0;width:100vw;height:100vh;border:0;background:#fff";' +
      'r.appendChild(f);function go(n){i=(n+s.length)%s.length;f.srcdoc=s[i].doc;}' +
      'document.addEventListener("keydown",function(e){' +
      'if(e.key==="ArrowRight"||e.key==="PageDown"||e.key===" ")go(i+1);' +
      'if(e.key==="ArrowLeft"||e.key==="PageUp")go(i-1);});' +
      'r.addEventListener("click",function(){go(i+1)});go(0);})();\n' +
      '<\/script>\n' +
      '</body>\n</html>\n';
  }

  /* 兼容层：早期「导出为 HTML」的放映页把全部页只存在脚本里的 var PAGES=[...] 数组中，
     没有 wizdeck-doc 工程区块。这种文件直接走 loadHtml 只能量到 1 页（body 里就一个
     iframe + 翻页条），所以先把那段数组抠出来，还原成完整多页deck。
     数组元素是 JSON.stringify 后再把 < 转成 \u003c 的字面量，JSON.parse 能直接吃。 */
  function parseLegacyViewer(text) {
    var m = String(text || '').match(/var\s+PAGES\s*=\s*(\[[\s\S]*?\])\s*;\s*\n?\s*var\s+W\s*=/);
    if (!m) return null;
    var arr;
    try { arr = JSON.parse(m[1]); } catch (e) { return null; }
    if (!Array.isArray(arr) || arr.length < 2) return null;
    var tm = String(text).match(/<title>([\s\S]*?)<\/title>/i);
    return {
      title: (tm && tm[1] ? tm[1].replace(/&amp;/g, '&').trim() : '') || '未命名演示',
      style: '',
      slides: arr.map(function (doc, i) {
        var d = typeof doc === 'string' ? doc : '';
        return {
          id: U.uid('slide'), name: '第 ' + (i + 1) + ' 页', title: '第 ' + (i + 1) + ' 页',
          layout: i === 0 ? 'title' : 'content', notes: '', doc: d
        };
      })
    };
  }

  function parseProject(text) {
    var re = /<script[^>]*id=["']wizdeck-doc["'][^>]*>([\s\S]*?)<\/script>/i;
    var m = text.match(re);
    if (!m) return null;
    var json;
    try { json = JSON.parse(m[1]); } catch (e) { return null; }
    if (!json || json.format !== 'wizdeck' || !Array.isArray(json.slides)) return null;
    return {
      title: json.title || '未命名演示',
      style: json.style || '',
      createdAt: json.createdAt,
      slides: json.slides.map(function (s, i) {
        return {
          id: s.id || U.uid('slide'),
          name: s.name || ('第 ' + (i + 1) + ' 页'),
          title: s.title || s.name || ('第 ' + (i + 1) + ' 页'),
          layout: s.layout || (i === 0 ? 'title' : 'content'),
          notes: s.notes || '',
          doc: s.doc || buildSlideDoc({ bodyHtml: '' })
        };
      })
    };
  }

  function looksLikeProject(text) { return /id=["']wizdeck-doc["']/.test(text); }

  /* ══════════════════════════════════════════════════════════════════════
     7. 空页工厂
     ══════════════════════════════════════════════════════════════════════ */

  function blankSlideDoc(style, opts) {
    opts = opts || {};
    var kind = opts.layout || 'blank';
    var root = 'position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;';
    var body;
    if (kind === 'title') {
      body = '<div data-wd-root style="' + root + 'background:#1e2a3a;color:#f7f4ec">' +
        '<div style="position:absolute;left:96px;top:392px;width:150px;height:8px;background:#f7a600"></div>' +
        '<h1 style="position:absolute;left:96px;top:440px;margin:0;font-size:104px;font-weight:900;letter-spacing:2px">主标题</h1>' +
        '<p style="position:absolute;left:96px;top:600px;margin:0;font-size:32px;color:#aeb9cc">在这里写副标题</p></div>';
    } else if (kind === 'section') {
      body = '<div data-wd-root style="' + root + 'background:#f7a600;color:#3a2a00">' +
        '<h2 style="position:absolute;left:96px;top:440px;margin:0;font-size:88px;font-weight:900">章节标题</h2></div>';
    } else if (kind === 'content') {
      body = '<div data-wd-root style="' + root + 'background:#faf8f3;color:#1a2233">' +
        '<div style="position:absolute;left:96px;top:92px;font-size:22px;letter-spacing:8px;color:#f7a600;font-weight:700">小节</div>' +
        '<h2 style="position:absolute;left:96px;top:140px;margin:0;font-size:72px;font-weight:900">页面标题</h2>' +
        '<div style="position:absolute;left:96px;top:250px;width:96px;height:6px;background:#5b8def"></div>' +
        '<div style="position:absolute;left:96px;top:320px;right:96px;font-size:30px;line-height:1.9;color:#37455e">在这里补充内容。</div></div>';
    } else {
      body = '<div data-wd-root style="' + root + 'background:#ffffff"></div>';
    }
    return buildSlideDoc({ title: '新页面', style: style || '', bodyHtml: body });
  }

  WD.parse = {
    parseHtml: parseHtml,
    splitBody: splitBody,
    loadHtml: loadHtml,
    buildSlideDoc: buildSlideDoc,
    blankSlideDoc: blankSlideDoc,
    collectStyleText: collectStyleText,
    collectAssetUrls: collectAssetUrls,
    applyAssetMap: applyAssetMap,
    fetchAsDataUrl: fetchAsDataUrl,
    serializeProject: serializeProject,
    projectJson: projectJson,
    parseProject: parseProject,
    parseLegacyViewer: parseLegacyViewer,
    looksLikeProject: looksLikeProject,
    guessSlideTitle: guessSlideTitle,
    STAGE_BASE_CSS: STAGE_BASE_CSS
  };

})(typeof window !== 'undefined' ? window : globalThis);
