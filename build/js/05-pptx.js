/* ============================================================================
   智演引擎 / WizDeck — PPTX 导出器
     纯浏览器内生成真实 OOXML 包（ZIP + PresentationML），零依赖、零联网。

     分层策略（正确性优先，其次才是可编辑性）：
       · 第 1 层  形状：纯色块、圆角矩形、统一边框、图片 —— 矢量对象
       · 第 2 层  文字：逐个视觉行一个文本框（关闭自动换行，断行位置与浏览器一致）
       · 第 3 层  贴图层：渐变 / 滤镜 / 变换 / SVG / 外阴影 / 半透明 —— 隔离渲染成 PNG
       · 遮挡处理：若贴图层元素盖住了矢量元素（用 elementFromPoint 判定），
                  才把被盖住的矢量元素也写进贴图，保证「所见即所得」；
                  否则优先保留矢量可编辑性。
   ========================================================================== */
(function (global) {
  'use strict';

  var WD = global.WD = global.WD || {};
  var U = WD.util;

  var W = U.CANVAS_W, H = U.CANVAS_H;
  var EMU = U.EMU_PER_PX;                 /* 9525 EMU / CSS px */

  function emu(px) { return Math.round(px * EMU); }
  function pt(px) { return Math.round(px * 75); }   /* CSS px(96dpi) → 百分之一磅 */

  var XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  var NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  var NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  /* ══════════════════════════════════════════════════════════════════════
     1. ZIP 打包器（CRC32 + deflate-raw，无 CompressionStream 时退化为存储）
     ══════════════════════════════════════════════════════════════════════ */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function deflateRaw(bytes) {
    if (typeof global.CompressionStream !== 'function') return Promise.resolve(null);
    try {
      var cs = new global.CompressionStream('deflate-raw');
      var writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Response(cs.readable).arrayBuffer()
        .then(function (buf) { return new Uint8Array(buf); })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* 未压缩条目的载荷就是原始字节本身。
     （曾经错写成「deflate stored 块的帧头 + 原始字节」，那多出来的 5 字节/块
     会让压缩大小与实际数据对不上，于是整份 PPTX 的 CRC 校验失败、
     PowerPoint 会报文件损坏。method=0 时绝对不能带 deflate 帧。） */
  function ZipWriter() { this.entries = []; this.parts = []; this.offset = 0; }

  ZipWriter.prototype.add = function (name, content) {
    var nameBytes = U.textToBytes(name);
    var data = typeof content === 'string' ? U.textToBytes(content) : content;
    var crc = crc32(data);
    var self = this;
    return deflateRaw(data).then(function (compressed) {
      var method, payload;
      if (compressed && compressed.length < data.length) { method = 8; payload = compressed; }
      else { method = 0; payload = data; }

      var header = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(header.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);      /* 文件名 UTF-8 */
      dv.setUint16(8, method, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);       /* 1980-01-01 */
      dv.setUint32(14, crc, true);
      dv.setUint32(18, payload.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      header.set(nameBytes, 30);

      self.entries.push({
        name: nameBytes, crc: crc, method: method,
        compSize: payload.length, rawSize: data.length, offset: self.offset
      });
      self.parts.push(header, payload);
      self.offset += header.length + payload.length;
      return self;
    });
  };

  ZipWriter.prototype.addAll = function (files) {
    var self = this;
    return files.reduce(function (p, f) {
      return p.then(function () { return self.add(f.name, f.data); });
    }, Promise.resolve());
  };

  ZipWriter.prototype.build = function () {
    var cdParts = [], cdSize = 0;
    this.entries.forEach(function (e) {
      var h = new Uint8Array(46 + e.name.length);
      var dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, e.method, true);
      dv.setUint16(12, 0, true);
      dv.setUint16(14, 0x21, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.compSize, true);
      dv.setUint32(24, e.rawSize, true);
      dv.setUint16(28, e.name.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, e.offset, true);
      h.set(e.name, 46);
      cdParts.push(h);
      cdSize += h.length;
    });

    var end = new Uint8Array(22);
    var edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, this.entries.length, true);
    edv.setUint16(10, this.entries.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, this.offset, true);

    var all = this.parts.concat(cdParts, [end]);
    var total = 0;
    all.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var o = 0;
    all.forEach(function (p) { out.set(p, o); o += p.length; });

    /* 自查：回读中央目录，逐条比对「压缩大小 / 原始大小 / CRC」。
       这三者只要有一个对不上，PowerPoint 就会判定文件损坏。
       （曾经因为 method=0 时误带了 deflate 帧头，导致整包 CRC 校验失败。） */
    this.problems = this.verify(out);
    this.builtSize = out.length;
    return out;
  };

  /* 回读并校验刚拼好的 ZIP 字节流 */
  ZipWriter.prototype.verify = function (bytes) {
    var problems = [];
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 0;
    try {
      this.entries.forEach(function (e, i) {
        var sig = dv.getUint32(pos, true);
        if (sig !== 0x04034b50) throw new Error('本地文件头签名错误 @' + pos);
        var method = dv.getUint16(pos + 8, true);
        var crc = dv.getUint32(pos + 14, true);
        var compSize = dv.getUint32(pos + 18, true);
        var rawSize = dv.getUint32(pos + 22, true);
        var nameLen = dv.getUint16(pos + 26, true);
        var extraLen = dv.getUint16(pos + 28, true);
        var dataStart = pos + 30 + nameLen + extraLen;
        var payload = bytes.subarray(dataStart, dataStart + compSize);

        /* 大小必须与登记值一致 */
        if (compSize !== e.compSize) {
          problems.push({ entry: i, reason: '压缩大小不一致', expect: e.compSize, actual: compSize });
        }
        if (rawSize !== e.rawSize) {
          problems.push({ entry: i, reason: '原始大小不一致', expect: e.rawSize, actual: rawSize });
        }
        if (crc !== e.crc) {
          problems.push({ entry: i, reason: '头部 CRC 不一致', expect: e.crc, actual: crc });
        }
        /* 存储模式必须与原始字节完全相同，且 CRC 可复算 */
        if (method === 0) {
          var c = crc32(payload);
          if (c !== crc) problems.push({ entry: i, reason: '存储条目 CRC 校验失败', expect: crc, actual: c });
        }
        pos = dataStart + compSize;
      });
    } catch (err) {
      problems.push({ entry: -1, reason: '结构回读失败: ' + (err && err.message) });
    }
    return problems;
  };

  /* ══════════════════════════════════════════════════════════════════════
     2. DrawingML 小工具
     ══════════════════════════════════════════════════════════════════════ */

  /* OOXML 的 ST_HexColorRGB 只接受 6 位十六进制，不能带 "#"。
     带上 "#" 时部分渲染器（实测 LibreOffice）会把颜色当成黑色，
     于是整页变成黑块——这是必须避免的兼容性陷阱。 */
  function ooxmlHex(color) {
    var h = U.toHex(color) || '000000';
    return h.charAt(0) === '#' ? h.slice(1) : h;
  }

  function colorXml(color, tag, alphaOverride) {
    if (!color) return '';
    var name = tag || 'a:srgbClr';
    var hex = ooxmlHex(color);
    var a = alphaOverride === undefined ? color.a : alphaOverride;
    if (a === undefined || a === null) a = 1;
    if (a >= 0.999) return '<' + name + ' val="' + hex + '"/>';
    return '<' + name + ' val="' + hex + '"><a:alpha val="' +
      Math.round(U.clamp(a, 0, 1) * 100000) + '"/></' + name + '>';
  }

  function solidFill(color, alphaOverride) {
    return '<a:solidFill>' + colorXml(color, 'a:srgbClr', alphaOverride) + '</a:solidFill>';
  }

  function noFill() { return '<a:noFill/>'; }
  function noLine() { return '<a:ln><a:noFill/></a:ln>'; }

  function xfrmXml(x, y, w, h, rot) {
    var r = rot ? ' rot="' + Math.round(rot * 60000) + '"' : '';
    return '<a:xfrm' + r + '><a:off x="' + emu(x) + '" y="' + emu(y) + '"/>' +
      '<a:ext cx="' + emu(Math.max(1, w)) + '" cy="' + emu(Math.max(1, h)) + '"/></a:xfrm>';
  }

  function prstGeom(shape, adj) {
    var adjXml = (adj !== undefined && adj !== null)
      ? '<a:avLst><a:gd name="adj" fmla="val ' + Math.round(U.clamp(adj, 0, 50000)) + '"/></a:avLst>'
      : '<a:avLst/>';
    return '<a:prstGeom prst="' + shape + '">' + adjXml + '</a:prstGeom>';
  }

  function lineXml(color, widthPx, dash) {
    if (!color || !widthPx) return noLine();
    var dashXml = (dash && dash !== 'solid')
      ? '<a:prstDash val="' + (dash === 'dashed' ? 'dash' : dash === 'dotted' ? 'sysDot' : 'solid') + '"/>'
      : '';
    return '<a:ln w="' + emu(Math.max(0.5, widthPx)) + '" cap="flat">' +
      solidFill(color) + dashXml + '</a:ln>';
  }

  function rPrXml(o) {
    var a = ['<a:rPr lang="zh-CN" altLang="en-US"'];
    if (o.sizePx) a.push(' sz="' + pt(o.sizePx) + '"');
    if (o.bold) a.push(' b="1"');
    if (o.italic) a.push(' i="1"');
    if (o.underline) a.push(' u="sng"');
    if (o.letterSpacingPx) a.push(' spc="' + Math.round(o.letterSpacingPx * 0.75 * 100) + '"');
    a.push(' dirty="0">');
    a.push(colorXml(o.color, 'a:srgbClr') || '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>');
    var latin = o.font || 'Arial';
    var ea = o.eastAsia || (U.needsEastAsia(latin) ? 'Microsoft YaHei' : latin);
    a.push('<a:latin typeface="' + U.escapeXml(latin) + '"/>');
    a.push('<a:ea typeface="' + U.escapeXml(ea) + '"/>');
    a.push('<a:cs typeface="' + U.escapeXml(latin) + '"/>');
    a.push('</a:rPr>');
    return a.join('');
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. CSS 解析辅助
     ══════════════════════════════════════════════════════════════════════ */

  function splitTopLevel(str, sep) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function parseBoxShadow(value) {
    if (!value || value === 'none') return null;
    var first = splitTopLevel(value, ',')[0];
    if (!first) return null;
    var m = first.match(/^(inset\s+)?((?:-?[\d.]+(?:px|em|rem)?\s*)+)(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)\s*$/);
    if (!m) {
      m = first.match(/^(inset\s+)?(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)\s+((?:-?[\d.]+(?:px|em|rem)?\s*)+)$/);
      if (!m) return null;
      var l2 = m[3].trim().split(/\s+/).map(function (v) { return U.parsePx(v, 0) || 0; });
      return { inset: !!m[1], color: U.parseColor(m[2]), x: l2[0] || 0, y: l2[1] || 0, blur: l2[2] || 0, spread: l2[3] || 0 };
    }
    var l = m[2].trim().split(/\s+/).map(function (v) { return U.parsePx(v, 0) || 0; });
    return { inset: !!m[1], color: U.parseColor(m[3]), x: l[0] || 0, y: l[1] || 0, blur: l[2] || 0, spread: l[3] || 0 };
  }

  /* 渐变交给贴图处理，但保留解析能力用于诊断/降级 */
  function parseGradient(bgImage) {
    if (!bgImage || bgImage === 'none') return null;
    var linear = bgImage.match(/linear-gradient\(([\s\S]*)\)/i);
    var radial = bgImage.match(/radial-gradient\(([\s\S]*)\)/i);
    if (!linear && !radial) return null;
    var parts = splitTopLevel(linear ? linear[1] : radial[1], ',');
    if (parts.length < 2) return null;
    var angle = 180;
    if (linear) {
      var a = parts[0].match(/^\s*(-?[\d.]+)deg\s*$/);
      if (a) { angle = parseFloat(a[1]); parts.shift(); }
      else if (/^\s*to\s+/i.test(parts[0])) {
        var dir = parts.shift().toLowerCase();
        if (/to\s+top/.test(dir)) angle = 0;
        else if (/to\s+right/.test(dir)) angle = 90;
        else if (/to\s+bottom/.test(dir)) angle = 180;
        else if (/to\s+left/.test(dir)) angle = 270;
      }
      angle = (angle + 90) % 360;
    } else { parts.shift(); angle = 45; }
    var stops = [];
    parts.forEach(function (p, i) {
      var m = p.match(/^(.*?)(?:\s+(-?[\d.]+)(px|%))?\s*$/);
      if (!m) return;
      var col = U.parseColor(m[1].trim());
      if (!col) return;
      var pos = m[2] !== undefined ? parseFloat(m[2]) : NaN;
      if (m[3] === 'px') pos = pos / W;
      if (isNaN(pos)) pos = parts.length > 1 ? i / (parts.length - 1) : 0;
      stops.push({ color: col, pos: U.clamp(pos, 0, 1) });
    });
    return stops.length >= 2 ? { stops: stops, angle: angle } : null;
  }

  function radiusToAdj(cs, w, h) {
    var tl = U.parsePx(cs.borderTopLeftRadius, 0) || 0;
    var tr = U.parsePx(cs.borderTopRightRadius, 0) || 0;
    var br = U.parsePx(cs.borderBottomRightRadius, 0) || 0;
    var bl = U.parsePx(cs.borderBottomLeftRadius, 0) || 0;
    if (!tl && !tr && !br && !bl) return null;
    var minSide = Math.min(w, h);
    if (!minSide) return null;
    var maxR = Math.max(tl, tr, br, bl);
    return U.clamp(maxR / minSide * 100000, 0, 50000);
  }

  function borderInfo(cs) {
    var sides = ['Top', 'Right', 'Bottom', 'Left'];
    var widths = {}, colors = {}, styles = {};
    sides.forEach(function (s) {
      var wv = U.parsePx(cs['border' + s + 'Width'], 0) || 0;
      var sv = cs['border' + s + 'Style'] || 'none';
      var cv = U.parseColor(cs['border' + s + 'Color']);
      if (sv === 'none' || sv === 'hidden' || wv <= 0 || !U.isVisibleColor(cv)) { widths[s] = 0; return; }
      widths[s] = wv; colors[s] = cv; styles[s] = sv;
    });
    var w = [widths.Top, widths.Right, widths.Bottom, widths.Left];
    var uniform = w[0] === w[1] && w[1] === w[2] && w[2] === w[3];
    var colorUniform = true;
    if (uniform && colors.Top) {
      ['Right', 'Bottom', 'Left'].forEach(function (s) {
        var c = colors[s];
        if (!c) return;
        if (c.r !== colors.Top.r || c.g !== colors.Top.g || c.b !== colors.Top.b ||
            Math.abs(c.a - colors.Top.a) > 0.02) colorUniform = false;
      });
    }
    return {
      widths: widths, colors: colors, styles: styles,
      any: w[0] > 0 || w[1] > 0 || w[2] > 0 || w[3] > 0,
      uniform: uniform, colorUniform: colorUniform,
      width: w[0], color: colors.Top, style: styles.Top
    };
  }

  function rotationOf(cs) {
    if (!cs.transform || cs.transform === 'none') return 0;
    var m = cs.transform.match(/matrix\(([^)]+)\)/);
    if (!m) return 0;
    var p = m[1].split(',').map(parseFloat);
    if (p.length < 4) return 0;
    var angle = Math.atan2(p[1], p[0]) * 180 / Math.PI;
    return Math.abs(angle) < 0.2 ? 0 : U.round(angle, 2);
  }

  function isTranslateOnly(cs) {
    if (!cs.transform || cs.transform === 'none') return true;
    var m = cs.transform.match(/^matrix\(([^)]+)\)$/);
    if (!m) return false;
    var p = m[1].split(',').map(parseFloat);
    return p.length === 6 &&
      Math.abs(p[0] - 1) < 0.001 && Math.abs(p[1]) < 0.001 &&
      Math.abs(p[2]) < 0.001 && Math.abs(p[3] - 1) < 0.001;
  }

  /* 该元素是否必须在浏览器里绘制（矢量无法忠实还原） */
  function needsRaster(node, cs, box) {
    var reasons = [];
    var bgImg = cs.backgroundImage;
    if (bgImg && bgImg !== 'none') {
      if (/gradient/i.test(bgImg)) reasons.push('gradient');
      if (/url\(/i.test(bgImg)) {
        var layers = splitTopLevel(bgImg, ',');
        if (layers.length > 1) reasons.push('multi-bg');
        /* 平铺与圆角裁切没法用「一张图片形状」还原，交给贴图。
           其余情况（含 cover / contain / 定位偏移）走矢量图片 + srcRect 裁切：
           既保住清晰度，也不会把元素里的文字一起烘成位图。 */
        var rep = (cs.backgroundRepeat || '').toLowerCase();
        if (rep && rep !== 'no-repeat') reasons.push('bg-repeat');
        if (U.parsePx(cs.borderTopLeftRadius, 0) > 0) reasons.push('bg-radius');
      }
    }
    if (cs.filter && cs.filter !== 'none') reasons.push('filter');
    if (cs.backdropFilter && cs.backdropFilter !== 'none') reasons.push('backdrop');
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') reasons.push('blend');
    if (cs.clipPath && cs.clipPath !== 'none') reasons.push('clip-path');
    if (cs.maskImage && cs.maskImage !== 'none') reasons.push('mask');
    var op = parseFloat(cs.opacity);
    if (!isNaN(op) && op < 0.995) reasons.push('opacity');
    if (!isTranslateOnly(cs)) reasons.push('transform');
    var sh = parseBoxShadow(cs.boxShadow);
    if (sh && sh.inset) reasons.push('shadow-inset');
    if (cs.textShadow && cs.textShadow !== 'none') reasons.push('text-shadow');
    if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') reasons.push('text-clip');
    var tag = node.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'canvas') reasons.push('vector-graphic');
    if (/^(repeating-|conic-)/i.test((bgImg || '').trim())) reasons.push('gradient-exotic');
    return reasons;
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. 页面分析
     ══════════════════════════════════════════════════════════════════════ */

  function directText(node) {
    var s = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === 3) s += node.childNodes[i].nodeValue;
    }
    return s;
  }

  /* 找出所有「可作为一个文本框」的块级元素。
     难点是「混合内容」：一个块里既有裸文本、又有块级子元素，
     例如 <div class="formula">6CO₂ + 6H₂O → C₆H₁₂O₆<small style="display:block">解释</small></div>。
     浏览器会把裸文本包成匿名块盒单独成行，所以这里也要把裸文本单独收成一个文本框，
     再对块级子元素递归 —— 否则这段文字会被直接丢掉。 */
  function collectTextBlocks(doc, win) {
    var root = WD.render.findRoot(doc);
    var blocks = [];

    function blockChildList(node) {
      var out = [];
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (U.shouldSkip(c)) continue;
        var ccs;
        try { ccs = win.getComputedStyle(c); } catch (e) { continue; }
        if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
        if (!/^(inline|ruby)/.test(ccs.display)) out.push(c);
      }
      return out;
    }

    /* 是否有「属于自己的」可见文字（不含子元素里的） */
    function directText(node) {
      var s = '';
      for (var i = 0; i < node.childNodes.length; i++) {
        if (node.childNodes[i].nodeType === 3) s += node.childNodes[i].nodeValue;
      }
      return s.trim();
    }

    function visit(node) {
      if (node.nodeType !== 1) return;
      if (U.shouldSkip(node)) return;
      var cs;
      try { cs = win.getComputedStyle(node); } catch (e) { return; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return;

      var blockChildren = blockChildList(node);

      if (!blockChildren.length) {
        if ((node.textContent || '').trim()) {
          blocks.push({ node: node, cs: cs, box: WD.render.boxInFrame(node) });
        }
        return;
      }

      /* 混合内容：裸文本单独成块（用整块的样式与几何，行盒由 Range 精确给出） */
      if (directText(node)) {
        blocks.push({ node: node, cs: cs, box: WD.render.boxInFrame(node), ownTextOnly: true });
      }
      for (var j = 0; j < blockChildren.length; j++) visit(blockChildren[j]);
    }

    for (var k = 0; k < root.children.length; k++) visit(root.children[k]);
    if (directText(root)) {
      blocks.push({ node: root, cs: win.getComputedStyle(root), box: WD.render.boxInFrame(root), ownTextOnly: true });
    }
    return blocks;
  }

  /* 找出所有有绘制效果的元素（形状 / 图片 / 复杂贴图） */
  function collectPaintBoxes(doc, win) {
    var root = WD.render.findRoot(doc);
    var out = [];

    function visit(node) {
      if (node.nodeType !== 1) return;
      if (U.shouldSkip(node)) return;
      var cs;
      try { cs = win.getComputedStyle(node); } catch (e) { return; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return;

      var box = WD.render.boxInFrame(node);
      var tag = node.tagName.toLowerCase();
      var bgImg = cs.backgroundImage && cs.backgroundImage !== 'none';
      var bgColor = U.isVisibleColor(U.parseColor(cs.backgroundColor));
      var bd = borderInfo(cs);
      var painted = bgImg || bgColor || bd.any || tag === 'img' || tag === 'svg' || tag === 'canvas';

      if (painted && box.w >= 0.6 && box.h >= 0.6) {
        out.push({
          node: node, cs: cs, box: box, tag: tag,
          reasons: needsRaster(node, cs, box),
          bgImage: bgImg, bgColor: bgColor, border: bd
        });
      }
      for (var i = 0; i < node.children.length; i++) visit(node.children[i]);
    }

    /* 根节点自己也要收进来：整页的背景图 / 渐变 / 底色常常就挂在 [data-wd-root] 或 body 上，
       只遍历 children 会让它凭空消失。标记 bgOnly，表示「只画它自己的背景，
       子元素照旧逐个矢量化」—— 绝不能把根节点当复杂元素整页栅格化，否则全篇文字变成一张图。 */
    (function () {
      var rcs;
      try { rcs = win.getComputedStyle(root); } catch (e) { return; }
      if (!rcs || rcs.display === 'none' || rcs.visibility === 'hidden') return;
      var rbgImg = rcs.backgroundImage && rcs.backgroundImage !== 'none';
      var rbgColor = U.isVisibleColor(U.parseColor(rcs.backgroundColor));
      if (!rbgImg && !rbgColor) return;
      out.unshift({
        node: root, cs: rcs, box: { x: 0, y: 0, w: W, h: H }, tag: root.tagName.toLowerCase(),
        reasons: [], bgImage: rbgImg, bgColor: rbgColor, border: { any: false }, bgOnly: true
      });
    })();

    for (var k = 0; k < root.children.length; k++) visit(root.children[k]);
    return out;
  }

  /* 把文本块展开成「按视觉行」的段落 */
  function textLines(node, cs, box) {
    /* ownTextOnly：只量「这一层自己的」文字。
       混合内容里裸文本会被浏览器包成匿名块盒，块级子元素另起一行，
       所以此时必须按裸文本的子节点集合测量，不能把子元素的文字算进来。 */
    var ownOnly = arguments.length > 3 ? arguments[3] : false;
    var rects = ownOnly ? ownTextRects(node) : WD.render.textRects(node);

    if (!rects.length) {
      var t = (ownOnly ? (directTextOf(node)) : (node.textContent || '')).replace(/\s+/g, ' ').trim();
      return t ? [{ text: t, box: box }] : [];
    }
    rects.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    var lines = [];
    rects.forEach(function (r) {
      var last = lines[lines.length - 1];
      if (last && Math.abs(last.y - r.y) < Math.max(3, r.h * 0.45)) {
        last.x2 = Math.max(last.x2, r.x + r.w);
        last.y2 = Math.max(last.y2, r.y + r.h);
        last.x = Math.min(last.x, r.x);
        last.h = Math.max(last.h, r.h);
      } else {
        lines.push({ x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h, h: r.h });
      }
    });

    var fontPx = U.parsePx(cs.fontSize, 16) || 16;
    var gaps = [];
    for (var i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
    gaps = gaps.filter(function (g) { return g > 1; }).sort(function (a, b) { return a - b; });
    var advance = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    var pct = advance > 0 ? U.clamp(advance / fontPx * 100, 60, 320) : 120;

    var texts = extractLineText(node, lines, ownOnly);
    return lines.map(function (l, idx) {
      return {
        text: texts[idx] || '',
        box: { x: l.x, y: l.y, w: Math.max(2, l.x2 - l.x), h: Math.max(l.h, fontPx) },
        lineSpacingPct: pct,
        fontPx: fontPx
      };
    }).filter(function (l) { return l.text !== ''; });
  }

  /* 某一层自己的（直接子）文本内容 */
  function directTextOf(node) {
    var s = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === 3) s += node.childNodes[i].nodeValue;
    }
    return s;
  }

  /* 某一层自己的裸文本所占据的矩形（逐子节点取 Range，跳过元素子节点） */
  function ownTextRects(node) {
    var doc = node.ownerDocument;
    var out = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var n = node.childNodes[i];
      if (n.nodeType !== 3 || !n.nodeValue || !n.nodeValue.trim()) continue;
      var range = doc.createRange();
      range.selectNodeContents(n);
      var list = range.getClientRects();
      for (var k = 0; k < list.length; k++) {
        var r = list[k];
        if (r.width > 0.5 && r.height > 0.5) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    return out;
  }

  /* 逐字符测量，把文字按行盒切回各行。
     ownOnly 时只处理「这一层自己的」文本子节点（混合内容的裸文本段）。 */
  function extractLineText(node, lines, ownOnly) {
    var doc = node.ownerDocument;
    var textNodes = [];
    if (ownOnly) {
      for (var q = 0; q < node.childNodes.length; q++) {
        if (node.childNodes[q].nodeType === 3) textNodes.push(node.childNodes[q]);
      }
    } else {
      var walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      var w;
      while ((w = walker.nextNode())) textNodes.push(w);
    }

    var segments = [];
    textNodes.forEach(function (n) {
      var value = n.nodeValue;
      if (!value) return;
      var range = doc.createRange();
      for (var i = 0; i < value.length; i++) {
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        var r = range.getClientRects()[0];
        if (!r || r.width <= 0.01) {
          if (segments.length) segments[segments.length - 1].ch += value[i];
          continue;
        }
        segments.push({ ch: value[i], x: r.left, y: r.top, w: r.width, h: r.height });
      }
    });
    if (!segments.length) return [];
    var out = new Array(lines.length).fill('');
    segments.forEach(function (seg) {
      var best = 0, bestDist = Infinity;
      for (var i = 0; i < lines.length; i++) {
        var d = Math.abs(seg.y - lines[i].y);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      out[best] += seg.ch;
    });
    return out.map(function (s) { return s.replace(/\s+/g, ' ').trim(); });
  }

  /* 富文本 run（同一行内的多段样式）；ownOnly 时只看自己那层文本 */
  function richRuns(node, cs, ownOnly) {
    var doc = node.ownerDocument;
    var win = doc.defaultView;
    var runs = [];
    var textNodes = [];
    if (ownOnly) {
      for (var q = 0; q < node.childNodes.length; q++) {
        if (node.childNodes[q].nodeType === 3) textNodes.push(node.childNodes[q]);
      }
    } else {
      var walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      var w;
      while ((w = walker.nextNode())) textNodes.push(w);
    }
    textNodes.forEach(function (n) {
      var value = U.sanitizeText(n.nodeValue);
      if (!value.trim()) return;
      var parent = n.parentElement;
      var pcs = cs;
      if (parent) { try { pcs = win.getComputedStyle(parent); } catch (e) { /* keep */ } }
      runs.push({
        text: value.replace(/\s+/g, ' '),
        font: U.primaryFamily(pcs.fontFamily),
        sizePx: U.parsePx(pcs.fontSize, U.parsePx(cs.fontSize, 16)) || 16,
        color: U.parseColor(pcs.color) || U.parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 },
        bold: U.isBoldWeight(U.parseFontWeight(pcs.fontWeight)),
        italic: pcs.fontStyle === 'italic' || pcs.fontStyle === 'oblique',
        underline: /underline/.test(pcs.textDecorationLine || pcs.textDecoration || ''),
        letterSpacingPx: U.parsePx(pcs.letterSpacing, 0) || 0
      });
    });
    var merged = [];
    runs.forEach(function (r) {
      var last = merged[merged.length - 1];
      var same = last && last.font === r.font && last.sizePx === r.sizePx &&
        last.bold === r.bold && last.italic === r.italic &&
        last.color.r === r.color.r && last.color.g === r.color.g && last.color.b === r.color.b;
      if (same) last.text += r.text;
      else merged.push(r);
    });
    return merged;
  }

  /* ══════════════════════════════════════════════════════════════════════
     5. 形状 XML
     ══════════════════════════════════════════════════════════════════════ */

  var shapeIdCounter = 1;
  function nextId() { return ++shapeIdCounter; }

  function shadowEffectXml(sh) {
    if (!sh || sh.inset || !sh.color || !U.isVisibleColor(sh.color)) return '';
    if (sh.blur < 0.5 && sh.spread < 0.5) return '';
    return '<a:effectLst><a:outerShdw blurRad="' + emu(Math.min(sh.blur, 80)) +
      '" dist="' + emu(Math.min(Math.hypot(sh.x, sh.y), 120)) + '" dir="' +
      Math.round(((Math.atan2(sh.y, sh.x) * 180 / Math.PI + 360) % 360) * 60000) +
      '" rotWithShape="0">' + colorXml(sh.color, 'a:srgbClr') + '</a:outerShdw></a:effectLst>';
  }

  function rectShapeXml(id, name, box, fillXml, line, opt) {
    opt = opt || {};
    var adj = (opt.adj !== undefined && opt.adj !== null) ? opt.adj : null;
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + U.escapeXml(name) + '"/>' +
      '<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' +
      xfrmXml(box.x, box.y, box.w, box.h, opt.rot) +
      (adj !== null ? prstGeom('roundRect', adj) : prstGeom('rect')) +
      (fillXml || noFill()) + (line || noLine()) + shadowEffectXml(opt.shadow) +
      '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
  }

  function pictureXml(id, name, box, relId, rot) {
    return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="' + U.escapeXml(name) + '"/>' +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="' + relId + '"/>' +
      '<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>' +
      xfrmXml(box.x, box.y, box.w, box.h, rot) + prstGeom('rect') +
      '</p:spPr></p:pic>';
  }

  /* ── CSS 背景图 → PPTX 图片形状 ───────────────────────────────────────
     CSS 那边有 background-size / -position / -origin / -clip 四个自由度，
     PPTX 这边只有「外框矩形 + srcRect 源裁切」。所以要先算出浏览器真正把图片
     画在了哪块矩形上，再把落在可见区之外的部分换算成裁切比例。
     过去这类背景图只在 cover/contain 时被整块栅格化，其余情况直接消失。 */

  function bgDataUrl(cs) {
    var bi = cs && cs.backgroundImage;
    if (!bi || bi === 'none' || !/url\(/i.test(bi)) return '';
    if (splitTopLevel(bi, ',').length > 1) return '';   /* 多层背景交给贴图 */
    var m = /url\(\s*(['"]?)([^'")]*)\1\s*\)/.exec(bi);
    var u = m ? m[2] : '';
    return /^data:/i.test(u) ? u : '';
  }

  function boxInsetBy(cs, box, which) {
    var b = { x: box.x, y: box.y, w: box.w, h: box.h };
    var props = which === 'content'
      ? [['borderLeftWidth', 'paddingLeft'], ['borderTopWidth', 'paddingTop'],
         ['borderRightWidth', 'paddingRight'], ['borderBottomWidth', 'paddingBottom']]
      : [['borderLeftWidth'], ['borderTopWidth'], ['borderRightWidth'], ['borderBottomWidth']];
    var l = 0, t = 0, r = 0, bt = 0;
    props.forEach(function (p, i) {
      var v = 0;
      p.forEach(function (k) { v += U.parsePx(cs[k], 0) || 0; });
      if (i === 0) l = v; else if (i === 1) t = v; else if (i === 2) r = v; else bt = v;
    });
    b.x += l; b.y += t;
    b.w = Math.max(0, b.w - l - r);
    b.h = Math.max(0, b.h - t - bt);
    return b;
  }

  function bgKeyword(v, isStart) {
    switch (String(v || '').toLowerCase()) {
      case 'left': case 'top': return '0%';
      case 'right': case 'bottom': return '100%';
      case 'center': return '50%';
      default: return v || (isStart ? '0%' : '50%');
    }
  }

  function bgDrawnSize(cs, ref, natW, natH) {
    var bs = String(cs.backgroundSize || 'auto').trim().toLowerCase();
    if (!bs || bs === 'auto') return { w: natW, h: natH };
    if (/^cover/.test(bs)) {
      var s = Math.max(ref.w / natW, ref.h / natH);
      return { w: natW * s, h: natH * s };
    }
    if (/^contain/.test(bs)) {
      var s2 = Math.min(ref.w / natW, ref.h / natH);
      return { w: natW * s2, h: natH * s2 };
    }
    function dim(v, base) {
      if (!v || v === 'auto') return null;
      if (/%$/.test(v)) { var f = parseFloat(v); return isNaN(f) ? null : base * f / 100; }
      var px = U.parsePx(v, NaN);
      return (px === null || isNaN(px)) ? null : px;
    }
    var parts = bs.split(/\s+/);
    var w = dim(parts[0], ref.w);
    var h = parts.length > 1 ? dim(parts[1], ref.h) : null;
    if (w === null && h === null) return { w: natW, h: natH };
    if (w === null) w = natW * h / natH;
    if (h === null) h = natH * w / natW;
    return { w: w, h: h };
  }

  function bgPlacement(cs, box, natW, natH) {
    if (!natW || !natH || box.w < 0.5 || box.h < 0.5) return null;
    var origin = (cs.backgroundOrigin || 'padding-box').toLowerCase();
    var ref = origin === 'border-box' ? box
      : boxInsetBy(cs, box, origin === 'content-box' ? 'content' : 'padding');
    var clipProp = (cs.backgroundClip || 'border-box').toLowerCase();
    var clip = clipProp === 'border-box' ? box
      : boxInsetBy(cs, box, clipProp === 'content-box' ? 'content' : 'padding');
    if (ref.w < 0.5 || ref.h < 0.5 || clip.w < 0.5 || clip.h < 0.5) return null;

    var d = bgDrawnSize(cs, ref, natW, natH);
    if (!(d.w > 0) || !(d.h > 0)) return null;

    var bp = String(cs.backgroundPosition || '0% 0%').trim().split(/\s+/);
    function off(v, base, drawn) {
      if (/%$/.test(v)) { var f = parseFloat(v); return isNaN(f) ? 0 : (base - drawn) * f / 100; }
      var px = U.parsePx(v, NaN);
      return (px === null || isNaN(px)) ? 0 : px;
    }
    var ox = off(bgKeyword(bp[0], true), ref.w, d.w);
    var oy = off(bgKeyword(bp[1], false), ref.h, d.h);

    var x = ref.x + ox, y = ref.y + oy;
    var ix = Math.max(x, clip.x), iy = Math.max(y, clip.y);
    var ix2 = Math.min(x + d.w, clip.x + clip.w), iy2 = Math.min(y + d.h, clip.y + clip.h);
    if (ix2 - ix < 0.5 || iy2 - iy < 0.5) return null;

    function thou(v) { return Math.round(U.clamp(v, 0, 1) * 100000); }
    return {
      x: ix, y: iy, w: ix2 - ix, h: iy2 - iy,
      src: {
        l: thou((ix - x) / d.w), t: thou((iy - y) / d.h),
        r: thou((x + d.w - ix2) / d.w), b: thou((y + d.h - iy2) / d.h)
      }
    };
  }

  function bgPictureXml(id, name, p, relId) {
    var s = p.src;
    return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="' + U.escapeXml(name) + '"/>' +
      '<p:cNvPicPr><a:picLocks/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="' + relId + '"/>' +
      '<a:srcRect l="' + s.l + '" t="' + s.t + '" r="' + s.r + '" b="' + s.b + '"/>' +
      '<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>' +
      xfrmXml(p.x, p.y, p.w, p.h) + prstGeom('rect') +
      '</p:spPr></p:pic>';
  }

  /* 背景图裁切要用到图片原始尺寸，统一预取一次（同一张图只取一次） */
  function prefetchBgSizes(items) {
    var urls = [], seen = Object.create(null);
    items.forEach(function (item) {
      var u = bgDataUrl(item.cs);
      if (u && !seen[u]) { seen[u] = true; urls.push(u); }
    });
    var out = Object.create(null);
    if (!urls.length) return Promise.resolve(out);
    return Promise.all(urls.map(function (u) {
      return WD.render.prefetchImage(u).then(function (img) {
        out[u] = { w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 };
      }, function () { out[u] = null; });
    })).then(function () { return out; });
  }

  /* 文本框：每行一个 <a:p>，位置和断行都按浏览器实测结果摆放。
     但 bodyPr 必须允许换行（wrap="square"），不能用 wrap="none"：
     演示电脑上若缺少设计字体，字体度量变化会让文字变宽，wrap="none" 会把整行推出画面，
     而允许换行时最多只是这一行折成两行、仍然留在框内。
     为兼顾两者，每个文本框按「本行文字宽度 / 文本块宽度」给出一个合理的容器宽度。 */
  function textBoxXml(id, name, line, opts) {
    var box = line.box;
    var runs = (line.runs && line.runs.length) ? line.runs : [{
      text: line.text, font: opts.font, sizePx: opts.sizePx, color: opts.color,
      bold: opts.bold, italic: opts.italic, underline: opts.underline,
      letterSpacingPx: opts.letterSpacingPx
    }];

    var runsXml = runs.map(function (r) {
      return '<a:r>' + rPrXml({
        sizePx: r.sizePx || opts.sizePx,
        color: r.color || opts.color,
        bold: r.bold === undefined ? opts.bold : r.bold,
        italic: r.italic === undefined ? opts.italic : r.italic,
        underline: r.underline === undefined ? opts.underline : r.underline,
        letterSpacingPx: r.letterSpacingPx,
        font: r.font || opts.font
      }) + '<a:t>' + U.escapeXml(r.text) + '</a:t></a:r>';
    }).join('') || '<a:r>' + rPrXml({ sizePx: opts.sizePx, color: opts.color, font: opts.font }) + '<a:t></a:t></a:r>';

    var pPr = '<a:pPr algn="l" indent="0" marL="0" marR="0">' +
      '<a:lnSpc><a:spcPct val="' + Math.round((line.lineSpacingPct || 120) * 1000) + '"/></a:lnSpc>' +
      '<a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>' +
      '<a:buNone/></a:pPr>';

    /* 允许换行，但给足横向余量：容器宽度 = 文本块宽度 + 10% 缓冲，
       这样字体度量略有差异时不会提前折行，差异较大时才回退为折行而不是溢出画面。
       同时必须夹在画布内：缓冲不能把文本框推出幻灯片右边界
       （右对齐的数字、页脚页码最容易因此整段飞出可视区）。 */
    var wrapW = Math.max(24, (line.blockW || box.w) * 1.10);
    wrapW = Math.min(wrapW, Math.max(24, W - box.x));

    var bodyPr = '<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t">' +
      '<a:noAutofit/></a:bodyPr>';

    var pad = line.inset || 0;
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + U.escapeXml(name) + '"/>' +
      '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>' +
      xfrmXml(box.x, box.y - pad, Math.max(box.w, wrapW), box.h + pad * 2, opts.rot) +
      prstGeom('rect') + noFill() + noLine() + '</p:spPr>' +
      '<p:txBody>' + bodyPr + '<a:lstStyle/><a:p>' + pPr + runsXml + '</a:p></p:txBody></p:sp>';
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. 贴图
     ══════════════════════════════════════════════════════════════════════ */

  function ExportContext() {
    this.media = [];
    this.mediaIndex = 0;
  }

  ExportContext.prototype.addMedia = function (bytes, mime) {
    var name = 'image' + (++this.mediaIndex) + '.' + mimeToExt(mime);
    this.media.push({ name: name, bytes: bytes, mime: mime });
    return name;
  };

  function mimeToExt(mime) {
    switch (mime) {
      case 'image/jpeg': return 'jpeg';
      case 'image/gif': return 'gif';
      case 'image/bmp': return 'bmp';
      case 'image/webp': return 'webp';
      case 'image/svg+xml': return 'svg';
      default: return 'png';
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. 单页组装

     步骤：
       ① 逐页装进离屏帧（布局真实），读出每个元素的几何与最终样式；
       ② 判定哪些绘制必须交给浏览器（渐变 / 阴影 / 滤镜 / 变换 / SVG / 半透明）；
       ③ 用 elementFromPoint 找出「被贴图元素压住的文字」，这些文字必须烘进贴图，
          否则导出后会被贴图盖住；
       ④ 隐藏上述元素后，把整页当成一张矢量图，裁出遮挡区域补回去；
       ⑤ 其余复杂元素逐个内联样式后单独栅格化成 PNG 图片；
       ⑥ 剩下的纯色块 / 边框 / data-URI 图片 / 文字 → 真正的矢量对象。
     ══════════════════════════════════════════════════════════════════════ */

  /* 导出前把这一页里「还没变成 data: 的图片」补内联一遍，覆盖两类：
       · <img> 的 src
       · 任意元素的 background-image: url(...)（页面背景图就是走这条）
       为什么必须做：PPTX 只能嵌字节，而且 foreignObject 栅格化压根加载不了外部资源。
       导入 HTML 时若资源内联失败（外链、CORS、file://），不补这一步图片和背景图
       会在导出产物里凭空消失 —— 而且过去是静默消失。 */
  function inlineSlideImages(doc, note) {
    var win = doc.defaultView;
    var jobs = [];
    Array.prototype.forEach.call(doc.querySelectorAll('img'), function (n) {
      var src = n.currentSrc || n.src || n.getAttribute('src') || '';
      if (src && !/^data:/i.test(src)) jobs.push({ url: src, kind: 'img', node: n });
    });
    Array.prototype.forEach.call(doc.querySelectorAll('*'), function (n) {
      var cs;
      try { cs = win && win.getComputedStyle(n); } catch (e) { return; }
      if (!cs) return;
      var bi = cs.backgroundImage || '';
      if (bi === 'none' || !/url\(/i.test(bi)) return;
      var m = /url\(\s*(['"]?)([^'")]*)\1\s*\)/.exec(bi);
      if (!m) return;
      var u = m[2];
      if (!u || /^data:/i.test(u)) return;
      jobs.push({ url: u, kind: 'bg', node: n, full: m[0], bi: bi });
    });
    if (!jobs.length) return Promise.resolve();
    var changed = [];
    return Promise.all(jobs.map(function (j) {
      return WD.parse.fetchAsDataUrl(j.url).then(function (d) {
        if (!d || !/^data:/i.test(d)) return false;
        /* 替换串用函数返回，避免 dataURL 里偶发的 $ 被当成 replace 的模式符 */
        if (j.kind === 'img') { j.node.src = d; changed.push(j.node); }
        else j.node.style.backgroundImage = j.bi.replace(j.full, function () { return 'url("' + d + '")'; });
        return true;
      }, function () { return false; });
    })).then(function (oks) {
      /* 逐条报出到底哪个资源没拿到：只说「有几处失败」用户没法排查 */
      var bad = [];
      oks.forEach(function (o, i) { if (!o) bad.push(jobs[i]); });
      if (bad.length && typeof note === 'function') {
        bad.slice(0, 5).forEach(function (j) {
          note((j.kind === 'img' ? '图片' : '背景图') + '无法内联，导出产物里会缺失：' +
            String(j.url).slice(0, 60));
        });
        if (bad.length > 5) note('另有 ' + (bad.length - 5) + ' 处图片/背景图同样无法内联');
      }
      /* 刚换上的 data: 还没解码完就去栅格化会画成空白，这里等它们真的就绪 */
      return waitForImages(changed);
    });
  }

  /* 故意不用 rAF：后台标签页里 requestAnimationFrame 压根不触发，会把整条导出链拖死 */
  function waitForImages(nodes) {
    var pending = nodes.filter(function (n) { return n && !n.complete; });
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(function (n) {
      return new Promise(function (res) {
        var t = setTimeout(res, 6000);
        n.addEventListener('load', function () { clearTimeout(t); res(); }, { once: true });
        n.addEventListener('error', function () { clearTimeout(t); res(); }, { once: true });
      });
    })).then(function () { /* ignore */ });
  }

  function buildSlide(slide, ctx, opts, warn) {
    function note(msg) { if (typeof warn === 'function') warn(msg); }
    return WD.render.mountFrame(slide.doc, { timeout: 25000 })
      .then(function (m) { return inlineSlideImages(m.doc, note).then(function () { return m; }); })
      .then(function (m) {
        var doc = m.doc, win = m.win;
        var paintBoxes = collectPaintBoxes(doc, win);
        var textBlocks = collectTextBlocks(doc, win);
        var complex = paintBoxes.filter(function (p) { return p.reasons && p.reasons.length > 0; });

        var shapes = [];
        var rels = [];

        /* ③ 遮挡判定必须在任何隐藏操作之前做 */
        var covered = textBlocks.filter(function (b) {
          if (complex.indexOf(b) >= 0) return false;
          return isCovered(b);
        });
        var coveredSet = new Set(covered.map(function (b) { return b.node; }));

        /* ④ 遮挡区域贴图（此时把被压住的文字藏掉，避免重复绘制） */
        var occluders = complex.filter(function (c) {
          return covered.some(function (t) { return rectsOverlap(c.box, t.box); });
        });

        var regionOk = false;
        var coveredPromise = occluders.length
          ? coveredRegionPicture(m, occluders, covered, ctx).then(function (r) {
              if (r) { shapes.push(r.xml); rels.push(r.rel); regionOk = true; }
            })
          : Promise.resolve();

        /* 被遮挡的复杂元素已经并进区域贴图，不再单独出图 */
        var toRaster = complex.filter(function (c) { return occluders.indexOf(c) < 0; });

        return coveredPromise.then(function () {
          return rasterizeComplex(m, toRaster, ctx).then(function (r) {
            r.shapes.forEach(function (x) { shapes.push(x); });
            r.rels.forEach(function (x) { rels.push(x); });
          });
        }).then(function () {
          var skipSubtree = new Set();
          toRaster.forEach(function (c) { markSubtree(c.node, skipSubtree); });
          /* 并进遮挡区域贴图的元素同样已经画过了；但贴图失败时不能跳，否则内容彻底丢失 */
          if (regionOk) occluders.forEach(function (c) { markSubtree(c.node, skipSubtree); });

          return prefetchBgSizes(paintBoxes).then(function (bgSizes) {
            /* ⑥-a 形状层 */
            paintBoxes.forEach(function (item) {
              if (item.reasons && item.reasons.length) return;
              if (skipSubtree.has(item.node)) return;
              var elName = U.describeElement(item.node);
              if (item.tag === 'img') {
                var src = item.node.currentSrc || item.node.src || item.node.getAttribute('src') || '';
                if (!/^data:/i.test(src)) {
                  /* 到这里说明 inlineSlideImages 已经试过并且失败，那边已经报过具体地址了 */
                  return;
                }
                var parsed = U.dataUrlToBytes(src);
                if (!parsed) { note('一张图片的数据无法解析，导出中已跳过'); return; }
                var name = ctx.addMedia(parsed.bytes, parsed.mime);
                var relId = 'rIdImg' + ctx.mediaIndex;
                shapes.push(pictureXml(nextId(), elName, item.box, relId,
                  rotationOf(item.cs)));
                rels.push({ id: relId, name: name });
                return;
              }

              /* 背景图：单独出一张图片形状，元素里的文字仍然是可编辑文本 */
              var bgu = bgDataUrl(item.cs);
              var bgPic = null;
              if (bgu) {
                var bytes = U.dataUrlToBytes(bgu);
                if (!bytes) {
                  note('一处背景图的数据无法解析，导出中已跳过');
                } else {
                  var nat = bgSizes[bgu];
                  var p = nat ? bgPlacement(item.cs, item.box, nat.w, nat.h) : null;
                  if (!p) {
                    /* 尺寸取不到时退化为「拉伸铺满」，至少不会整块消失 */
                    p = { x: item.box.x, y: item.box.y, w: item.box.w, h: item.box.h,
                          src: { l: 0, t: 0, r: 0, b: 0 } };
                  }
                  var bgName = ctx.addMedia(bytes.bytes, bytes.mime);
                  var bgRelId = 'rIdImg' + ctx.mediaIndex;
                  bgPic = { xml: bgPictureXml(nextId(), elName + ' 背景图', p, bgRelId),
                            rel: { id: bgRelId, name: bgName } };
                }
              }

              var bg = U.parseColor(item.cs.backgroundColor);
              var bd = item.border;
              var adj = radiusToAdj(item.cs, item.box.w, item.box.h);
              var rot = rotationOf(item.cs);
              if (bgPic) {
                /* 底色 → 背景图 → 描边，三层顺序和浏览器绘制顺序一致 */
                if (U.isVisibleColor(bg)) {
                  shapes.push(rectShapeXml(nextId(), elName, item.box, solidFill(bg), noLine(),
                    { adj: adj, shadow: item.cs.boxShadow, rot: rot }));
                }
                shapes.push(bgPic.xml);
                rels.push(bgPic.rel);
                if (bd.any) {
                  shapes.push(rectShapeXml(nextId(), elName, item.box, noFill(),
                    lineXml(bd.color, bd.width, bd.style), { adj: adj, rot: rot }));
                }
                return;
              }

              var fillXml = U.isVisibleColor(bg) ? solidFill(bg) : noFill();
              var line = bd.any ? lineXml(bd.color, bd.width, bd.style) : noLine();
              shapes.push(rectShapeXml(nextId(), elName, item.box, fillXml, line, {
                adj: adj,
                shadow: item.cs.boxShadow,
                rot: rot
              }));
            });

            /* ⑥-b 文字层 */
            textBlocks.forEach(function (block) {
              if (coveredSet.has(block.node)) return;
              if (skipSubtree.has(block.node)) return;
              buildTextShapes(block).forEach(function (x) { shapes.push(x); });
            });

            var bgXml = backgroundShapeXml(pageBackground(doc, win));
            m.frame.remove();
            return { xml: slideXml(bgXml + shapes.join(''), ''), rels: rels, notes: slide.notes || '' };
          });
        });
      });
  }

  function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  /* 文字块的可见区域是否被压住（用 elementFromPoint 精确判定，而非猜 z-index） */
  function isCovered(block) {
    var box = block.box;
    if (box.w < 1 || box.h < 1) return false;
    var doc = block.node.ownerDocument;
    var n = 4;
    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= 3; j++) {
        var x = box.x + box.w * i / (n + 1);
        var y = box.y + box.h * j / 4;
        var top;
        try { top = doc.elementFromPoint(x, y); } catch (e) { return false; }
        if (!top) continue;
        if (top === block.node || block.node.contains(top)) continue;
        return true;
      }
    }
    return false;
  }

  /* 复杂元素逐个单独栅格化成图片 */
  function rasterizeComplex(m, list, ctx) {
    var shapes = [], rels = [];
    return list.reduce(function (p, item) {
      return p.then(function () {
        return WD.render.rasterizeNode(item.node, m.win, {
          box: item.box,
          scale: U.RASTER_SCALE,
          background: null          /* 透明底，避免贴图挡住背后的元素 */
        }).then(function (canvas) {
          if (!canvas) return;
          var parsed = U.dataUrlToBytes(canvas.toDataURL('image/png'));
          if (!parsed) return;
          var name = ctx.addMedia(parsed.bytes, parsed.mime);
          var relId = 'rIdImg' + ctx.mediaIndex;
          shapes.push(pictureXml(nextId(), U.describeElement(item.node), item.box, relId, 0));
          rels.push({ id: relId, name: name });
        });
      });
    }, Promise.resolve()).then(function () { return { shapes: shapes, rels: rels }; });
  }

  /* 遮挡区域：隐藏被压住的文字 → 整页当作矢量图 → 裁出遮挡范围 */
  function coveredRegionPicture(m, occluders, covered, ctx) {
    var union = null;
    occluders.forEach(function (o) {
      union = union ? {
        x: Math.min(union.x, o.box.x), y: Math.min(union.y, o.box.y),
        x2: Math.max(union.x2, o.box.x + o.box.w), y2: Math.max(union.y2, o.box.y + o.box.h)
      } : { x: o.box.x, y: o.box.y, x2: o.box.x + o.box.w, y2: o.box.y + o.box.h };
    });
    if (!union) return Promise.resolve(null);

    var box = {
      x: Math.max(0, union.x - 2),
      y: Math.max(0, union.y - 2),
      w: Math.min(W, union.x2 + 2) - Math.max(0, union.x - 2),
      h: Math.min(H, union.y2 + 2) - Math.max(0, union.y - 2)
    };
    if (box.w < 1 || box.h < 1) return Promise.resolve(null);

    var root = WD.render.findRoot(m.doc);
    var exclude = new Set(covered.map(function (t) { return t.node; }));

    return WD.render.rasterizeNode(root, m.win, {
      box: box,
      scale: 1.5,
      background: '#ffffff',
      exclude: exclude
    }).then(function (canvas) {
      if (!canvas) return null;
      var parsed = U.dataUrlToBytes(canvas.toDataURL('image/png'));
      if (!parsed) return null;
      var name = ctx.addMedia(parsed.bytes, parsed.mime);
      var relId = 'rIdImg' + ctx.mediaIndex;
      return {
        xml: pictureXml(nextId(), '遮挡区域贴图', box, relId, 0),
        rel: { id: relId, name: name }
      };
    });
  }

  /* 已经烘进贴图的元素：自己 + 全部后代都要跳过。
     漏掉「自己」会让同一个元素既出现在图片里、又再输出一份矢量形状和文字，
     导出后看起来就是重影 / 文字发虚。 */
  function markSubtree(node, set) {
    set.add(node);
    for (var i = 0; i < node.children.length; i++) {
      markSubtree(node.children[i], set);
    }
  }

  function buildTextShapes(block) {
    var node = block.node, cs = block.cs, box = block.box;
    var ownOnly = !!block.ownTextOnly;
    var lines = textLines(node, cs, box, ownOnly);
    if (!lines.length) return [];

    var baseFont = U.primaryFamily(cs.fontFamily) || 'Microsoft YaHei';
    var baseSize = U.parsePx(cs.fontSize, 16) || 16;
    var baseColor = U.parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    var align = cs.textAlign || 'left';
    var runs = richRuns(node, cs, ownOnly);
    if (!runs.length) return [];

    /* 多行：按字符位置把 run 切到各行 */
    var allText = lines.map(function (l) { return l.text; }).join('');
    var runText = runs.map(function (r) { return r.text; }).join('');
    var runSlices = lines.length > 1 ? sliceRuns(runs, lines) : null;

    return lines.map(function (line, idx) {
      /* 对齐：还原视觉横向位置 */
      var pad = Math.max(1, Math.round(baseSize * 0.055));
      if (align === 'center') line.box.x = box.x + (box.w - line.box.w) / 2;
      else if (align === 'right' || align === 'end') line.box.x = box.x + box.w - line.box.w;
      line.box.w = Math.max(4, line.box.w) + 2;
      line.inset = pad;
      /* 记录原文本块宽度，供 textBoxXml 计算允许换行的容器宽度 */
      line.blockW = box.w;
      line.runs = runSlices ? runSlices[idx] : null;

      return textBoxXml(nextId(), U.describeElement(node), line, {
        font: baseFont, sizePx: baseSize, color: baseColor,
        bold: U.isBoldWeight(U.parseFontWeight(cs.fontWeight)),
        italic: cs.fontStyle === 'italic',
        underline: /underline/.test(cs.textDecorationLine || ''),
        letterSpacingPx: U.parsePx(cs.letterSpacing, 0) || 0,
        rot: rotationOf(cs)
      });
    });
  }

  /* 把富文本 runs 按行切分（依据各行文本在该行上的近似偏移） */
  function sliceRuns(runs, lines) {
    var totalRun = runs.reduce(function (n, r) { return n + r.text.length; }, 0) || 1;
    var totalLine = lines.reduce(function (n, l) { return n + l.text.length; }, 0) || 1;
    var scale = totalRun / totalLine;

    var out = lines.map(function () { return []; });
    var runPos = 0;
    runs.forEach(function (r) {
      var start = runPos, end = runPos + r.text.length;
      runPos = end;
      var cursor = start;
      lines.forEach(function (line, li) {
        var lineStart = 0;
        for (var k = 0; k < li; k++) lineStart += lines[k].text.length;
        var lineEnd = lineStart + line.text.length;
        var s = lineStart * scale, e = lineEnd * scale;
        var a = Math.max(cursor, s), b = Math.min(end, e);
        if (b <= a) return;
        var from = Math.round(a - start), to = Math.round(b - start);
        var piece = r.text.slice(from, Math.max(from + 1, to));
        if (!piece) return;
        out[li].push({
          text: piece, font: r.font, sizePx: r.sizePx, color: r.color,
          bold: r.bold, italic: r.italic, underline: r.underline,
          letterSpacingPx: r.letterSpacingPx
        });
        cursor = b;
      });
    });

    return out.map(function (list, i) {
      if (list.length) return list;
      return [{ text: lines[i].text }];
    });
  }

  /* 页面底色。
     `html,body` 上的深色往往只是「视口衬底色」（多页文档把它刷成深灰以免白边），
     并不是某一页的设计底色，所以不能优先取它。优先级：
       ① 单页根容器自身
       ② 根容器的第一个子元素（通常就是被烘焙的那张幻灯片 / 区块）
       ③ body
       ④ 兜底白色

     实现方式：不写 <p:bg>，而是输出一个铺满画布的普通矩形（见 backgroundShapeXml）。
     原因：实测 LibreOffice 的原生光栅化后端会把「带实色 <p:bg>」的页面整页画成黑色，
     用形状表达底色在所有渲染器上都稳定，也便于用户在 PPT 里直接改背景色。 */
  function pageBackground(doc, win) {
    var root = WD.render.findRoot(doc);
    var candidates = [];
    if (root && root !== doc.body) {
      candidates.push(root);
      if (root.firstElementChild) candidates.push(root.firstElementChild);
    }
    candidates.push(doc.body);

    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      if (!node) continue;
      var cs;
      try { cs = win.getComputedStyle(node); } catch (e) { continue; }
      if (!cs) continue;

      if (cs.backgroundImage && /gradient\(/i.test(cs.backgroundImage)) {
        /* 渐变底色：取首个色标近似；精确渐变由该元素自己的贴图负责 */
        var stop = firstGradientStop(cs.backgroundImage);
        if (stop && U.isOpaque(stop)) return stop;
        continue;
      }
      var c = U.parseColor(cs.backgroundColor);
      if (U.isOpaque(c)) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  /* 底色作为形状树的第一个对象，避免使用渲染器不稳定的 <p:bg> */
  function backgroundShapeXml(color) {
    return rectShapeXml(2, '页面底色', { x: 0, y: 0, w: W, h: H }, solidFill(color), noLine(), {});
  }

  /* 从 CSS 渐变里取第一个颜色，作为矢量底色近似 */
  function firstGradientStop(value) {
    if (!value) return null;
    var inner = value.match(/(?:linear|radial)-gradient\(([\s\S]*)\)/i);
    if (!inner) return null;
    var parts = splitTopLevel(inner[1], ',');
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/);
      if (m) {
        var c = U.parseColor(m[1]);
        if (c) return c;
      }
    }
    return null;
  }

  function slideXml(shapesXml, bgXml) {
    return XML_HEADER +
      '<p:sld xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
      '<p:cSld>' + (bgXml || '') + '<p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      shapesXml + '</p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }

  /* ══════════════════════════════════════════════════════════════════════
     8. 固定部件
     ══════════════════════════════════════════════════════════════════════ */

  function contentTypesXml(slideCount, mediaTypes, hasNotes) {
    var overrides = [
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    ];
    for (var i = 1; i <= slideCount; i++) {
      overrides.push('<Override PartName="/ppt/slides/slide' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>');
    }
    if (hasNotes) {
      overrides.push('<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>');
      overrides.push('<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>');
      for (var j = 1; j <= slideCount; j++) {
        overrides.push('<Override PartName="/ppt/notesSlides/notesSlide' + j + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>');
      }
    }
    var defaults = [
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>'
    ];
    var seen = Object.create(null);
    mediaTypes.forEach(function (m) {
      var ext = mimeToExt(m);
      if (seen[ext]) return;
      seen[ext] = true;
      defaults.push('<Default Extension="' + ext + '" ContentType="' + m + '"/>');
    });
    return XML_HEADER + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      defaults.join('') + overrides.join('') + '</Types>';
  }

  var ROOT_RELS = XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + NS_R + '/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  function coreXml(title, author) {
    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var who = author || 'WizDeck 智演引擎';
    return XML_HEADER +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + U.escapeXml(title || '') + '</dc:title>' +
      '<dc:creator>' + U.escapeXml(who) + '</dc:creator>' +
      '<cp:lastModifiedBy>' + U.escapeXml(who) + '</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
      '</cp:coreProperties>';
  }

  function appXml(slideCount, title) {
    return XML_HEADER +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>WizDeck 智演引擎</Application>' +
      '<Slides>' + slideCount + '</Slides><Company></Company>' +
      '<HeadingPairs><vt:vector size="2" baseType="variant">' +
      '<vt:variant><vt:lpstr>幻灯片标题</vt:lpstr></vt:variant>' +
      '<vt:variant><vt:i4>' + slideCount + '</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>' +
      U.escapeXml(title || '') + '</vt:lpstr></vt:vector></TitlesOfParts>' +
      '</Properties>';
  }

  function presPropsXml() {
    return XML_HEADER + '<p:presentationPr xmlns:a="' + NS_A + '" xmlns:r="' + NS_R +
      '" xmlns:p="' + NS_P + '"/>';
  }

  function viewPropsXml() {
    return XML_HEADER + '<p:viewPr xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
      '<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>' +
      '<p:slideViewPr><p:cSldViewPr snapToGrid="0" snapToObjects="1">' +
      '<p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale>' +
      '<p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr>' +
      '<p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale>' +
      '<p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr>' +
      '<p:gridSpacing cx="78028800" cy="78028800"/></p:viewPr>';
  }

  function tableStylesXml() {
    return XML_HEADER + '<a:tblStyleLst xmlns:a="' + NS_A + '" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>';
  }

  function presentationXml(slideCount, hasNotes) {
    var sldIds = [];
    for (var i = 1; i <= slideCount; i++) {
      sldIds.push('<p:sldId id="' + (256 + i) + '" r:id="rId' + (100 + i) + '"/>');
    }
    return XML_HEADER +
      '<p:presentation xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '" saveSubsetFonts="1">' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      (hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst>' : '') +
      '<p:sldIdLst>' + sldIds.join('') + '</p:sldIdLst>' +
      '<p:sldSz cx="' + emu(W) + '" cy="' + emu(H) + '"/>' +
      '<p:notesSz cx="' + emu(H) + '" cy="' + emu(W) + '"/>' +
      '<p:defaultTextStyle>' +
      '<a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr>' +
      '<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">' +
      '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>' +
      '<a:lvl2pPr marL="457200" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">' +
      '<a:defRPr sz="1600" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl2pPr>' +
      '</p:defaultTextStyle></p:presentation>';
  }

  function presentationRels(slideCount, hasNotes) {
    var rels = ['<Relationship Id="rId1" Type="' + NS_R + '/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];
    if (hasNotes) {
      rels.push('<Relationship Id="rId3" Type="' + NS_R + '/notesMaster" Target="notesMasters/notesMaster1.xml"/>');
    }
    for (var i = 1; i <= slideCount; i++) {
      rels.push('<Relationship Id="rId' + (100 + i) + '" Type="' + NS_R + '/slide" Target="slides/slide' + i + '.xml"/>');
    }
    rels.push('<Relationship Id="rId2" Type="' + NS_R + '/presProps" Target="presProps.xml"/>');
    rels.push('<Relationship Id="rId4" Type="' + NS_R + '/viewProps" Target="viewProps.xml"/>');
    rels.push('<Relationship Id="rId5" Type="' + NS_R + '/theme" Target="theme/theme1.xml"/>');
    rels.push('<Relationship Id="rId6" Type="' + NS_R + '/tableStyles" Target="tableStyles.xml"/>');
    return XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>';
  }

  function slideRelsXml(mediaRels, notesRelId, notesIndex) {
    var rels = ['<Relationship Id="rId1" Type="' + NS_R + '/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'];
    mediaRels.forEach(function (r) {
      rels.push('<Relationship Id="' + r.id + '" Type="' + NS_R + '/image" Target="../media/' + r.name + '"/>');
    });
    if (notesRelId) {
      rels.push('<Relationship Id="' + notesRelId + '" Type="' + NS_R + '/notesSlide" Target="../notesSlides/notesSlide' + notesIndex + '.xml"/>');
    }
    return XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>';
  }

  function notesSlideXml(text) {
    var paragraphs = U.sanitizeText(text || '').split('\n').map(function (line) {
      return '<a:p><a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>' + U.escapeXml(line) + '</a:t></a:r></a:p>';
    }).join('') || '<a:p/>';
    return XML_HEADER +
      '<p:notes xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
      '<p:cSld><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="幻灯片图像占位符 1"/>' +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="备注占位符 2"/>' +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
      '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720">' +
      '<a:normAutofit/></a:bodyPr><a:lstStyle/>' + paragraphs + '</p:txBody></p:sp>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
  }

  function notesRelsXml(slideIndex) {
    return XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + NS_R + '/notesMaster" Target="../notesMasters/notesMaster1.xml"/>' +
      '<Relationship Id="rId2" Type="' + NS_R + '/slide" Target="../slides/slide' + slideIndex + '.xml"/>' +
      '</Relationships>';
  }

  function slideMasterXml() {
    return XML_HEADER +
      '<p:sldMaster xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
      '<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill>' +
      '<a:effectLst/></p:bgPr></p:bg><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题占位符 1"/>' +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="' + emu(96) + '" y="' + emu(80) + '"/>' +
      '<a:ext cx="' + emu(W - 192) + '" cy="' + emu(180) + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>单击编辑标题</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="文本占位符 2"/>' +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="' + emu(96) + '" y="' + emu(300) + '"/>' +
      '<a:ext cx="' + emu(W - 192) + '" cy="' + emu(H - 400) + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="zh-CN"/><a:t>单击编辑文本</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
      'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '<p:txStyles>' +
      '<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">' +
      '<a:spcBef><a:spcPct val="0"/></a:spcBef>' +
      '<a:defRPr sz="4000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr>' +
      '</a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900" algn="l" defTabSz="914400" rtl="0" ' +
      'eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef>' +
      '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>' +
      '</a:lvl1pPr></p:bodyStyle>' +
      '<p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr>' +
      '<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">' +
      '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>' +
      '</a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';
  }

  function slideMasterRels() {
    return XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + NS_R + '/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rId2" Type="' + NS_R + '/theme" Target="../theme/theme1.xml"/>' +
      '</Relationships>';
  }

  function slideLayoutXml() {
    return XML_HEADER +
      '<p:sldLayout xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '" type="blank" preserve="1">' +
      '<p:cSld name="空白"><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  }

  function slideLayoutRels() {
    return XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + NS_R + '/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>';
  }

  function themeXml(name, majorFont, minorFont) {
    var mj = majorFont || 'Microsoft YaHei';
    var mn = minorFont || 'Microsoft YaHei';
    function fonts(latin) {
      return '<a:latin typeface="' + U.escapeXml(latin) + '"/>' +
        '<a:ea typeface="' + U.escapeXml(latin) + '"/>' +
        '<a:cs typeface="' + U.escapeXml(latin) + '"/>';
    }
    return XML_HEADER +
      '<a:theme xmlns:a="' + NS_A + '" name="' + U.escapeXml(name || 'WizDeck') + '"><a:themeElements>' +
      '<a:clrScheme name="WizDeck">' +
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
      '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="1E2A3A"/></a:dk2>' +
      '<a:lt2><a:srgbClr val="F5F7FA"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="F7A600"/></a:accent1>' +
      '<a:accent2><a:srgbClr val="5B8DEF"/></a:accent2>' +
      '<a:accent3><a:srgbClr val="27AE60"/></a:accent3>' +
      '<a:accent4><a:srgbClr val="C9302C"/></a:accent4>' +
      '<a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>' +
      '<a:accent6><a:srgbClr val="0EA5E9"/></a:accent6>' +
      '<a:hlink><a:srgbClr val="2F80ED"/></a:hlink>' +
      '<a:folHlink><a:srgbClr val="7D8BA3"/></a:folHlink></a:clrScheme>' +
      '<a:fontScheme name="WizDeck"><a:majorFont>' + fonts(mj) + '</a:majorFont>' +
      '<a:minorFont>' + fonts(mn) + '</a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="WizDeck">' +
      '<a:fillStyleLst>' +
      '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/><a:satMod val="200000"/></a:schemeClr></a:solidFill>' +
      '</a:fillStyleLst>' +
      '<a:lnStyleLst>' +
      '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
      '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
      '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
      '</a:lnStyleLst>' +
      '<a:effectStyleLst>' +
      '<a:effectStyle><a:effectLst/></a:effectStyle>' +
      '<a:effectStyle><a:effectLst/></a:effectStyle>' +
      '<a:effectStyle><a:effectLst/></a:effectStyle>' +
      '</a:effectStyleLst>' +
      '<a:bgFillStyleLst>' +
      '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:solidFill>' +
      '</a:bgFillStyleLst></a:fmtScheme></a:themeElements>' +
      '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
  }

  function notesMasterXml() {
    return XML_HEADER +
      '<p:notesMaster xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
      '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="幻灯片图像占位符 1"/>' +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="备注占位符 2"/>' +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '<p:txBody><a:bodyPr vert="horz"/><a:lstStyle/><a:p/></p:txBody></p:sp>' +
      '</p:spTree></p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
      'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">' +
      '<a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>' +
      '</a:lvl1pPr></p:notesStyle></p:notesMaster>';
  }

  function notesMasterRels() {
    return XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + NS_R + '/theme" Target="../theme/theme2.xml"/>' +
      '</Relationships>';
  }

  /* ══════════════════════════════════════════════════════════════════════
     9. 主入口
     ══════════════════════════════════════════════════════════════════════ */

  function assemble(model, slideResults, ctx, hasNotes, opts) {
    var files = [];
    var n = slideResults.length;
    var mimes = [];
    var seenMime = Object.create(null);
    ctx.media.forEach(function (m) {
      if (!seenMime[m.mime]) { seenMime[m.mime] = true; mimes.push(m.mime); }
    });

    files.push({ name: '[Content_Types].xml', data: contentTypesXml(n, mimes, hasNotes) });
    files.push({ name: '_rels/.rels', data: ROOT_RELS });
    files.push({ name: 'docProps/core.xml', data: coreXml(model.title, opts.author) });
    files.push({ name: 'docProps/app.xml', data: appXml(n, model.title) });
    files.push({ name: 'ppt/presentation.xml', data: presentationXml(n, hasNotes) });
    files.push({ name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(n, hasNotes) });
    files.push({ name: 'ppt/presProps.xml', data: presPropsXml() });
    files.push({ name: 'ppt/viewProps.xml', data: viewPropsXml() });
    files.push({ name: 'ppt/tableStyles.xml', data: tableStylesXml() });
    files.push({ name: 'ppt/theme/theme1.xml', data: themeXml(model.title, opts.font, opts.font) });
    files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: slideMasterXml() });
    files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: slideMasterRels() });
    files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: slideLayoutXml() });
    files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: slideLayoutRels() });

    slideResults.forEach(function (r, i) {
      var useNotes = hasNotes && r.notes.trim();
      files.push({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: r.xml });
      files.push({
        name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels',
        data: slideRelsXml(r.rels || [], useNotes ? ('rIdNotes' + (i + 1)) : null, i + 1)
      });
    });

    if (hasNotes) {
      files.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: notesMasterXml() });
      files.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: notesMasterRels() });
      files.push({ name: 'ppt/theme/theme2.xml', data: themeXml(model.title + ' 备注', opts.font, opts.font) });
      slideResults.forEach(function (r, i) {
        files.push({ name: 'ppt/notesSlides/notesSlide' + (i + 1) + '.xml', data: notesSlideXml(r.notes) });
        files.push({ name: 'ppt/notesSlides/_rels/notesSlide' + (i + 1) + '.xml.rels', data: notesRelsXml(i + 1) });
      });
    }

    ctx.media.forEach(function (m) {
      files.push({ name: 'ppt/media/' + m.name, data: m.bytes });
    });

    /* 打包前自检：任何一处 XML 不良构都会让渲染器直接丢掉整个形状
       （曾经因为一个 <a:bodyPr> 少了 ">"，导致所有文本框在 PowerPoint 里消失）。 */
    var problems = validateParts(files);

    var zip = new ZipWriter();
    return zip.addAll(files).then(function () {
      var bytes = zip.build();
      var zipProblems = zip.problems || [];
      zipProblems.forEach(function (p) {
        problems.push({ part: 'zip#' + p.entry, reason: p.reason });
      });
      return {
        bytes: bytes, files: files.length, media: ctx.media.length, slides: n,
        problems: problems
      };
    });
  }

  /* 用 DOMParser 校验每个 XML 部件是否良构；顺带检查 DrawingML 标签是否配平。
     返回问题列表（空数组表示全部通过）。不抛异常：宁可导出后给出明确警告。 */
  function validateParts(files) {
    var problems = [];
    var parser = (typeof DOMParser !== 'undefined') ? new DOMParser() : null;

    files.forEach(function (f) {
      if (!/\.(xml|rels)$/i.test(f.name)) return;
      var text = typeof f.data === 'string' ? f.data : null;
      if (text === null) return;
      if (!parser) return;

      var doc = parser.parseFromString(text, 'application/xml');
      var err = doc.querySelector('parsererror');
      if (err) {
        problems.push({ part: f.name, reason: 'XML 不良构' });
        return;
      }
      /* 配平检查：主要绘制标签的开合数量必须一致。
         自闭合判断要允许标签带属性，例如 <a:bodyPr vert="horz"/> —— 只匹配
         `<tag/>` 会把带属性的自闭合标签误判成未闭合。 */
      ['a:bodyPr', 'p:spPr', 'p:txBody', 'a:xfrm', 'p:sp', 'p:pic'].forEach(function (tag) {
        var esc = tag.replace(':', '\\:');
        var open = (text.match(new RegExp('<' + esc + '(?=[\\s/>])', 'g')) || []).length;
        var selfClose = (text.match(new RegExp('<' + esc + '(?:\\s[^<>]*?)?/>', 'g')) || []).length;
        var close = (text.match(new RegExp('</' + esc + '>', 'g')) || []).length;
        if (open - selfClose !== close) {
          problems.push({
            part: f.name, reason: tag + ' 开合不匹配',
            open: open - selfClose, close: close
          });
        }
      });
    });
    return problems;
  }

  function exportPptx(model, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var slides = model.slides || [];
    if (!slides.length) return Promise.reject(new Error('没有可导出的幻灯片'));

    var ctx = new ExportContext();
    var results = [];
    var hasNotes = slides.some(function (s) { return s.notes && s.notes.trim(); });
    var warnings = [];

    function step(i) {
      if (i >= slides.length) return Promise.resolve();
      onProgress('正在解析第 ' + (i + 1) + '/' + slides.length + ' 页…',
        0.04 + 0.78 * (i / slides.length), i + 1, slides.length);

      return buildSlide(slides[i], ctx, opts, function (msg) { warnings.push(msg); })
        .then(function (r) { results.push(r); })
        .catch(function (e) {
          console.error('[wizdeck] 第 ' + (i + 1) + ' 页导出失败，降级为整页贴图', e);
          warnings.push('第 ' + (i + 1) + ' 页已降级为整页贴图');
          return fallbackSlide(slides[i], ctx).then(function (r) { results.push(r); });
        })
        .then(function () { return step(i + 1); });
    }

    return step(0).then(function () {
      onProgress('正在打包 PPTX…', 0.9);
      return assemble(model, results, ctx, hasNotes, opts).then(function (r) {
        r.warnings = warnings;
        if (r.problems && r.problems.length) {
          r.warnings = warnings.concat(r.problems.map(function (p) {
            return p.part + '：' + p.reason;
          }));
          console.error('[wizdeck] 导出产物自查未通过', r.problems);
        }
        return r;
      });
    });
  }

  /* 兜底：整页栅格化成一张图片（仍用 foreignObject，保真度最高） */
  function fallbackSlide(slide, ctx) {
    return WD.render.mountFrame(slide.doc, { timeout: 25000 }).then(function (m) {
      var root = WD.render.findRoot(m.doc);
      return WD.render.rasterizeNode(root, m.win, {
        box: { x: 0, y: 0, w: W, h: H },
        scale: 1.5,
        background: '#ffffff'
      }).then(function (canvas) {
        m.frame.remove();
        if (!canvas) throw new Error('整页栅格化失败');
        var parsed = U.dataUrlToBytes(canvas.toDataURL('image/png'));
        if (!parsed) throw new Error('整页贴图失败');
        var name = ctx.addMedia(parsed.bytes, parsed.mime);
        var relId = 'rIdImg' + ctx.mediaIndex;
        return {
          xml: slideXml(
            pictureXml(nextId(), '整页贴图', { x: 0, y: 0, w: W, h: H }, relId, 0),
            ''
          ),
          rels: [{ id: relId, name: name }],
          notes: slide.notes || ''
        };
      });
    });
  }

  WD.pptx = {
    exportPptx: exportPptx,
    ZipWriter: ZipWriter,
    crc32: crc32,
    _internals: {
      parseGradient: parseGradient, parseBoxShadow: parseBoxShadow,
      radiusToAdj: radiusToAdj, borderInfo: borderInfo, needsRaster: needsRaster,
      emu: emu, pt: pt, textLines: textLines, collectTextBlocks: collectTextBlocks,
      collectPaintBoxes: collectPaintBoxes, rotationOf: rotationOf,
      presentationXml: presentationXml, contentTypesXml: contentTypesXml,
      slideXml: slideXml
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
