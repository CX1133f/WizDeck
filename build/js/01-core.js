/* ============================================================================
   智演引擎 / WizDeck — 核心工具层
   ========================================================================== */
(function (global) {
  'use strict';

  var WD = global.WD = global.WD || {};

  /* ── 常量 ────────────────────────────────────────────────────────────── */

  var CANVAS_W = 1920;
  var CANVAS_H = 1080;
  var PX_PER_PT = 96 / 72;      // 96 CSS px = 72 pt
  var EMU_PER_PX = 9525;        // 914400 EMU/inch ÷ 96 px/inch
  var HISTORY_LIMIT = 45;
  var RASTER_SCALE = 2;

  /* ── 基础 ────────────────────────────────────────────────────────────── */

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36).slice(-4) +
           '-' + Math.random().toString(36).slice(2, 8);
  }

  /* 选择器辅助：裸标识符按 id 解析（"frame-box" === "#frame-box"），
     带 . # [ 空格 > 等字符时按标准 CSS 选择器处理。 */
  function looksLikeBareId(sel) {
    return typeof sel === 'string' && /^[A-Za-z][\w-]*$/.test(sel);
  }

  function $(sel, root) {
    var scope = root || document;
    if (looksLikeBareId(sel)) {
      var hit = scope.querySelector('#' + sel);
      if (hit) return hit;
    }
    return scope.querySelector(sel);
  }

  function $$(sel, root) {
    var scope = root || document;
    if (looksLikeBareId(sel)) {
      var hit = scope.querySelectorAll('#' + sel);
      if (hit.length) return Array.prototype.slice.call(hit);
    }
    return Array.prototype.slice.call(scope.querySelectorAll(sel));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') {
          Object.keys(v).forEach(function (p) { node.style.setProperty(p, v[p]); });
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2), v);
        } else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeXml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      /* 控制字符在 XML 1.0 中非法，直接丢弃，避免生成损坏的 PPTX */
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      /* OOXML 中所有 "<" 必须转义（Bento 文档同样强调这一点） */
      .replace(/\u2028|\u2029/g, '');
  }

  /* 把控制字符从纯文本里去掉，但保留换行/制表 */
  function sanitizeText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v, d) { var m = Math.pow(10, d || 0); return Math.round(v * m) / m; }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }

  function raf(fn) { return (global.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(fn); }

  /* ── 颜色 ────────────────────────────────────────────────────────────── */

  var NAMED_COLORS = {
    transparent: 'rgba(0,0,0,0)', white: '#ffffff', black: '#000000',
    red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
    orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
    silver: '#c0c0c0', navy: '#000080', teal: '#008080', olive: '#808000',
    maroon: '#800000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff',
    fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a',
    gold: '#ffd700', ivory: '#fffff0', beige: '#f5f5dc', tan: '#d2b48c'
  };

  /* 解析任意 CSS 颜色 → {r,g,b,a} 或 null */
  function parseColor(input) {
    if (!input) return null;
    var s = String(input).trim().toLowerCase();
    if (!s || s === 'none') return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED_COLORS[s]) return parseColor(NAMED_COLORS[s]);

    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3 || h.length === 4) {
        h = h.split('').map(function (c) { return c + c; }).join('');
      }
      if (h.length !== 6 && h.length !== 8) return null;
      var n = parseInt(h.slice(0, 6), 16);
      if (isNaN(n)) return null;
      var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: a };
    }

    var m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var parts = m[1].split(/[,\s/]+/).filter(function (x) { return x !== ''; });
      if (parts.length < 3) return null;
      function ch(v) {
        v = String(v).trim();
        if (v.slice(-1) === '%') return Math.round(parseFloat(v) / 100 * 255);
        return parseInt(v, 10);
      }
      var r = ch(parts[0]), g = ch(parts[1]), b = ch(parts[2]);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
      var alpha = 1;
      if (parts.length > 3) {
        var av = String(parts[3]).trim();
        alpha = av.slice(-1) === '%' ? parseFloat(av) / 100 : parseFloat(av);
        if (isNaN(alpha)) alpha = 1;
      }
      return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(alpha, 0, 1) };
    }

    var hs = s.match(/^hsla?\(([^)]+)\)$/);
    if (hs) {
      var hp = hs[1].split(/[,\s/]+/).filter(function (x) { return x !== ''; });
      var hh = parseFloat(hp[0]) / 360, ss = parseFloat(hp[1]) / 100, ll = parseFloat(hp[2]) / 100;
      var aa = hp.length > 3 ? (String(hp[3]).slice(-1) === '%' ? parseFloat(hp[3]) / 100 : parseFloat(hp[3])) : 1;
      if (isNaN(hh) || isNaN(ss) || isNaN(ll)) return null;
      var out = hslToRgb(hh, ss, ll);
      out.a = clamp(isNaN(aa) ? 1 : aa, 0, 1);
      return out;
    }
    return null;
  }

  function hslToRgb(h, s, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: 1 };
  }

  function toHex(c) {
    if (!c) return null;
    var h = function (v) { return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'); };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  function toRgbaCss(c) {
    if (!c) return 'rgba(0,0,0,0)';
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + round(c.a, 3) + ')';
  }

  function toHexA(c) {
    if (!c) return null;
    var hex = toHex(c);
    if (c.a >= 0.999) return hex;
    return hex + clamp(Math.round(c.a * 255), 0, 255).toString(16).padStart(2, '0');
  }

  function isOpaque(c) { return !!c && c.a >= 0.999; }
  function isVisibleColor(c) { return !!c && c.a > 0.004; }

  /* 求颜色与白色的对比度，用于决定叠加文字用黑还是白 */
  function luminance(c) {
    if (!c) return 1;
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrastWithWhite(c) { return 1.05 / (luminance(c) + 0.05); }
  function readableInk(bg) {
    if (!bg) return '#1e2a3a';
    return contrastWithWhite(bg) >= 3.2 ? '#ffffff' : '#1e2a3a';
  }

  /* 混合前景到背景上（都是 {r,g,b,a}） */
  function composite(fg, bg) {
    if (!fg) return bg;
    if (!bg || bg.a === 0) return { r: fg.r, g: fg.g, b: fg.b, a: fg.a };
    var a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a),
      g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a),
      b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a),
      a: a
    };
  }

  /* ── 数值解析 ────────────────────────────────────────────────────────── */

  function parsePx(v, fallback) {
    if (v === null || v === undefined || v === '' || v === 'auto' || v === 'normal' || v === 'none') {
      return fallback === undefined ? null : fallback;
    }
    if (typeof v === 'number') return v;
    var s = String(v).trim();
    var m = s.match(/^(-?\d*\.?\d+)\s*(px|pt|em|rem|%|vw|vh)?$/);
    if (!m) return fallback === undefined ? null : fallback;
    var n = parseFloat(m[1]);
    if (isNaN(n)) return fallback === undefined ? null : fallback;
    switch (m[2]) {
      case 'pt': return n * PX_PER_PT;
      case 'em': return n * 16;
      case 'rem': return n * 16;
      default: return n;
    }
  }

  function parseFontWeight(v) {
    if (!v) return 400;
    var s = String(v).trim().toLowerCase();
    if (s === 'normal') return 400;
    if (s === 'bold' || s === 'bolder') return 700;
    if (s === 'lighter') return 300;
    var n = parseInt(s, 10);
    return isNaN(n) ? 400 : clamp(n, 100, 900);
  }

  /* CSS font-weight 数值 → OOXML b / 无（OOXML 只有粗体开关） */
  function isBoldWeight(w) { return w >= 600; }

  /* ── 字体 ────────────────────────────────────────────────────────────── */

  /* 从 font-family 堆栈中挑出第一个具体字体名 */
  function primaryFamily(stack) {
    if (!stack) return '';
    var parts = String(stack).split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim().replace(/^["']|["']$/g, '');
      if (!p) continue;
      if (/^(inherit|initial|unset|revert)$/i.test(p)) continue;
      if (/-apple-system|blinkmacsystemfont|system-ui|ui-sans-serif|ui-serif|sans-serif|serif|monospace|cursive|fantasy/i.test(p)) {
        /* 通用族：映射到跨平台最接近的具体字体，保证 PPT 端可解析 */
        if (/monospace/i.test(p)) return 'Consolas';
        if (/serif/i.test(p) && !/sans-serif/i.test(p)) return 'Georgia';
        return 'Microsoft YaHei';
      }
      return p;
    }
    return '';
  }

  /* 该字体名是否只对西文生效（需要为中文单独指定 eastAsia 字体） */
  function needsEastAsia(fam) {
    return !/[\u4e00-\u9fa5]|PingFang|Hiragino|YaHei|SimSun|SimHei|Hei|Song|Kai|Ming|Source Han|Noto Sans (SC|TC|JP|KR)|Microsoft JhengHei|STHeiti|STSong|STKaiti|FangSong|WenQuanYi|Droid Sans Fallback/i.test(fam || '');
  }

  /* 常见中文字体候选（用于检查器下拉） */
  var CJK_FONTS = [
    'PingFang SC', 'Microsoft YaHei', 'Microsoft JhengHei', 'Source Han Sans SC',
    'Noto Sans SC', 'Hiragino Sans GB', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
    'STHeiti', 'STSong', 'WenQuanYi Micro Hei', 'Arial', 'Helvetica', 'Georgia',
    'Times New Roman', 'Courier New', 'Consolas', 'Roboto'
  ];

  /* ── DOM ────────────────────────────────────────────────────────────── */

  var SKIP_TAGS = {
    HTML: 1, HEAD: 1, BODY: 1, META: 1, LINK: 1, SCRIPT: 1, STYLE: 1,
    TITLE: 1, BR: 1, NOSCRIPT: 1, TEMPLATE: 1, BASE: 1
  };

  function isElement(n) { return !!n && n.nodeType === 1; }
  function isText(n) { return !!n && n.nodeType === 3; }

  function shouldSkip(node) {
    if (!isElement(node)) return true;
    if (SKIP_TAGS[node.tagName]) return true;
    if (node.hasAttribute('data-wd-skip')) return true;
    if (node.getAttribute('aria-hidden') === 'true' && !node.textContent.trim()) return true;
    return false;
  }

  /* 元素自身是否有可见的绘制样式（背景/边框/阴影） */
  function hasOwnPaint(cs) {
    if (!cs) return false;
    var bg = parseColor(cs.backgroundColor);
    if (isVisibleColor(bg)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    if (parsePx(cs.borderTopWidth, 0) > 0 && cs.borderTopStyle !== 'none') return true;
    if (parsePx(cs.borderRightWidth, 0) > 0 && cs.borderRightStyle !== 'none') return true;
    if (parsePx(cs.borderBottomWidth, 0) > 0 && cs.borderBottomStyle !== 'none') return true;
    if (parsePx(cs.borderLeftWidth, 0) > 0 && cs.borderLeftStyle !== 'none') return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    return false;
  }

  function elementLabel(node) {
    if (!isElement(node)) return '';
    var tag = node.tagName.toLowerCase();
    var s = tag;
    if (node.id) s += '#' + node.id;
    var cls = node.getAttribute('class');
    if (cls) {
      var list = cls.trim().split(/\s+/).filter(function (c) { return c && c.indexOf('wd-') !== 0; });
      if (list.length) s += '.' + list.slice(0, 2).join('.');
    }
    return s;
  }

  function describeElement(node) {
    if (!isElement(node)) return '';
    var tag = node.tagName.toLowerCase();
    var FRIENDLY = {
      h1: '大标题', h2: '标题', h3: '小标题', h4: '小标题', h5: '小标题', h6: '小标题',
      p: '段落', div: '容器', span: '文本', section: '区块', article: '区块',
      table: '表格', thead: '表头', tbody: '表体', tr: '表格行', td: '单元格', th: '表头格',
      ul: '列表', ol: '列表', li: '列表项', img: '图片', svg: '矢量图', canvas: '画布',
      header: '页眉', footer: '页脚', nav: '导航', aside: '侧栏', main: '主体',
      blockquote: '引用', figure: '插图', figcaption: '图注', strong: '强调', em: '强调',
      a: '链接', button: '按钮', hr: '分隔线'
    };
    var base = FRIENDLY[tag] || tag;
    if (node.id) return base + ' #' + node.id;
    return base;
  }

  /* ── 几何 ────────────────────────────────────────────────────────────── */

  function rectOf(node, frameWin) {
    var r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function intersectRect(a, b) {
    var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    var x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function unionRect(a, b) {
    if (!a) return b; if (!b) return a;
    var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
    var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  /* ── 二进制 / Base64 ─────────────────────────────────────────────────── */

  function base64ToBytes(b64) {
    var clean = String(b64).replace(/\s+/g, '');
    var bin = global.atob(clean);
    var len = bin.length;
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToBase64(bytes) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return global.btoa(parts.join(''));
  }

  function bytesToText(bytes) {
    if (global.TextDecoder) return new global.TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function textToBytes(str) {
    if (global.TextEncoder) return new global.TextEncoder().encode(str);
    var utf8 = unescape(encodeURIComponent(str));
    var out = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
    return out;
  }

  /* MP4/PNG 之类的魔数嗅探，避免把 data:image 的 MIME 写错 */
  function sniffImageMime(bytes) {
    if (bytes.length > 8) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
      if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
      if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
      var head = '';
      for (var i = 0; i < Math.min(bytes.length, 400); i++) head += String.fromCharCode(bytes[i]);
      if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
    }
    return '';
  }

  /* data URL / Blob / 远程 URL → {bytes, mime} */
  function dataUrlToBytes(dataUrl) {
    var m = String(dataUrl).match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
    if (!m) return null;
    var mime = m[1] || 'application/octet-stream';
    var bytes;
    if (m[2]) {
      try { bytes = base64ToBytes(m[3]); } catch (e) { return null; }
    } else {
      try { bytes = textToBytes(decodeURIComponent(m[3])); } catch (e) { return null; }
    }
    var sniffed = sniffImageMime(bytes);
    if (sniffed) mime = sniffed;
    return { bytes: bytes, mime: mime };
  }

  /* ── 文件下载 ────────────────────────────────────────────────────────── */

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }), filename);
  }

  function downloadBytes(bytes, filename, mime) {
    downloadBlob(new Blob([bytes], { type: mime || 'application/octet-stream' }), filename);
  }

  function safeFileName(name, fallback) {
    var s = String(name || '').replace(/\.(wd\.)?html?$/i, '').trim();
    s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').slice(0, 80);
    return s || (fallback || 'wizdeck');
  }

  /* ── 导出 ────────────────────────────────────────────────────────────── */

  WD.util = {
    uid: uid, $: $, $$: $$, el: el,
    escapeHtml: escapeHtml, escapeXml: escapeXml, sanitizeText: sanitizeText,
    clamp: clamp, round: round, debounce: debounce, raf: raf,
    parseColor: parseColor, toHex: toHex, toHexA: toHexA, toRgbaCss: toRgbaCss,
    hslToRgb: hslToRgb, isOpaque: isOpaque, isVisibleColor: isVisibleColor,
    luminance: luminance, readableInk: readableInk, composite: composite,
    parsePx: parsePx, parseFontWeight: parseFontWeight, isBoldWeight: isBoldWeight,
    primaryFamily: primaryFamily, needsEastAsia: needsEastAsia, CJK_FONTS: CJK_FONTS,
    isElement: isElement, isText: isText, shouldSkip: shouldSkip,
    hasOwnPaint: hasOwnPaint, elementLabel: elementLabel, describeElement: describeElement,
    rectOf: rectOf, intersectRect: intersectRect, unionRect: unionRect, rectsOverlap: rectsOverlap,
    base64ToBytes: base64ToBytes, bytesToBase64: bytesToBase64,
    bytesToText: bytesToText, textToBytes: textToBytes,
    dataUrlToBytes: dataUrlToBytes, sniffImageMime: sniffImageMime,
    downloadBlob: downloadBlob, downloadText: downloadText, downloadBytes: downloadBytes,
    safeFileName: safeFileName,
    CANVAS_W: CANVAS_W, CANVAS_H: CANVAS_H,
    PX_PER_PT: PX_PER_PT, EMU_PER_PX: EMU_PER_PX,
    HISTORY_LIMIT: HISTORY_LIMIT, RASTER_SCALE: RASTER_SCALE
  };

})(typeof window !== 'undefined' ? window : globalThis);
