/* ============================================================================
   智演引擎 / WizDeck — 渲染层

   两条独立的路径，各司其职：

   ① 布局路径 —— 每页装进同源 blob: iframe。
      用于：舞台编辑、逐元素测量（getBoundingClientRect）、命中测试、导出时读样式。
      好处：样式表、字体、伪元素、表格等全部由浏览器按原样解析，几何 100% 真实。

   ② 像素路径 —— 把已布局好的子树「计算样式内联」后序列化进 SVG <foreignObject>，
      再当作图片画到 canvas。
      为什么不用 iframe 直接 drawImage：新版 Chromium 已不再为跨文档 iframe
      提供可绘制位图（drawImage 抛 TypeError），foreignObject 是唯一可靠且保真的路子。
      用于：缩略图、导出时的渐变/阴影/滤镜/SVG/变换贴图、整页兜底贴图。
   ========================================================================== */
(function (global) {
  'use strict';

  var WD = global.WD = global.WD || {};
  var U = WD.util;
  var W = U.CANVAS_W, H = U.CANVAS_H;

  /* ══════════════════════════════════════════════════════════════════════
     1. 布局路径：帧文档
     ══════════════════════════════════════════════════════════════════════ */

  var frameSeq = 0;

  /* 帧文档装载方式：一律用 srcdoc。
     实测在 file:// 页面里，blob: iframe 会被当成跨源（没有 --allow-file-access-from-files 时
     contentDocument 为 null），而 srcdoc 帧始终同源，取值稳定。
     帧里不需要执行任何脚本，只需 allow-same-origin 让父页能读布局与样式。 */
  var FRAME_SANDBOX = 'allow-same-origin';

  /* 判断帧是否真的装上了内容。
     直接给 iframe 反复赋 srcdoc 时，load 事件可能在内容解析完成前就触发，
     此时 contentDocument 仍是初始的 about:blank 空文档；不校验就会拿到空页并渲染成空白。
     注意：即使 URL 已经是 about:srcdoc，body 也可能尚未建立，所以 body 必须一起校验。 */
  function frameLoaded(frame, html) {
    var doc = frame.contentDocument;
    if (!doc) return false;
    var body = doc.body;
    if (!body) return false;
    /* 期望有内容却还没有子节点 → 还没装好 */
    if (/data-wd-root|<body[^>]*>\s*\S/i.test(html)) return body.children.length > 0;
    return true;
  }

  function mountFrame(html, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var frame = document.createElement('iframe');
      frame.id = 'wd-frame-' + (++frameSeq);
      frame.setAttribute('data-wd-skip', '');
      frame.setAttribute('sandbox', FRAME_SANDBOX);
      frame.setAttribute('scrolling', 'no');
      /* 离屏帧必须留在视口内：移出视口或 visibility:hidden 都会让浏览器跳过布局/绘制，
         那样 getBoundingClientRect 与 getComputedStyle 就不再可信。 */
      frame.style.cssText =
        'position:fixed;left:0;top:0;width:' + W + 'px;height:' + H + 'px;' +
        'border:0;margin:0;padding:0;background:#fff;opacity:0;' +
        'pointer-events:none;z-index:2147483000;';

      var host = opts.host || document.body;
      var done = false;
      var tries = 0;
      var poll = null;
      var timer = setTimeout(function () { finish(new Error('帧加载超时')); },
        opts.timeout || 25000);

      function cleanupLoad() {
        frame.removeEventListener('load', onLoad);
        if (poll) { clearInterval(poll); poll = null; }
      }

      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanupLoad();
        if (err) {
          try { frame.remove(); } catch (e2) { /* ignore */ }
          reject(err);
          return;
        }
        resolve({ frame: frame, doc: frame.contentDocument, win: frame.contentWindow });
      }

      /* 内容就绪后统一收尾 */
      function ready() {
        if (done) return;
        settle(frame.contentDocument, frame.contentWindow, opts).then(function () { finish(null); });
      }

      function tryAccept() {
        if (done) return true;
        if (!frameLoaded(frame, html)) return false;
        ready();
        return true;
      }

      function onLoad() {
        if (done) return;
        if (tryAccept()) return;
        /* 内容还没落地：轮询等待，必要时重设 srcdoc，最多若干次避免死循环 */
        if (!poll) {
          poll = setInterval(function () {
            if (tryAccept()) return;
            if (++tries > 40) { finish(new Error('帧内容未能装载')); return; }
            if (tries % 10 === 0) frame.srcdoc = html;   /* 重新触发一次装载 */
          }, 25);
        }
      }

      frame.addEventListener('error', function () { finish(new Error('iframe 载入失败')); });
      frame.addEventListener('load', onLoad);

      host.appendChild(frame);
      frame.srcdoc = html;
    });
  }

  /* 等字体、图片与布局稳定 */
  function settle(doc, win, opts) {
    opts = opts || {};
    var jobs = [];

    try {
      if (doc.fonts && doc.fonts.ready) {
        /* 字体加载可能永远不 settle（离线、被拦截），必须限时，否则会拖垮整个导出 */
        jobs.push(Promise.race([
          doc.fonts.ready.catch(function () {}),
          new Promise(function (res) { setTimeout(res, opts.fontTimeout || 4000); })
        ]));
      }
    } catch (e) { /* ignore */ }

    var imgs = Array.prototype.slice.call(doc.images || []);
    imgs.forEach(function (img) {
      if (img.complete) return;
      jobs.push(new Promise(function (res) {
        var t = setTimeout(res, opts.imageTimeout || 8000);
        img.addEventListener('load', function () { clearTimeout(t); res(); }, { once: true });
        img.addEventListener('error', function () { clearTimeout(t); res(); }, { once: true });
      }));
    });

    if (opts.extraDelay) jobs.push(new Promise(function (res) { setTimeout(res, opts.extraDelay); }));
    /* rAF 在后台标签页里压根不触发（浏览器会冻结渲染帧），
       没有兜底的话离屏帧永远「没稳定」，最终只会等到 mountFrame 的超时。 */
    jobs.push(new Promise(function (res) {
      var t = setTimeout(res, 500);
      U.raf(function () { U.raf(function () { clearTimeout(t); res(); }); });
    }));
    return Promise.all(jobs);
  }

  /* 帧内承载内容的根元素 */
  function findRoot(doc) {
    return doc.querySelector('[data-wd-root]') || doc.body;
  }

  function boxInFrame(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function textRects(node) {
    var range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    var list = range.getClientRects();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.width > 0.5 && r.height > 0.5) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }

  function collectBackgroundUrls(doc, win) {
    var out = Object.create(null);
    var nodes = doc.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var cs;
      try { cs = win.getComputedStyle(nodes[i]); } catch (e) { continue; }
      var bi = cs.backgroundImage;
      if (!bi || bi === 'none') continue;
      var re = /url\((['"]?)([^'")]+)\1\)/g, m;
      while ((m = re.exec(bi))) {
        if (!/^data:/.test(m[2])) out[m[2]] = true;
      }
    }
    return Object.keys(out);
  }

  var imageCache = Object.create(null);
  function prefetchImage(url, noCors) {
    if (imageCache[url]) return imageCache[url];
    var p = new Promise(function (resolve, reject) {
      var img = new Image();
      if (!noCors && !/^blob:|^data:/.test(url)) img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片载入失败: ' + url)); };
      img.src = url;
    });
    imageCache[url] = p;
    return p;
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. 像素路径：计算样式内联 → SVG foreignObject → canvas
     ══════════════════════════════════════════════════════════════════════ */

  /* foreignObject 里没有继承上下文，所以从计算样式里带过去 */
  var TRANSFER_PROPS = [
    /* 盒模型与定位 */
    'position', 'left', 'top', 'right', 'bottom', 'width', 'height',
    'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding',
    'box-sizing', 'display', 'overflow',
    /* 弹性 / 网格 */
    'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
    'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items',
    'gap', 'row-gap', 'column-gap',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
    'grid-auto-flow', 'order',
    /* 文字 */
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
    'text-indent', 'text-decoration', 'text-decoration-color', 'text-shadow',
    'white-space', 'word-break', 'overflow-wrap', 'word-wrap', 'vertical-align',
    'direction', 'color', 'text-overflow', 'writing-mode', 'font-feature-settings',
    /* 绘制 */
    'background-color', 'background-image', 'background-size', 'background-position',
    'background-repeat', 'background-clip', 'background-origin', 'background-blend-mode',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow',
    'opacity', 'transform', 'transform-origin', 'transform-style',
    'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path', 'z-index', 'isolation',
    /* 其它 */
    'list-style', 'list-style-type', 'list-style-position', 'object-fit', 'object-position',
    'aspect-ratio', 'float', 'clear', 'caption-side', 'border-collapse', 'border-spacing',
    'table-layout', 'content-visibility'
  ];

  var SKIP_COPY_TAGS = { SCRIPT: 1 };
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* 克隆 node 并把计算样式内联到克隆树上（不修改原 DOM）
     注意：cloneNode(false) 不会复制文本子节点，必须自己把 #text 也搬过去，
     否则整棵树会变成没有文字的骨架。 */
  function cloneWithInlineStyles(node, win, opts) {
    opts = opts || {};
    var exclude = opts.exclude || null;   /* Set：克隆里把这些节点隐藏 */
    var rootRect = node.getBoundingClientRect();

    /* buildSvg 会把 <foreignObject> 放在 box.x / box.y 上，而克隆树的根还带着
       自己的 left/top —— 于是偏移被应用了两次，内容整个落到 foreignObject 之外，
       栅格化出来是一张**全透明**的图（实测三角形 / 平行四边形 / 直线 / 箭头全中）。
       缩略图一直没暴露这个问题：那条路的根元素本来就在 (0,0)。
       所以根克隆一律抹掉 left/top/right/bottom，让它贴在 foreignObject 的原点上。 */
    /* 只抹定位偏移，**保留 position** —— 少了它，克隆树里那些 position:absolute 的后代
       就会改为相对 <foreignObject> 里的那个静态 div 解析，后代又得偏移一次。 */
    var ROOT_SKIP = { left: 1, top: 1, right: 1, bottom: 1 };

    function walk(src, dst, isRoot) {
      var cs = win.getComputedStyle(src);
      var css = '';
      /* 克隆树会被当成 XML 重新解析，而 XML 解析器**不会**像 HTML 那样
         自动把 <svg> 切进 SVG 命名空间 —— 它会继承 <div xmlns="…xhtml"> 的默认命名空间，
         于是 <svg>/<path> 变成两个普通的 XHTML 元素，什么都不画。
         必须在 SVG 元素的源头显式补上 xmlns（子元素靠继承，不必重复写）。

         ⚠ 根节点也要补：导出时「线条」这类元素是把**内层那个 <svg>** 当作待栅格化节点传进来的，
         它就是克隆树的根。曾经只在非根节点上补，结果箭头在 PPTX 里永远是空白。 */
      if (src.namespaceURI === SVG_NS &&
          (!src.parentNode || src.parentNode.namespaceURI !== SVG_NS)) {
        dst.setAttribute('xmlns', SVG_NS);
      }
      for (var i = 0; i < TRANSFER_PROPS.length; i++) {
        var p = TRANSFER_PROPS[i];
        if (isRoot && ROOT_SKIP[p]) continue;
        var v = cs.getPropertyValue(p);
        if (!v) continue;
        /* 跳过默认值，既是体积优化也避免多余属性干扰 */
        if (v === 'none' || v === 'normal' || v === 'auto' || v === '0px' ||
            v === 'rgba(0, 0, 0, 0)' || v === 'static' || v === 'visible' ||
            (p === 'opacity' && v === '1')) {
          continue;
        }
        css += p + ':' + v + ';';
      }
      if (css) dst.setAttribute('style', css);
      if (exclude && exclude.has(src)) dst.style.display = 'none';

      if (src.tagName === 'IMG') {
        dst.removeAttribute('srcset');
        dst.removeAttribute('loading');
        dst.setAttribute('decoding', 'sync');
      }

      while (dst.firstChild) dst.removeChild(dst.firstChild);

      var kids = src.childNodes;
      for (var k = 0; k < kids.length; k++) {
        var child = kids[k];
        if (child.nodeType === 3) {
          dst.appendChild(dst.ownerDocument.createTextNode(child.nodeValue));
        } else if (child.nodeType === 1) {
          if (SKIP_COPY_TAGS[child.tagName]) continue;
          var c = child.cloneNode(false);
          dst.appendChild(c);
          walk(child, c, false);
        }
      }
      return dst;
    }

    var root = node.cloneNode(false);
    walk(node, root, true);
    return { root: root, rect: rootRect };
  }

  /* 组装 SVG 字符串
     background: '#rrggbb' 填底色；null / '' 表示透明底

     ⚠ 这段 HTML 最终被塞进 data:image/svg+xml，浏览器按 **XML** 解析它，
     而 XML 里没有「void 元素」这回事 —— `<br>` / `<img>` / `<hr>` 必须写成 `<br/>`。
     HTML 序列化器不会自闭合它们，于是外层一遇到 `<br>` 就整张图解不开：
     实测一份 10 页课件里，含 `<br>` 的两页缩略图**永久空白**，
     控制台只报一句「SVG 栅格化失败（图片解码错误）」，别的页正常，很难联想到。
     浏览器给的原文是：Opening and ending tag mismatch: br line 12 and p。 */
  var VOID_TAGS = {
    AREA: 1, BASE: 1, BR: 1, COL: 1, EMBED: 1, HR: 1, IMG: 1, INPUT: 1,
    LINK: 1, META: 1, PARAM: 1, SOURCE: 1, TRACK: 1, WBR: 1
  };

  /* 把 void 元素改成自闭合写法。
     注意**不能**用 `el.outerHTML = '<br/>'` 来做：outerHTML 的赋值器是按 HTML 上下文
     重新解析的，`<br/>` 在 HTML 里等价于 `<br>`，改完又变回非自闭合 —— 白改。
     所以只能在**序列化出来的字符串**上做替换。
     属性值里可能带 `>`，正则要能识别引号，避免提前截断。 */
  var VOID_RE = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/gi;

  function selfCloseVoidElements(html) {
    return html.replace(VOID_RE, function (m, tag, attrs) {
      return '<' + tag + attrs + '/>';
    });
  }

  function buildSvg(rootEl, box, opts) {
    opts = opts || {};
    var bg = opts.background;
    var bgRect = '';
    if (bg) {
      bgRect = '<rect x="' + U.round(box.x, 2) + '" y="' + U.round(box.y, 2) +
        '" width="' + Math.round(box.w) + '" height="' + Math.round(box.h) +
        '" fill="' + bg + '"/>';
    }
    var html = selfCloseVoidElements(rootEl.outerHTML);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(box.w) +
      '" height="' + Math.round(box.h) + '" viewBox="' +
      U.round(box.x, 2) + ' ' + U.round(box.y, 2) + ' ' + Math.round(box.w) + ' ' + Math.round(box.h) + '">' +
      bgRect +
      '<foreignObject x="' + U.round(box.x, 2) + '" y="' + U.round(box.y, 2) +
      '" width="' + Math.round(box.w) + '" height="' + Math.round(box.h) + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' + html + '</div>' +
      '</foreignObject></svg>';
  }

  var svgImageCache = Object.create(null);

  /* 缓存键必须是整段 SVG：前缀（SVG 头 + 根元素内联样式）在页与页之间高度相似，
     按前缀截断会直接撞键，导致后面的页面拿到前一页的图片。 */
  function loadSvgImage(svg) {
    var cached = svgImageCache[svg];
    if (cached) return cached;
    var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    var promise = new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('SVG 栅格化失败（图片解码错误）')); };
      setTimeout(function () { reject(new Error('SVG 栅格化超时')); }, 20000);
      img.src = url;
    });
    /* 失败的不缓存，成功的小图才缓存，避免内存无限增长 */
    svgImageCache[svg] = promise;
    promise.catch(function () { delete svgImageCache[svg]; });
    return promise;
  }

  /* 核心：把某个已布局子树渲染成 canvas */
  function rasterizeNode(node, win, opts) {
    opts = opts || {};
    var box = opts.box || boxInFrame(node);
    if (box.w < 1 || box.h < 1) return Promise.resolve(null);

    var cloneInfo;
    try {
      cloneInfo = cloneWithInlineStyles(node, win, { exclude: opts.exclude });
    } catch (e) {
      console.warn('[wizdeck] 内联样式失败', e);
      return Promise.resolve(null);
    }

    var svg = buildSvg(cloneInfo.root, box, { background: opts.background });

    return loadSvgImage(svg).then(function (img) {
      var scale = opts.scale || 1;
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(box.w * scale));
      canvas.height = Math.max(1, Math.round(box.h * scale));
      var ctx = canvas.getContext('2d');
      try {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      } catch (e) {
        console.warn('[wizdeck] canvas 绘制失败', e);
        return null;
      }
      return canvas;
    }).catch(function (e) {
      console.warn('[wizdeck] 栅格化失败:', e.message);
      return null;
    });
  }

  /* 整页栅格化（缩略图 / 导出兜底）

     这里曾经把切片盒子写死成 {0,0,1920,1080}，但根元素的**真实**盒子不一定是那么大：
       · single-body 兜底分页时 buildSlides 会把根高度改成 auto，内容溢出就被切掉；
       · 源页面本来就不是 1920×1080 时（1280×720 之类），根是 1920×1080 而内容缩在左上角。
     写死切片 = 只画出左上角一块，缩略图看着就是「没渲染全」。

     改成量根元素的真实盒子：宽度按调用方给的 width 换算，
     高度跟着等比缩放；量不到（游离节点）才退回画布常量。 */
  function rasterizeRootSlice(root, win, width, opts) {
    opts = opts || {};
    var outW = width || W;
    var bw = W, bh = H;
    if (root && root.getBoundingClientRect) {
      var r = root.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) { bw = r.width; bh = r.height; }
    }
    var scale = outW / bw;
    return rasterizeNode(root, win, {
      box: { x: 0, y: 0, w: bw, h: bh },
      scale: scale,
      background: opts.background === undefined ? '#ffffff' : opts.background
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. 幻灯片缩略图
     ══════════════════════════════════════════════════════════════════════ */

  var thumbCache = Object.create(null);
  var THUMB_WIDTH = 288;

  function thumbKey(slide) {
    var d = slide.doc || '';
    return slide.id + ':' + d.length + ':' + (d.charCodeAt(Math.min(4000, d.length - 1)) || 0);
  }

  function clearThumbs() {
    thumbCache = Object.create(null);
    svgImageCache = Object.create(null);
  }

  function invalidateThumb(slideId) {
    Object.keys(thumbCache).forEach(function (k) {
      if (k.indexOf(slideId + ':') === 0) delete thumbCache[k];
    });
  }

  function thumbnail(slide) {
    var key = thumbKey(slide);
    if (thumbCache[key]) return thumbCache[key];
    var p = mountFrame(slide.doc, { timeout: 15000 })
      .then(function (m) {
        var root = findRoot(m.doc);
        return rasterizeRootSlice(root, m.win, THUMB_WIDTH).then(function (canvas) {
          m.frame.remove();
          return canvas ? canvas.toDataURL('image/png') : null;
        });
      })
      .catch(function (e) {
        console.warn('[wizdeck] 缩略图生成失败', e);
        return null;
      });
    thumbCache[key] = p;
    return p;
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. 舞台
     ══════════════════════════════════════════════════════════════════════ */

  function Stage(opts) {
    this.el = opts.el;
    this.frame = opts.frame;
    this.canvasEl = opts.canvas;
    this.scale = 1;
    this.fitMode = true;
    this.zoom = 1;
    this.url = null;
    this.ready = false;
    this.onReady = opts.onReady || function () {};
    /* 面板折叠 / 展开时由 rAF 逐帧跟随动画，期间锁住其它测量入口，
       否则 ResizeObserver(debounce 120ms)+transitionend 会插入 1–2 次
       中间态 transform 写入，画布出现「二次渲染」跳变。 */
    this._animLock = false;
  }

  Stage.prototype.setHtml = function (html, opts) {
    opts = opts || {};
    var self = this;
    this.ready = false;
    return new Promise(function (resolve) {
      var settled = false;
      function onLoad() {
        if (settled) return;
        settled = true;
        self.frame.removeEventListener('load', onLoad);
        var doc = self.frame.contentDocument;
        if (doc) self.installStillness(doc);
        self.ready = true;
        settle(doc, self.frame.contentWindow, {
          imageTimeout: opts.imageTimeout || 8000
        }).then(function () {
          self.measure();
          self.onReady(self);
          resolve(self);
        });
      }
      self.frame.addEventListener('load', onLoad);
      self.frame.srcdoc = html;
    });
  };

  /* 编辑态冻结动画与过渡，避免测量/拖动时元素还在动 */
  Stage.prototype.installStillness = function (doc) {
    if (!doc || doc.getElementById('wd-still')) return;
    var st = doc.createElement('style');
    st.id = 'wd-still';
    st.setAttribute('data-wd-skip', '');
    st.textContent =
      'html[data-wd-still] *,html[data-wd-still] *::before,html[data-wd-still] *::after{' +
      'animation-play-state:paused !important;transition:none !important;' +
      'animation-delay:0s !important;animation-duration:.001s !important;}';
    (doc.head || doc.documentElement).appendChild(st);
    doc.documentElement.setAttribute('data-wd-still', '');
  };

  Stage.prototype.setStill = function (still) {
    var doc = this.frame.contentDocument;
    if (!doc) return;
    if (still) doc.documentElement.setAttribute('data-wd-still', '');
    else doc.documentElement.removeAttribute('data-wd-still');
  };

  Stage.prototype.measure = function () {
    /* 面板折叠 rAF 循环正在逐帧改写 transform —— 此时任何外部测量入口
       (ResizeObserver debounce / window.resize / transitionend) 插进来都会
       写一个中间态, 造成画布先跳一次再跳到最终值的「二次渲染」抖动。直接跳过。 */
    if (this._animLock) return this.scale;
    var avail = this.canvasEl.getBoundingClientRect();
    return this._applyScale(avail.width, avail.height);
  };

  Stage.prototype._applyScale = function (availW, availH) {
    var fit = Math.min(
      Math.max(80, availW - 56) / W,
      Math.max(60, availH - 56) / H
    );
    var s = U.clamp(this.fitMode ? fit : this.zoom, 0.04, 4);

    /* 幂等：算出来和现在完全一样就什么都不写。
       transform 每次被赋值都会让整块画布（1920×1080 的 iframe）重新栅格化一次。 */
    var tf = 'scale(' + s + ')';
    if (this.scale === s && this.el.style.transform === tf &&
        this.el.style.width === W + 'px' && this.el.style.height === H + 'px') {
      return s;
    }

    this.scale = s;
    this.el.style.width = W + 'px';
    this.el.style.height = H + 'px';
    this.el.style.transform = tf;
    this.el.style.margin = ((H * s - H) / 2) + 'px ' + ((W * s - W) / 2) + 'px';
    /* 选择框与手柄会跟着 .stage 一起缩放，缩小时会细到看不见、小到点不中。
       把缩放倒数暴露成 CSS 变量，让它们 counter-scale 回恒定屏幕尺寸。 */
    this.el.style.setProperty('--wd-inv-zoom', String(1 / s));
    return s;
  };

  Stage.prototype.fit = function () { this.fitMode = true; return this.measure(); };

  Stage.prototype.setZoom = function (z) {
    this.fitMode = false;
    this.zoom = U.clamp(z, 0.1, 3);
    return this.measure();
  };

  Stage.prototype.zoomBy = function (f) {
    return this.setZoom((this.fitMode ? this.scale : this.zoom) * f);
  };

  Stage.prototype.getDoc = function () { return this.frame.contentDocument; };
  Stage.prototype.getWin = function () { return this.frame.contentWindow; };
  Stage.prototype.getRoot = function () {
    var doc = this.getDoc();
    return doc ? findRoot(doc) : null;
  };

  /* srcdoc 帧没有需要回收的对象 URL，保留该方法是给旧调用点一个安全的空实现 */
  Stage.prototype.release = function () { /* no-op */ };

  Stage.prototype.frameToViewport = function (x, y) {
    var r = this.el.getBoundingClientRect();
    return { x: r.left + x * this.scale, y: r.top + y * this.scale };
  };

  WD.render = {
    FRAME_SANDBOX: FRAME_SANDBOX,
    mountFrame: mountFrame,
    settle: settle,
    prefetchImage: prefetchImage,
    collectBackgroundUrls: collectBackgroundUrls,
    cloneWithInlineStyles: cloneWithInlineStyles,
    buildSvg: buildSvg,
    loadSvgImage: loadSvgImage,
    rasterizeNode: rasterizeNode,
    rasterizeRootSlice: rasterizeRootSlice,
    Stage: Stage,
    thumbnail: thumbnail,
    clearThumbs: clearThumbs,
    invalidateThumb: invalidateThumb,
    findRoot: findRoot,
    boxInFrame: boxInFrame,
    textRects: textRects,
    THUMB_WIDTH: THUMB_WIDTH
  };

})(typeof window !== 'undefined' ? window : globalThis);
