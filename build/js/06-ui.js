/* ============================================================================
   智演引擎 / WizDeck — 工作台 UI 与编辑交互
   ========================================================================== */
(function (global) {
  'use strict';

  var WD = global.WD = global.WD || {};
  var U = WD.util;
  var store = WD.store;
  var W = U.CANVAS_W, H = U.CANVAS_H;

  /* 浮动工具条的尺寸在 refreshOverlay() 里用 offsetWidth/offsetHeight 实测，
     不再写死常量 —— 图标尺寸一改，写死的数字就会和 CSS 对不上。 */

  /* ══════════════════════════════════════════════════════════════════════
     0. 小工具
     ══════════════════════════════════════════════════════════════════════ */

  var $ = U.$, $$ = U.$$, el = U.el;

  /* 轻量诊断日志：只在开启时记录，平时零开销。
     编辑类问题往往「不报错但没生效」，没有日志只能靠猜，成本太高。 */
  var WD_DEBUG = false;
  try {
    WD_DEBUG = !!(global.localStorage && global.localStorage.getItem('wizdeck.debug')) ||
      /[?&]wddebug=1/.test(String(global.location && global.location.search || ''));
  } catch (e) { /* ignore */ }
  function wdLog() {
    if (!WD_DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    global.__wdLog = global.__wdLog || [];
    global.__wdLog.push(args.join(' '));
    if (global.__wdLog.length > 300) global.__wdLog.shift();
  }

  function toast(message, kind, ms) {
    var host = $('toasts');
    if (!host) return;
    var icons = { ok: '✓', warn: '!', error: '✕', info: 'i' };
    var node = el('div', { class: 'toast ' + (kind || 'info') }, [
      el('span', { class: 't-ico', text: icons[kind] || 'i' }),
      el('span', { html: U.escapeHtml(message) })
    ]);
    host.appendChild(node);
    var life = ms || (kind === 'error' ? 6500 : 3200);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 220);
    }, life);
  }

  var busyCount = 0;
  function busy(title, sub) {
    busyCount++;
    var box = $('busy');
    $('busy-title').textContent = title || '处理中…';
    $('busy-sub').textContent = sub || '';
    box.hidden = false;
  }
  function busyUpdate(title, sub) {
    if (title !== undefined) $('busy-title').textContent = title;
    if (sub !== undefined) $('busy-sub').textContent = sub;
  }
  function busyDone() {
    busyCount = Math.max(0, busyCount - 1);
    if (!busyCount) $('busy').hidden = true;
  }

  var modalOnClose = null;
  function showModal(opts) {
    $('modal-title').textContent = opts.title || '';
    var body = $('modal-body');
    body.innerHTML = opts.html || '';
    var foot = $('modal-foot');
    foot.innerHTML = '';
    (opts.buttons || [{ label: '知道了', primary: true }]).forEach(function (b) {
      foot.appendChild(el('button', {
        class: 'btn' + (b.primary ? ' primary' : ''),
        text: b.label,
        onclick: function () {
          if (b.onClick) b.onClick();
          if (b.keepOpen !== true) hideModal();
        }
      }));
    });
    $('modal-card').classList.toggle('wide', !!opts.wide);
    $('modal').hidden = false;
    modalOnClose = opts.onClose || null;
  }
  function hideModal() {
    $('modal').hidden = true;
    if (modalOnClose) { var f = modalOnClose; modalOnClose = null; f(); }
  }

  /* ══════════════════════════════════════════════════════════════════════
     1. 编辑器状态
     ══════════════════════════════════════════════════════════════════════ */

  var E = {
    stage: null,
    selection: [],
    hover: null,
    editing: null,
    editingBackup: '',
    drag: null,
    toastEls: {}
  };

  function frameDoc() { return E.stage ? E.stage.getDoc() : null; }
  function frameWin() { return E.stage ? E.stage.getWin() : null; }
  function rootEl() {
    var doc = frameDoc();
    return doc ? WD.render.findRoot(doc) : null;
  }
  function selected() { return E.selection.length ? E.selection[0] : null; }
  function isSelected(node) { return E.selection.indexOf(node) >= 0; }

  /* ══════════════════════════════════════════════════════════════════════
     2. 清理编辑器痕迹 + 序列化
     ══════════════════════════════════════════════════════════════════════ */

  var ARTIFACT_ATTRS = ['contenteditable', 'data-wd-sel', 'data-wd-hover', 'data-wd-iso',
    'data-wd-orig-pos', 'data-wd-orig-display', 'data-wd-iso-shell', 'data-wd-editing',
    'spellcheck', 'autocorrect', 'autocapitalize'];

  function cleanupDoc(doc, win) {
    var nodes = doc.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      ARTIFACT_ATTRS.forEach(function (a) { n.removeAttribute(a); });
      if (n.style) {
        if (n.style.outline && /239|255, 0, 0|#ef/i.test(n.style.outline)) n.style.outline = '';
        n.style.removeProperty('caret-color');
        n.style.removeProperty('user-select');
        n.style.removeProperty('-webkit-user-select');
        n.style.removeProperty('cursor');
      }
      /* 去掉空 style 属性 */
      if (n.getAttribute && n.getAttribute('style') === '') n.removeAttribute('style');
    }
    /* 移除编辑器注入的辅助样式 */
    var holder = doc.querySelector('[data-wd-hold]');
    if (holder && holder.parentNode && !holder.children.length) holder.parentNode.removeChild(holder);
    /* 清掉选区高亮残留 */
    try { if (win && win.getSelection) win.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
    return doc;
  }

  function serializeSlideDoc() {
    var doc = frameDoc();
    /* 换页时 iframe 正处于 about:blank → 换 srcdoc 的中间态，
       contentDocument 拿得到但 documentElement 还是 null。
       这里必须挡住，否则会抛 "Cannot read properties of null (reading 'cloneNode')"。 */
    if (!doc || !doc.documentElement) return null;
    var clone = doc.documentElement.cloneNode(true);
    cleanupDoc(clone, null);
    var html = '<!DOCTYPE html>\n' + clone.outerHTML;
    return html;
  }

  /* 把当前舞台内容写回模型（不入历史，由调用方决定） */
  function syncSlideDoc() {
    var s = store.slide();
    if (!s) return;
    var html = serializeSlideDoc();
    if (!html) return;
    s.doc = html;
    WD.render.invalidateThumb(s.id);
  }

  /* 提交一次修改（入历史 + 标记脏 + 刷新左栏与缩略图）
     缩略图刷新统一由 renderRail() 内部触发；
     早前这里是 scheduleThumbs() + renderRail() 各触发一次，
     两批异步回调互相作废，反而留下一格格空图。 */
  function commit(label) {
    syncSlideDoc();
    store.commit(label);
    renderRail();
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. 元素选择
     ══════════════════════════════════════════════════════════════════════ */

  function nodeVisible(node, win) {
    if (!U.isElement(node) || U.shouldSkip(node)) return false;
    if (node.hasAttribute('data-wd-iso')) return false;
    var cs;
    try { cs = win.getComputedStyle(node); } catch (e) { return false; }
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    var r = node.getBoundingClientRect();
    return r.width >= 0.8 && r.height >= 0.8;
  }

  function hasBlockChildren(node, win) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (U.shouldSkip(c)) continue;
      var ccs;
      try { ccs = win.getComputedStyle(c); } catch (e) { continue; }
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
      if (!/^(inline|ruby)/.test(ccs.display)) return true;
    }
    return false;
  }

  /* 元素是否自带裸文本（不含子元素里的文字）。
     像 <div class="formula">公式<small>注解</small></div> 这种写法，
     文字与行内子元素同处一行，双击时应当整体进入文字编辑，
     而不是只选到 <small> 那一小块。 */
  function hasOwnText(node) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var n = node.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  /* 归一化文本，用于比较「文字量」 */
  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function hasOwnPaint(node, win) {
    var cs;
    try { cs = win.getComputedStyle(node); } catch (e) { return false; }
    /* 箭头 / 双箭头的边框盒子本身是透明的（笔画是它里面的 SVG），
       但它显然「有绘制」，所以也要能被点中 —— 不然就是插进去选不动的死元素。 */
    return U.hasOwnPaint(cs) || node.tagName === 'IMG' || node.tagName === 'SVG' ||
      node.tagName === 'CANVAS' || !!(node.querySelector && node.querySelector('svg'));
  }

  /* 纯行内排版标签。它们只是文字的一部分，不是可以单独摆放的对象。
     对它们调用 getBoundingClientRect() 得到的是「所有行盒片段的并集」，
     而且一旦设 position:absolute，left/top 的参照会变成包含块的原点 ——
     实测 <em> 被 pin 之后整体平移了父元素的偏移量 (96, 353)。
     所以除非它自己带绘制（有底色/边框，看起来是个标签块），否则不给选中。 */
  var INLINE_TEXT_TAGS = {
    EM: 1, STRONG: 1, B: 1, I: 1, U: 1, S: 1, SMALL: 1, BIG: 1, MARK: 1, SUB: 1, SUP: 1,
    CODE: 1, KBD: 1, SAMP: 1, VAR: 1, ABBR: 1, CITE: 1, Q: 1, TIME: 1, SPAN: 1, A: 1,
    LABEL: 1, BDI: 1, BDO: 1, RUBY: 1, RT: 1, RP: 1, DEL: 1, INS: 1,
  };

  function isInlineTextTag(node, win) {
    if (!INLINE_TEXT_TAGS[node.tagName]) return false;
    if (hasOwnPaint(node, win)) return false;      // 有底色/边框 → 当成小标签块
    if (node.tagName === 'IMG' || node.tagName === 'SVG') return false;
    return true;
  }

  /* 元素内部有没有「值得单独选中的东西」。
     用来排除那种纯排版用的外层容器：整页 <section> 往往只是包了一堆卡片，
     自身没有底色也没有裸文本，点它等于选中一个 1920×1080 的大空盒子，
     用户会觉得「点哪都选中一大块」。 */
  function hasSelectableContent(node, win, depth) {
    depth = depth || 0;
    if (depth > 4) return false;
    if (hasOwnText(node) || hasOwnPaint(node, win)) return true;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (U.shouldSkip(c)) continue;
      if (!nodeVisible(c, win)) continue;
      var ccs;
      try { ccs = win.getComputedStyle(c); } catch (e) { continue; }
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
      if (isInlineTextTag(c, win)) continue;
      if (hasSelectableContent(c, win, depth + 1)) return true;
    }
    return false;
  }

  /* 「整页底板」：这一页自己的包装元素（通常是 .slide / .page / section）。
     它当然有底色，但它不是用户想拖的对象 —— 点在页面空白处却选中一个
     铺满画布的大盒子，会觉得「点哪都选中一大块」。
     页面底色交给右侧「幻灯片属性 → 背景」去改，不靠画布点选。
     画布尺寸用字面量，避免在模块初始化顺序上依赖 WD.util。 */
  function isPageBackdrop(node, win) {
    var root = rootEl();
    if (!root || node.parentNode !== root) return false;
    if (!hasOwnPaint(node, win)) return false;
    var r = node.getBoundingClientRect();
    /* ① 铺满画布：最常见的写法 */
    if (r.width >= 1920 * 0.9 && r.height >= 1080 * 0.9) return true;
    /* ② root 下唯一那个元素，就是解析时烘出来的那一页本身。
        源文档不是 1920×1080 时它并没有铺满画布（比如 1280×720 会缩在左上角），
        只按尺寸判断的话它就变成了「唯一可选对象」——
        实测此时点画布上任何位置都选中整个 section，一碰就被 pin。
        所以这里补一条结构性判断，与页面尺寸无关。 */
    return root.children.length === 1;
  }

  /* 该元素是否值得被选中 */
  function isSelectable(node, win) {
    if (!nodeVisible(node, win)) return false;
    var root = rootEl();
    if (!root || node === root || node === node.ownerDocument.body ||
        node === node.ownerDocument.documentElement) return false;
    if (node.hasAttribute('data-wd-skip')) return false;
    /* 行内文字片段不单独选中，交给它所在的块级容器 */
    if (isInlineTextTag(node, win)) return false;
    /* 整页底板不参与点选 */
    if (isPageBackdrop(node, win)) return false;

    if (!hasBlockChildren(node, win)) {
      /* 叶子：有文字、或者有绘制 */
      if ((node.textContent || '').trim()) return true;
      if (hasOwnPaint(node, win)) return true;
      return false;
    }
    /* 容器：必须**自身**有绘制（卡片、面板、色块）才算一个可摆放的对象。
       只是用来排版的外层壳子不该被选中，否则点在空白处就选中一个大盒子。
       这类壳子里的文字由 pickAt 的文本块回退负责命中。 */
    return hasOwnPaint(node, win);
  }

  /* 命中点位置上「最内层」的可选元素。
     注意不能只判断「祖先里有可选元素」：整个画布通常是一个带背景色的容器，
     它自身也算可选，于是任何点击都会命中最外层，永远选不到里面的卡片 / 标题。
     必须沿祖先链一路向上，取**最内层**那个。 */
  function deepestSelectable(node, win, stopAt) {
    var best = null, n = node, steps = 0;
    while (n && steps++ < 32) {
      if (n === stopAt) break;
      if (isSelectable(n, win)) best = n;
      n = n.parentElement;
    }
    return best;
  }

  /* 从命中点向上找出最适合选中的元素 */
  function pickAt(x, y) {
    var doc = frameDoc(), win = frameWin();
    if (!doc || !win) return null;
    var hit;
    try { hit = doc.elementFromPoint(x, y); } catch (e) { return null; }
    if (!hit) return null;
    var root = rootEl();
    if (!root || !root.contains(hit)) return null;

    /* ① 首选：命中点上「最内层」的可选元素（卡片、标题、图片本身…） */
    var best = deepestSelectable(hit, win, root);

    /* ② 文本块回退：命中点是排版壳子（无底色的 <section> / 包装 div）时，
       deepestSelectable 找不到任何可选元素，这时要落到该处的文字上。
       判据放宽为「二者在同一条祖先链上」，因为壳子与文字互为祖先/后代都有可能。 */
    var textBlock = null;
    if (hit && !isInlineTextTag(hit, win)) {
      var caret = null;
      if (typeof doc.caretPositionFromPoint === 'function') {
        caret = doc.caretPositionFromPoint(x, y);
      } else if (typeof doc.caretRangeFromPoint === 'function') {
        var cr = doc.caretRangeFromPoint(x, y);
        if (cr) caret = { offsetNode: cr.startContainer };
      }
      if (caret && caret.offsetNode) {
        var tn = caret.offsetNode;
        var host = tn.nodeType === 3 ? tn.parentElement : tn;
        var guard = 0;
        while (host && guard++ < 16) {
          if (isSelectable(host, win) && (host.textContent || '').trim() &&
              !isInlineTextTag(host, win)) { textBlock = host; break; }
          if (host === root) break;
          host = host.parentElement;
        }
      }
    }

    /* 容器 vs 文字块：什么时候该放弃容器、选中里面的文字？
       不能只看「容器有没有底色」—— ppt 页面里到处是带底色的包装层，
       那样会把卡片、色块都让出去，用户就再也点不中卡片了。
       更可靠的信号是**文本量**：
         · 真正的文字元素，自己的文字就是它的全部（h1 的字 === h1 的文字）
         · 包装壳子会包含很多别的元素，文字量远大于该处那一段
       所以：容器的文字量明显多于这里这段文字 → 它是壳子，让位；
       再加上「文字块自身有绘制」这一条（标签块），两种都是明确要让位的情况。
       若容器自带裸文本（公式 + <small>），则必须整体选中。 */
    var blockText = best ? normText(best.textContent) : '';
    var pickText = textBlock ? normText(textBlock.textContent) : '';
    var yieldsToText = !!textBlock && best && best !== textBlock &&
      !(best.contains(textBlock) && hasOwnText(best)) &&
      (pickText.length === 0 || blockText.length > pickText.length * 1.5 + 6);
    var preferText = !!textBlock && (
      !best ||
      (best === textBlock) ||
      yieldsToText ||
      !hasOwnPaint(best, win)
    );
    if (preferText) best = textBlock;
    if (!best) best = textBlock;
    if (!best) return null;

    return best;
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. 选择框绘制
     ══════════════════════════════════════════════════════════════════════ */

  /* 剔除已经不在当前舞台文档里的选区节点。
     撤销 / 重做 / 切页会重建 iframe 文档，旧的选区引用会变成游离节点：
     它们没有几何信息，继续留在 E.selection 里会让选择框错位或消失。 */
  function pruneSelection() {
    var doc = frameDoc();
    if (!doc || !E.selection.length) return;
    var alive = E.selection.filter(function (n) {
      return n && n.ownerDocument === doc && doc.contains(n);
    });
    if (alive.length !== E.selection.length) E.selection = alive;
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. 选择框绘制

     ⚠ 坐标系（这是「编辑框不准」的头号根因，改这里之前务必读完）

     DOM 结构是：
         .stage            ← 宽高 1920×1080，带 transform: scale(zoom)
           iframe#stage-frame
           .guides          ← 在 .stage 内
           .overlay         ← 在 .stage 内
             #frame-box / #marquee / #ov-toolbar

     也就是说 **.overlay 与 .guides 都在被缩放的 .stage 里面**，
     它们自身的 left/top/width/height 用的是「画布坐标」（1920×1080 的空间），
     浏览器最后会替你乘一次 zoom。

     如果这里再手动乘 zoom、再加舞台的屏幕偏移（sr.left / sr.top），
     缩放就被应用了两次：实测 zoom≈55% 时选择框只有正确尺寸的 30%，
     并且整体往右下偏出画布 —— 看起来就是「框和元素对不上」。
     所以本文件里所有写进 .overlay / .guides 的坐标，一律是**画布坐标**。
     ══════════════════════════════════════════════════════════════════════ */

  function refreshOverlay() {
    var box = $('frame-box');
    var label = $('ov-label');
    var bar = $('ov-toolbar');

    /* 选区可能指向上一份文档里的节点（撤销 / 重做 / 切页都会重建舞台文档）。
       这种游离节点 getBoundingClientRect() 全是 0，会让选择框缩成一点、
       或者干脆“消失”—— 先剔除掉，再决定是否显示。 */
    pruneSelection();

    if (!E.selection.length || E.editing) {
      box.hidden = true;
      bar.hidden = true;
      updateStatusSel();
      return;
    }

    /* 编辑框几何来自 visualBox（= 元素自己的盒子）。
       和 pinElement 用同一套测量，所以框、拖动、缩放、检查器数值、
       导出的 PPTX 形状说的是同一个矩形。 */
    var vb = visualBox(E.selection[0]);

    box.hidden = false;
    box.style.left = U.round(vb.x, 2) + 'px';
    box.style.top = U.round(vb.y, 2) + 'px';
    box.style.width = Math.max(1, U.round(vb.w, 2)) + 'px';
    box.style.height = Math.max(1, U.round(vb.h, 2)) + 'px';

    var multi = E.selection.length > 1;
    box.classList.toggle('multi', multi);
    /* 一维线条只保留左右两个手柄：上下的手柄在它身上没有意义，
       露出来只会让人拖了没反应（而且以为拖坏了）。 */
    var dead = multi ? null : WD.elements.deadHandles(E.selection[0]);
    $$('.handle', box).forEach(function (h) {
      var name = (h.className.match(/\bh-([a-z]+)\b/) || [])[1] || '';
      h.style.display = (multi || (dead && dead.indexOf(name) >= 0)) ? 'none' : '';
    });

    label.textContent = multi
      ? ('已选 ' + E.selection.length + ' 个元素')
      : (U.describeElement(E.selection[0]) + '  ' + Math.round(vb.w) + '×' + Math.round(vb.h));

    /* 浮动工具条放在选择框上方，空间不足则放到下方；同样用画布坐标并夹在画布内。
       宽高改成**实测**而不是写死常量：它会随图标尺寸、缩放一起变，
       而工具条本身做了 counter-scale，实测出来的正好是它在屏幕上真正占的尺寸
       （offsetWidth 不受祖先 transform 影响，而 scale 已被自身抵消）。
       写死的数字迟早和 CSS 对不上，夹取就会算错、工具条贴边被裁掉。 */
    bar.hidden = false;
    var barW = bar.offsetWidth || 168;
    var barH = bar.offsetHeight || 40;
    var barTop = vb.y - barH - 8;
    if (barTop < 0) barTop = vb.y + vb.h + 8;
    bar.style.left = Math.max(0, Math.min(W - barW, vb.x)) + 'px';
    bar.style.top = Math.max(0, Math.min(H - barH, barTop)) + 'px';

    /* 箭头 / 双箭头是「按当前尺寸现算 path」的：拖完手柄、改完填充色、
       撤销重做，都要重画一次。refreshOverlay 恰好是这些时机都会经过的地方。 */
    E.selection.forEach(function (n) { WD.elements.syncLine(n); });

    updateStatusSel();
  }

  function updateStatusSel() {
    var sb = $('sb-sel');
    if (!sb) return;
    if (!E.selection.length) { sb.textContent = '未选中元素'; return; }
    if (E.selection.length > 1) { sb.textContent = '已选 ' + E.selection.length + ' 个元素'; return; }
    var n = E.selection[0];
    sb.textContent = U.elementLabel(n);
  }

  function setSelection(nodes) {
    E.selection = (nodes || []).filter(Boolean);
    refreshOverlay();
    updateInspector();
    renderLayers();
  }

  function clearSelection() { setSelection([]); }

  /* ══════════════════════════════════════════════════════════════════════
     3.5 框选（rubber band）
     ══════════════════════════════════════════════════════════════════════ */

  var marqueeState = null;

  function startMarquee(ev) {
    if (E.editing) endTextEdit(true);
    marqueeState = {
      startX: ev.clientX, startY: ev.clientY,
      base: (ev.shiftKey || ev.ctrlKey || ev.metaKey) ? E.selection.slice() : [],
      additive: !!(ev.shiftKey || ev.ctrlKey || ev.metaKey),
      moved: false
    };
    /* 不要动 .stage-canvas 的 pointer-events：父元素一旦变成 none，
       子元素默认行为也跟着变，整个舞台就再也收不到鼠标事件了（踩过这个坑）。
       后续 pointermove / pointerup 由帧内监听转发过来，见 bindFrameEvents。 */
    window.addEventListener('pointermove', onMarqueeMove, true);
    window.addEventListener('pointerup', onMarqueeEnd, true);
    window.addEventListener('pointercancel', onMarqueeEnd, true);
    if (ev.preventDefault) ev.preventDefault();
  }

  /* 从帧内发起框选。
     画布几乎被 iframe 盖满，用户在空白处按下时事件是落在**帧文档**里的，
     父页的 stage-canvas 监听根本收不到 —— 所以必须由帧把起点换算成父页
     坐标后交给这里，框选才可能触发。 */
  function beginMarqueeFromFrame(ev) {
    var sr = E.stage.el.getBoundingClientRect();
    var s = E.stage.scale;
    startMarquee({
      clientX: sr.left + ev.clientX * s,
      clientY: sr.top + ev.clientY * s,
      shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey,
      preventDefault: function () { if (ev.preventDefault) ev.preventDefault(); }
    });
  }

  /* 拖动中更新框选矩形。
     起点已经由 startMarquee 换算成父页 client 坐标，
     所以帧内转发过来的事件也必须先换算（见 bindFrameEvents 的转发）。 */
  function onMarqueeMove(ev) {
    var m = marqueeState;
    if (!m) return;
    var dx = ev.clientX - m.startX;
    var dy = ev.clientY - m.startY;
    if (!m.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    m.moved = true;

    var box = $('marquee');
    var left = Math.min(m.startX, ev.clientX);
    var top = Math.min(m.startY, ev.clientY);
    var w = Math.abs(dx), h = Math.abs(dy);

    /* #marquee 在 .overlay 里，而 .overlay 在带 transform:scale() 的 .stage 内，
       所以写进去的必须是**画布坐标**。事件是父页 client 坐标，先换算。 */
    var sr = E.stage.el.getBoundingClientRect();
    var s = E.stage.scale || 1;
    var cx = (left - sr.left) / s;
    var cy = (top - sr.top) / s;
    var cw = w / s, ch = h / s;

    box.hidden = false;
    box.style.left = U.round(cx, 2) + 'px';
    box.style.top = U.round(cy, 2) + 'px';
    box.style.width = U.round(cw, 2) + 'px';
    box.style.height = U.round(ch, 2) + 'px';

    /* 命中测试直接用上面换算好的画布矩形 */
    m.canvas = { x: cx, y: cy, x2: cx + cw, y2: cy + ch };

    var picked = elementsInRect(m.canvas, ev.altKey);
    setSelection(m.additive ? uniqueNodes(m.base.concat(picked)) : picked);
  }

  function onMarqueeEnd() {
    var m = marqueeState;
    marqueeState = null;
    window.removeEventListener('pointermove', onMarqueeMove, true);
    window.removeEventListener('pointerup', onMarqueeEnd, true);
    window.removeEventListener('pointercancel', onMarqueeEnd, true);
    $('marquee').hidden = true;
    /* 没有真正拖动 → 视为空白处单击，取消选择 */
    if (m && !m.moved && !m.additive) clearSelection();
    refreshOverlay();
  }

  function uniqueNodes(list) {
    var seen = [];
    return list.filter(function (n) {
      if (!n || seen.indexOf(n) >= 0) return false;
      seen.push(n);
      return true;
    });
  }

  /* 与矩形相交的可选元素。
     默认只取画布的直接子元素（也就是「一张幻灯片上的各个块」），
     否则框一大片会把每个后代节点都选中，数量爆炸且没法用。
     按住 Alt 时下钻到任意深度，用于选中容器内部的元素。 */
  function elementsInRect(rect, allowNested) {
    var doc = frameDoc(), win = frameWin();
    var root = rootEl();
    if (!doc || !win || !root) return [];
    var out = [];
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (U.shouldSkip(n)) continue;
      if (!allowNested && n.parentElement !== root) continue;
      if (!nodeVisible(n, win)) continue;
      if (!isSelectable(n, win)) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      var intersects = !(r.right < rect.x || r.left > rect.x2 || r.bottom < rect.y || r.top > rect.y2);
      if (!intersects) continue;
      /* 已经收了某个祖先就不再收它的后代 */
      var covered = out.some(function (p) { return p !== n && p.contains(n); });
      if (covered) continue;
      out.push(n);
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════
     5. 定位固化（把元素变成画布内的绝对定位，便于拖动）

     ⚠ left/top 是相对**包含块**解析的，不是相对根元素。
     包含块 = 最近的「position 不是 static」的祖先（transform / filter 也会）。
     课件里到处都是 `position:relative` 的卡片壳，所以一个元素的包含块
     经常不是 [data-wd-root]。早期这里一律按 root 的偏移写 left/top，
     实测在兜底分页（single-body，根里堆着整篇 body）上：
     17 个元素里 12 个一被 pin 就跳位，div.cell 偏 (120,110)、h3 偏 (240,226) ——
     正好差一个「包含块相对根的偏移」。
     所以所有帧内坐标 ↔ left/top 的换算都必须过 containingBlock()。
     ══════════════════════════════════════════════════════════════════════ */

  /* 元素当前（或即将成为）的包含块基准。
     用于 `画布坐标 → left/top`：
       left = (x - cb.left) / cb.scale + cb.bl
     说明：
       · 绝对定位相对包含块的 **padding box**，而 getBoundingClientRect() 给的是
         border box，所以要把 border 宽度加回去（本地单位，不参与缩放）。
       · 包含块带 `transform: scale()` 时，它的 client 坐标是**已缩放**的，
         而 left/top 要用子元素本地的（未缩放）坐标，所以要先除以缩放比。
         页面整体归一化到画布之后就会走到这条分支，不除就会整份跳位。 */
  function containingBlock(node) {
    var root = rootEl();
    var cb = node.offsetParent || root;
    if (!cb) return { left: 0, top: 0, bl: 0, bt: 0, scale: 1 };
    var b = cb.getBoundingClientRect();
    var bl = 0, bt = 0, scale = 1;
    var win = frameWin();
    if (win && cb !== root) {
      try {
        var cs = win.getComputedStyle(cb);
        bl = parseFloat(cs.borderLeftWidth) || 0;
        bt = parseFloat(cs.borderTopWidth) || 0;
        var m = /matrix\(([^)]+)\)/.exec(cs.transform || '');
        if (m) {
          var p = m[1].split(',').map(parseFloat);
          var mx = Math.sqrt(p[0] * p[0] + p[1] * p[1]);
          if (mx > 0.001) scale = mx;      /* 只处理等比缩放 */
        }
      } catch (e) { /* 拿不到就按 1 处理 */ }
    }
    return { left: b.left, top: b.top, bl: bl, bt: bt, scale: scale };
  }

  /* 画布坐标 → 该元素的 left/top（写入前把 left/top/top/right/bottom 清干净） */
  function applyCanvasPos(node, x, y) {
    var cb = containingBlock(node);
    node.style.left = U.round((x - cb.left) / cb.scale + cb.bl, 2) + 'px';
    node.style.top = U.round((y - cb.top) / cb.scale + cb.bt, 2) + 'px';
  }

  function pinElement(node) {
    if (node.hasAttribute('data-wd-orig-pos')) return;
    var win = frameWin();
    var cs = win.getComputedStyle(node);
    var vp = visualBox(node);
    /* 包含块要在改成 absolute **之前**取：offsetParent 依赖当前的 position */
    var cb = containingBlock(node);

    node.setAttribute('data-wd-orig-pos', cs.position);
    if (cs.position === 'static') node.setAttribute('data-wd-orig-static', '1');

    var st = node.style;
    st.position = 'absolute';
    applyCanvasPos(node, vp.x, vp.y);
    st.right = 'auto';
    st.bottom = 'auto';
    st.margin = '0';

    /* 宽度策略（这是「文本框定位不准」的关键）：
       · 计算宽度是 auto（文字块常见）→ **不要**写 width。
         绝对定位 + 无宽度 = 收缩包裹，文字正好贴在 left 上。
         若强行写死宽度，行盒被撑宽，居中/右对齐的文字会整体平移。
       · 计算宽度是具体值或百分比 → 写死相同的值，保持原样。
       高度同理：auto 时不写，避免多一行空白。 */
    var cw = cs.width || '';
    var ch = cs.height || '';
    if (!/%$/.test(cw) && cw && cw !== 'auto') {
      if (st.width === '' || /%$/.test(st.width)) st.width = U.round(vp.w, 2) + 'px';
    } else {
      st.removeProperty('width');                 // 让它收缩包裹
    }
    if (!/%$/.test(ch) && ch && ch !== 'auto') {
      if (st.height === '' || /%$/.test(st.height)) st.height = U.round(vp.h, 2) + 'px';
    } else {
      st.removeProperty('height');
    }
    st.maxWidth = 'none';
    st.boxSizing = 'border-box';
  }

  /* 编辑框用的几何：元素自己的边框盒（帧内坐标）。

     这里曾经尝试过「块级文字元素改用文字行盒的并集」，理由是 block 元素默认撑满
     整行、框会显得过大。实测下来这条路是错的，已移除，原因有三条：

     1. 判断条件从来没生效过。`getComputedStyle().width` 永远是**解析后**的像素值
        （例如 "1088px"），既不会是 "auto" 也不会是 "50%"，
        所以下面那个分支恒为真，"贴文字"的代码一次都没跑过。
     2. 就算让它生效，也会让系统自相矛盾。选择框用行盒、而 beginDrag 的拖动原点、
        缩放手柄的落点、右侧检查器的 X/Y/宽/高、以及导出到 PPTX 的形状框
        全都按元素盒子算 —— 只有框换成文字行盒，拖动时框就会和指针「错位」，
        拖角时手柄也会脱离内容。
     3. 基准本身也不对。`Range.getClientRects()` 返回的是字体 ascent/descent
        撑出来的行**内**盒，通常比元素的行盒更高（示例课件 h1：行盒 145px、
        字体盒 175px），拿它当「视觉范围」会让框上下都比元素大一截。

     结论：编辑框 = 元素盒子。这样选择框、拖动、缩放、检查器数值、PPTX 形状
     五者共用同一个几何来源，才是真正「准」。
     保留这个函数是为了让「框的几何来源」在全文件里只有一个入口。 */
  function visualBox(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /* 把元素移到画布坐标 (x, y)。x/y 一律是**画布像素**（相对根元素左上角），
     这里负责换算成该元素包含块坐标系里的 left/top。 */
  function repositionElement(node, x, y) {
    pinElement(node);
    applyCanvasPos(node, x, y);
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. 拖动 / 缩放 / 旋转

     关键：拖动通常从 iframe 内部开始（用户在画布上按住元素），而 iframe 是
     独立文档 —— 在里面派发的 pointermove / pointerup **不会冒泡到父页 window**。
     早期版本只在父 window 上监听，结果 pointerup 永远收不到，拖动无法收尾：
     E.drag 一直是激活状态，连带把键盘微调、Delete、Ctrl+D、Shift 多选全部堵死。

     现在的做法：起始点与后续事件都统一成「点」对象（frame 坐标系下的画布像素），
     并在父 window、iframe 自身、以及帧内 document/window 上都挂监听，
     任何一个来源到达都能正确推进 / 收尾。
     ══════════════════════════════════════════════════════════════════════ */

  /* 把任意来源的指针事件规范化成统一结构（坐标统一到「父页 client 像素」，
     同时给出画布内坐标，方便命中测试与几何计算）。 */
  function normalizePoint(ev) {
    var fromFrame = false;
    var win = frameWin();
    if (win && ev.view === win) fromFrame = true;
    var r = E.stage.el.getBoundingClientRect();
    var cx = ev.clientX;
    var cy = ev.clientY;
    if (fromFrame) {
      /* 帧内坐标（帧视口 == 1920×1080 画布）→ 父页 client 像素 */
      cx = r.left + ev.clientX * E.stage.scale;
      cy = r.top + ev.clientY * E.stage.scale;
    }
    return {
      fromFrame: fromFrame,
      clientX: cx,
      clientY: cy,
      /* 父页 client 像素 → 画布像素 */
      canvasX: (cx - r.left) / E.stage.scale,
      canvasY: (cy - r.top) / E.stage.scale,
      altKey: !!ev.altKey,
      shiftKey: !!ev.shiftKey,
      ctrlKey: !!ev.ctrlKey || !!ev.metaKey,
      target: ev.target,
      raw: ev
    };
  }

  function beginDrag(mode, ev) {
    if (E.editing) endTextEdit(true);
    var win = frameWin();
    if (!win || !E.selection.length) return;

    var s = E.stage.scale;
    /* 这里**不要** pinElement。
       pointerdown 就 pin 的话，一次「点一下不拖」也会把元素改成绝对定位，
       于是它脱离文档流 —— 父级若是 auto 高度就会当场塌掉：
       实测某份课件上连点三下，父容器高度 376 → 222 → 151，一层比一层矮，
       整页排版错乱。pin 推迟到 onDragMove 里真正发生位移时再由
       repositionElement / 缩放分支去做。 */
    var items = E.selection.map(function (node) {
      var r = node.getBoundingClientRect();
      return {
        node: node,
        startX: r.left, startY: r.top, startW: r.width, startH: r.height,
        nodeX: r.left, nodeY: r.top
      };
    });

    var pt = normalizePoint(ev);

    E.drag = {
      mode: mode,
      startPointer: { x: pt.clientX, y: pt.clientY },
      scale: s,
      items: items,
      handle: mode === 'resize' ? ev.target && ev.target.getAttribute
        ? ev.target.getAttribute('data-h') : null : null,
      dirty: false,
      alt: pt.altKey,
      shift: pt.shiftKey,
      duplicated: false,
      originalHtml: null
    };

    $('frame-box').classList.add('dragging');
    attachDragListeners();
    /* 记录「按键按下时指针仍处于按下状态」，供键盘分支判断拖动是否真的还在进行 */
    E.drag.pointerDown = true;
    document.body.style.cursor = dragCursor(mode);
    var fdoc = frameDoc();
    if (fdoc) fdoc.body.style.cursor = dragCursor(mode);
  }

  function dragCursor(mode) {
    if (mode === 'rotate') return 'grabbing';
    if (mode === 'resize') return 'nwse-resize';
    return 'grabbing';
  }

  /* 同时在父页与帧内监听：事件可能来自任意一边 */
  function attachDragListeners() {
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', onDragEnd, true);
    window.addEventListener('pointercancel', onDragEnd, true);

    var doc = frameDoc();
    var win = frameWin();
    if (doc) {
      doc.addEventListener('pointermove', onDragMove, true);
      doc.addEventListener('pointerup', onDragEnd, true);
      doc.addEventListener('pointercancel', onDragEnd, true);
    }
    if (win) {
      win.addEventListener('pointerup', onDragEnd, true);
      win.addEventListener('blur', onDragEnd, true);
    }
    /* 兜底：鼠标在窗口外松开 / 焦点丢失时也要收尾，避免 E.drag 卡住 */
    window.addEventListener('blur', onDragEnd, true);
  }

  function detachDragListeners() {
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', onDragEnd, true);
    window.removeEventListener('pointercancel', onDragEnd, true);
    window.removeEventListener('blur', onDragEnd, true);

    var doc = frameDoc();
    var win = frameWin();
    if (doc) {
      doc.removeEventListener('pointermove', onDragMove, true);
      doc.removeEventListener('pointerup', onDragEnd, true);
      doc.removeEventListener('pointercancel', onDragEnd, true);
    }
    if (win) {
      win.removeEventListener('pointerup', onDragEnd, true);
      win.removeEventListener('blur', onDragEnd, true);
    }
  }

  function onDragMove(ev) {
    var d = E.drag;
    if (!d) return;
    var pt = normalizePoint(ev);
    var dx = (pt.clientX - d.startPointer.x) / d.scale;
    var dy = (pt.clientY - d.startPointer.y) / d.scale;

    if (!d.dirty && (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6)) d.dirty = true;

    if (d.mode === 'move') {
      /* Alt 拖动 = 复制 */
      if (pt.altKey && !d.duplicated) {
        d.duplicated = true;
        var clones = E.selection.map(function (n) {
          var c = n.cloneNode(true);
          c.removeAttribute('data-wd-orig-pos');
          c.removeAttribute('data-wd-orig-static');
          n.parentNode.insertBefore(c, n.nextSibling);
          return c;
        });
        setSelection(clones);
        d.items = clones.map(function (node) {
          var r = node.getBoundingClientRect();
          pinElement(node);
          return { node: node, startX: r.left, startY: r.top, startW: r.width, startH: r.height };
        });
      }
      /* 吸附：把落点与其它元素 / 画布的边和中心对齐（按住 Alt 临时关闭） */
      var snap = { dx: 0, dy: 0, guides: [] };
      if (!pt.altKey) {
        var mb = {
          x: d.items[0].startX + dx,
          y: d.items[0].startY + dy,
          w: d.items[0].startW,
          h: d.items[0].startH
        };
        snap = computeSnap(E.selection, mb, false);
      }
      var fdx = dx + snap.dx;
      var fdy = dy + snap.dy;
      /* 真正越过阈值才算拖动：手抖一下不该把元素改成绝对定位 */
      if (d.dirty) {
        d.items.forEach(function (it) {
          repositionElement(it.node, it.startX + fdx, it.startY + fdy);
        });
      }
      drawGuides(snap.guides);
    } else if (d.mode === 'resize') {
      var h = d.handle || 'se';
      d.items.forEach(function (it) {
        var nx = it.startX, ny = it.startY, nw = it.startW, nh = it.startH;
        var minW = 6, minH = 6;
        if (h.indexOf('e') >= 0) nw = Math.max(minW, it.startW + dx);
        if (h.indexOf('s') >= 0) nh = Math.max(minH, it.startH + dy);
        if (h.indexOf('w') >= 0) { nw = Math.max(minW, it.startW - dx); nx = it.startX + (it.startW - nw); }
        if (h.indexOf('n') >= 0) { nh = Math.max(minH, it.startH - dy); ny = it.startY + (it.startH - nh); }
        /* ★ 形状约束：圆形锁宽高比，线条锁高度。
           这一步以前根本不存在，于是「拖一下角」能把圆形拖成椭圆、
           能把一条线拖成一块色板 —— 不是用户拖错，是代码里没有这个概念。 */
        var start = { x: it.startX, y: it.startY, w: it.startW, h: it.startH };
        var next = { x: nx, y: ny, w: nw, h: nh };
        WD.elements.applyConstraint(it.node, start, next, h);
        nx = next.x; ny = next.y; nw = next.w; nh = next.h;
        pinElement(it.node);
        it.node.style.width = U.round(nw, 2) + 'px';
        it.node.style.height = U.round(nh, 2) + 'px';
        if (h.indexOf('w') >= 0 || h.indexOf('n') >= 0) repositionElement(it.node, nx, ny);
      });
    } else if (d.mode === 'rotate') {
      d.items.forEach(function (it) {
        var cx = it.startX + it.startW / 2;
        var cy = it.startY + it.startH / 2;
        var angle = Math.atan2(pt.canvasY - cy, pt.canvasX - cx) * 180 / Math.PI + 90;
        if (pt.shiftKey) angle = Math.round(angle / 15) * 15;
        var cur = it.node.style.transform || '';
        var base = cur.replace(/\s*rotate\([^)]*\)/g, '').trim();
        it.node.style.transform = (base ? base + ' ' : '') + 'rotate(' + U.round(angle, 2) + 'deg)';
        it.node.style.transformOrigin = '50% 50%';
        d.dirty = true;
      });
    }

    /* 阻止帧内文字被拖选 */
    if (pt.raw && pt.raw.preventDefault) pt.raw.preventDefault();

    refreshOverlay();
    updateInspectorValues();
  }
  function onDragEnd() {
    var d = E.drag;
    if (!d) { detachDragListeners(); return; }
    E.drag = null;
    detachDragListeners();
    clearGuides();
    document.body.style.cursor = '';
    /* 帧内光标也要复位：拖动时被设成 grabbing，收尾后清掉并按下次悬停重算，
       否则会出现「松手了光标还是抓手」的错觉。 */
    var fdoc = frameDoc();
    if (fdoc) {
      fdoc.body.style.cursor = '';
      E.hover = null;
    }
    $('frame-box').classList.remove('dragging');
    if (d && d.dirty) {
      commit(d.mode === 'resize' ? '调整大小' : d.mode === 'rotate' ? '旋转元素' : '移动元素');
    }
    refreshOverlay();
  }

  /* ══════════════════════════════════════════════════════════════════════
     6.5 对齐参考线与吸附

     拖动时把「被拖元素的边/中心」与「其它元素的边/中心 + 画布中心/边缘」
     比对，接近就吸附并画一条参考线。这是让手排版「看起来是对齐的」
     最关键的一环 —— 没有吸附，用户永远靠眼估。
     ══════════════════════════════════════════════════════════════════════ */

  var SNAP_PX = 6;          /* 吸附阈值（画布像素） */
  var snapState = null;

  function clearGuides() {
    var host = $('guides');
    if (host) host.innerHTML = '';
    snapState = null;
  }

  function guideLine(orient, canvasPos) {
    var host = $('guides');
    if (!host) return;
    /* .guides 与 .overlay 一样挂在带 transform:scale() 的 .stage 内，
       坐标就是画布坐标 —— 这里再乘一次 zoom，参考线就会与吸附到的元素错开。 */
    var px = Math.round(canvasPos);
    var el = document.createElement('div');
    el.className = 'guide ' + (orient === 'v' ? 'v' : 'h');
    if (orient === 'v') el.style.left = px + 'px';
    else el.style.top = px + 'px';
    host.appendChild(el);
  }

  /* 收集所有吸附候选位置（画布坐标） */
  function snapTargets(excludeNodes) {
    var root = rootEl();
    if (!root) return { v: [], h: [] };
    var v = [], h = [];
    /* 画布自身：左右边、水平中心；上下边、垂直中心 */
    v.push(0, W / 2, W);
    h.push(0, H / 2, H);
    var kids = root.children;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (excludeNodes.indexOf(n) >= 0) continue;
      if (U.shouldSkip(n)) continue;
      if (!nodeVisible(n, frameWin())) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      v.push(r.left, r.left + r.width / 2, r.left + r.width);
      h.push(r.top, r.top + r.height / 2, r.top + r.height);
    }
    return { v: v, h: h };
  }

  /* 给一组被拖元素算吸附偏移。movingBox 是「按当前鼠标位置算出的落点」。
     返回 {dx, dy, guides:[...]}，dx/dy 是需要追加的修正量。 */
  function computeSnap(nodes, movingBox, altKey) {
    if (altKey) return { dx: 0, dy: 0, guides: [] };
    var targets = snapTargets(nodes);
    var guides = [];
    var bestX = null, bestY = null;

    var edgesX = [movingBox.x, movingBox.x + movingBox.w / 2, movingBox.x + movingBox.w];
    var edgesY = [movingBox.y, movingBox.y + movingBox.h / 2, movingBox.y + movingBox.h];

    edgesX.forEach(function (ex) {
      targets.v.forEach(function (tx) {
        var d = tx - ex;
        if (Math.abs(d) <= SNAP_PX && (bestX === null || Math.abs(d) < Math.abs(bestX.d))) {
          bestX = { d: d, at: tx };
        }
      });
    });
    edgesY.forEach(function (ey) {
      targets.h.forEach(function (ty) {
        var d = ty - ey;
        if (Math.abs(d) <= SNAP_PX && (bestY === null || Math.abs(d) < Math.abs(bestY.d))) {
          bestY = { d: d, at: ty };
        }
      });
    });

    if (bestX) guides.push({ orient: 'v', pos: bestX.at });
    if (bestY) guides.push({ orient: 'h', pos: bestY.at });
    return { dx: bestX ? bestX.d : 0, dy: bestY ? bestY.d : 0, guides: guides };
  }

  function drawGuides(guides) {
    var host = $('guides');
    if (!host) return;
    host.innerHTML = '';
    (guides || []).forEach(function (g) { guideLine(g.orient, g.pos); });
  }

  /* ══════════════════════════════════════════════════════════════════════
     6.6 添加元素
     ══════════════════════════════════════════════════════════════════════ */

  var elementSeq = 0;

  function addElement(kind) {
    var root = rootEl();
    if (!root) { toast('请先打开一份 HTML 或新建页面', 'warn'); return null; }
    /* 图片 / 视频要先选文件，直接走各自的入口 */
    if (kind === 'image') { pickImageForElement(); return null; }
    if (kind === 'video') { pickVideoForElement(); return null; }
    /* 表格 / 公式 / 图表各有工厂，规格表里没有它们的静态形状 */
    if (kind === 'table') { openTableDialog(); return null; }
    if (kind === 'formula') { return insertFormula('a^2 + b^2 = c^2'); }
    if (kind === 'latex') { openLatexDialog(); return null; }
    if (kind === 'bar' || kind === 'chartline' || kind === 'pie') { return insertChart(kind); }

    var spec = ELEMENT_SPECS[kind];
    if (!spec) return null;
    var node = frameDoc().createElement(spec.tag);
    node.setAttribute('data-wd-added', kind);
    /* 让新元素可被选中：叶子需要文字或绘制样式 */
    var st = node.style;
    st.position = 'absolute';
    st.left = Math.round((W - spec.w) / 2) + 'px';
    st.top = Math.round((H - spec.h) / 2) + 'px';
    st.width = spec.w + 'px';
    st.height = spec.h + 'px';
    st.margin = '0';
    st.boxSizing = 'border-box';
    Object.keys(spec.style).forEach(function (k) { st[k] = spec.style[k]; });
    node.textContent = spec.text || '';
    if (spec.html) node.innerHTML = spec.html;
    /* 箭头 / 双箭头是自己画 SVG 的，边框盒子本身透明 */
    if (WD.elements.syncLine(node)) {
      st.overflow = 'visible';
    }

    node.style.zIndex = String(nextZ());
    root.appendChild(node);
    setSelection([node]);
    commit('添加' + spec.label);
    renderLayers();
    return node;
  }

  /* 元素规格表。
     形状的「拉伸约束」不在这里 —— 那是行为，由 WD.elements.constraintOf() 决定；
     这里只管长相和默认尺寸。
     圆形 circle 与椭圆 oval 是两种东西：circle 锁宽高比（怎么拖都是圆），
     oval 自由拉伸。 */
  var ELEMENT_SPECS = {
    /* 标题：四级 */
    title1: {
      tag: 'h1', label: '一级标题', w: 980, h: 140, text: '一级标题',
      style: { margin: '0', font: '800 92px/1.25 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', color: '#111c2b' },
    },
    title2: {
      tag: 'h2', label: '二级标题', w: 860, h: 118, text: '二级标题',
      style: { margin: '0', font: '700 68px/1.3 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', color: '#16233a' },
    },
    title3: {
      tag: 'h3', label: '三级标题', w: 760, h: 96, text: '三级标题',
      style: { margin: '0', font: '700 48px/1.35 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', color: '#1e2a3a' },
    },
    title4: {
      tag: 'h4', label: '四级标题', w: 680, h: 80, text: '四级标题',
      style: { margin: '0', font: '600 36px/1.4 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', color: '#33455e' },
    },
    /* 文本框：横向 / 竖向 */
    text: {
      tag: 'div', label: '横向文本框', w: 640, h: 90, text: '双击编辑文字',
      style: { font: '400 40px/1.4 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', color: '#1e2a3a' },
    },
    textv: {
      tag: 'div', label: '竖向文本框', w: 90, h: 460, text: '竖排文字',
      style: {
        font: '400 38px/1.5 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', color: '#1e2a3a',
        writingMode: 'vertical-rl', textOrientation: 'upright', letterSpacing: '4px',
      },
    },
    /* 基本形状 */
    rect: {
      tag: 'div', label: '矩形', w: 420, h: 260,
      style: { background: '#e8eef7', borderRadius: '0' },
    },
    round: {
      tag: 'div', label: '圆角矩形', w: 420, h: 260,
      style: { background: '#e8eef7', borderRadius: '20px' },
    },
    circle: {
      tag: 'div', label: '圆形', w: 260, h: 260,
      style: { background: '#dce7f5', borderRadius: '50%' },
    },
    oval: {
      tag: 'div', label: '椭圆', w: 340, h: 210,
      style: { background: '#dce7f5', borderRadius: '50%' },
    },
    triangle: {
      tag: 'div', label: '三角形', w: 320, h: 270,
      style: { background: '#dce7f5', clipPath: 'polygon(50% 0%, 100% 100%, 0% 100%)' },
    },
    para: {
      tag: 'div', label: '平行四边形', w: 400, h: 250,
      style: { background: '#dce7f5', clipPath: 'polygon(24% 0%, 100% 0%, 76% 100%, 0% 100%)' },
    },
    /* 一维线条：高度锁死，拖角也不会变成二维色块。
       箭头 / 双箭头由 WD.elements.syncLine() 生成固定尺寸的箭头 + 可拉伸的杆。 */
    line: {
      tag: 'div', label: '直线', w: 620, h: 6,
      style: { background: '#3b6fd4' },
    },
    arrow: {
      tag: 'div', label: '箭头', w: 620, h: 26,
      style: { background: 'transparent' },
    },
    dblarrow: {
      tag: 'div', label: '双向箭头', w: 620, h: 26,
      style: { background: 'transparent' },
    },
    /* 表格 / 公式 / 图表走各自的工厂，不在规格表里 */
  };

  /* ══════════════════════════════════════════════════════════════════════
     5.5 表格 / 公式 / 图表
     ══════════════════════════════════════════════════════════════════════ */

  /* 选中元素落位：优先居中，避开已经放了很多东西的中线 */
  function placeAtCenter(node, w, h) {
    node.style.left = Math.round((W - w) / 2) + 'px';
    node.style.top = Math.round((H - h) / 2) + 'px';
  }

  function insertTable(rows, cols) {
    var root = rootEl();
    if (!root) { toast('请先打开一份 HTML 或新建页面', 'warn'); return null; }
    var node = WD.elements.buildTable(frameDoc(), rows, cols, { w: 1000 });
    placeAtCenter(node, 1000, 56 * rows);
    node.style.zIndex = String(nextZ());
    root.appendChild(node);
    setSelection([node]);
    commit('插入表格');
    renderLayers();
    return node;
  }

  function openTableDialog() {
    var R = '<input class="input num" id="tbl-r" value="3" min="1" max="40">';
    var C = '<input class="input num" id="tbl-c" value="3" min="1" max="20">';
    showModal({
      title: '插入表格',
      html: '<div class="form-row"><span class="form-lbl">行数</span>' + R + '</div>' +
            '<div class="form-row"><span class="form-lbl">列数</span>' + C + '</div>' +
            '<p class="form-tip">行 1–40，列 1–20。插入后仍可在右栏增删行列。</p>',
      buttons: [
        { label: '取消' },
        { label: '插入', primary: true, onClick: function () {
          var r = parseInt(($('tbl-r') || {}).value, 10);
          var c = parseInt(($('tbl-c') || {}).value, 10);
          insertTable(isNaN(r) ? 3 : r, isNaN(c) ? 3 : c);
        } },
      ],
    });
  }

  /* 公式：插入空公式占位，双击进编辑；LaTeX 源码实时重解析。

     公式就是**一个文本框**：不要底色、不要虚线框、不要圆角 ——
     套一层卡片壳之后，它在 PPT 页面上看起来就像一个贴上去的控件，而不是排版的一部分。
     要改底色时用检查器的「填充」，和任何文字元素一样。 */
  function insertFormula(src, atCenter) {
    var root = rootEl();
    if (!root) { toast('请先打开一份 HTML 或新建页面', 'warn'); return null; }
    var node = frameDoc().createElement('div');
    node.setAttribute('data-wd-added', 'formula');
    node.setAttribute('data-wd-latex', src || '');
    var st = node.style;
    st.position = 'absolute';
    st.width = '560px';
    st.height = '120px';
    st.display = 'grid';
    st.placeItems = 'center';
    st.background = 'transparent';
    st.border = 'none';
    st.color = '#111c2b';
    st.font = '400 34px/1.4 "Cambria Math", Georgia, serif';
    st.overflow = 'visible';
    placeAtCenter(node, 560, 120);
    node.style.zIndex = String(nextZ());
    node.innerHTML = WD.elements.latexToMathML(src || '');
    root.appendChild(node);
    setSelection([node]);
    commit('插入公式');
    renderLayers();
    return node;
  }

  /* LaTeX 公式：弹窗输入，带实时预览，OK 之后插进画布 */
  function openLatexDialog() {
    var preset = 'E = m c^2';
    showModal({
      title: '插入 LaTeX 公式',
      html: '<div class="form-row"><span class="form-lbl">LaTeX</span>' +
            '<input class="input" id="tex-src" value="' + preset.replace(/"/g, '&quot;') +
            '" placeholder="例如 \\frac{a}{b} + \\sqrt{x}"></div>' +
            '<div class="tex-preview" id="tex-preview"></div>' +
            '<p class="form-tip">支持分数、上下标、根号、希腊字母、常用符号与 sin/log 等函数名。' +
            '解析在本地完成，不联网。</p>',
      buttons: [
        { label: '常用示例', onClick: function () {
          var i = $('tex-src');
          if (i) { i.value = '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}'; refreshTexPreview(); }
        } },
        { label: '取消' },
        { label: '插入', primary: true, keepOpen: false, onClick: function () {
          var v = ($('tex-src') || {}).value || '';
          if (!v.trim()) { toast('公式内容不能为空', 'warn'); return; }
          insertFormula(v);
        } },
      ],
    });
    var src = $('tex-src');
    if (src) {
      src.addEventListener('input', refreshTexPreview);
      refreshTexPreview();
      src.focus();
      src.select();
    }
  }

  function refreshTexPreview() {
    var p = $('tex-preview');
    if (!p) return;
    var v = ($('tex-src') || {}).value || '';
    p.innerHTML = v.trim() ? WD.elements.latexToMathML(v) : '<span class="muted">预览</span>';
  }

  /* 图表：canvas 画好导出 PNG，按普通图片插入 —— 位置/尺寸照常可改，
     缩略图与 PPTX 导出都不用再单独适配一遍矢量。

     但它不是「一张烤死的图」：数据 JSON 存在 data-wd-chart 属性里，
     双击弹出数据表编辑器，改完立刻用同一套绘制逻辑重画。
     属性能存住，是因为同步进工程文件时整个 DOM 都会被序列化。 */
  function insertChart(kind) {
    var root = rootEl();
    if (!root) { toast('请先打开一份 HTML 或新建页面', 'warn'); return null; }
    var cv = document.createElement('canvas');
    cv.width = 960; cv.height = 560;
    var data = WD.elements.defaultChartData(kind);
    WD.elements.drawChart(kind, cv, data);
    var img = frameDoc().createElement('img');
    img.setAttribute('data-wd-added', 'chart-' + kind);
    img.setAttribute('data-wd-chart-kind', kind);
    img.setAttribute('data-wd-chart', JSON.stringify(data));
    img.src = cv.toDataURL('image/png');
    var st = img.style;
    st.position = 'absolute';
    st.width = '860px';
    st.height = '502px';
    placeAtCenter(img, 860, 502);
    st.zIndex = String(nextZ());
    root.appendChild(img);
    setSelection([img]);
    commit('插入图表');
    renderLayers();
    return img;
  }

  /* 重画一张图表：数据改了以后走这里，尺寸不变、位置不变 */
  function repaintChart(img, data) {
    if (!img) return;
    var kind = img.getAttribute('data-wd-chart-kind') || 'bar';
    var cv = document.createElement('canvas');
    cv.width = 960; cv.height = 560;
    var norm = WD.elements.normalizeChartData(data, kind);
    WD.elements.drawChart(kind, cv, norm);
    img.setAttribute('data-wd-chart', JSON.stringify(norm));
    img.src = cv.toDataURL('image/png');
  }

  /* 双击图表 → 数据表编辑器。
     分类与数值都用逗号分隔的自由输入框：一行一个系列，改起来比表格控件快得多，
     真要正经填表再插一张新图不迟。 */
  function openChartDialog(img) {
    if (!img) return;
    var kind = img.getAttribute('data-wd-chart-kind') || 'bar';
    var raw = null;
    try { raw = JSON.parse(img.getAttribute('data-wd-chart') || 'null'); } catch (e) { raw = null; }
    var d = WD.elements.normalizeChartData(raw, kind);
    var titleName = '图表标题';
    var labelName = '分类';

    function seriesField(s, i) {
      return '<div class="chart-row">' +
        '<input class="input" id="cs-n' + i + '" value="' + U.escapeHtml(s.name) + '" placeholder="系列名称">' +
        '<input class="input" id="cs-v' + i + '" value="' + U.escapeHtml(s.data.join(', ')) +
        '" placeholder="' + (kind === 'pie' ? '各分类的数值' : '与分类一一对应的数值') + '">' +
        '</div>';
    }

    var html = '<div class="form-row"><span class="form-lbl">图表标题</span>' +
      '<input class="input" id="ch-title" value="' + U.escapeHtml(d.title) + '" placeholder="留空则不画标题"></div>' +
      '<div class="form-row"><span class="form-lbl">' + labelName + '</span>' +
      '<input class="input" id="ch-labels" value="' + U.escapeHtml(d.labels.join(', ')) + '" placeholder="用逗号分隔，如 一月, 二月, 三月"></div>' +
      '<div class="form-row"><span class="form-lbl">系列与数值</span></div>' +
      d.series.map(seriesField).join('') +
      '<div class="form-row chart-opts">' +
      '<label class="chk"><input type="checkbox" id="ch-legend"' + (d.showLegend ? ' checked' : '') + '> 显示图例</label>' +
      '<label class="chk"><input type="checkbox" id="ch-values"' + (d.showValues ? ' checked' : '') + '> 显示数值</label>' +
      '</div>' +
      '<p class="form-tip">' + titleName + '、图例、坐标轴文字与数值都会画进图里；' +
      '双击图表随时可以再进来改。</p>';

    showModal({
      title: '编辑图表数据',
      html: html,
      buttons: [
        { label: '取消' },
        { label: '恢复示例数据', onClick: function () {
          repaintChart(img, WD.elements.defaultChartData(kind));
          commit('恢复示例图表');
          toast('已恢复为示例数据', 'ok');
        } },
        /* keepOpen:true —— 校验没过时对话框要留在原地，不能顺手把用户填的内容一起关掉 */
        { label: '应用', primary: true, keepOpen: true, onClick: function () {
          var labels = ($('ch-labels') || {}).value || '';
          var parts = labels.split(/[,，]/).map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
          if (!parts.length) { toast('至少要有一个分类', 'warn'); return; }
          var series = [];
          for (var i = 0; i < d.series.length; i++) {
            var nm = ($('cs-n' + i) || {}).value;
            var vv = ($('cs-v' + i) || {}).value || '';
            series.push({
              name: (nm == null ? '' : nm).trim() || d.series[i].name,
              color: d.series[i].color,
              data: vv.split(/[,，\s]+/).filter(function (s) { return s !== ''; }),
            });
          }
          repaintChart(img, {
            title: (($('ch-title') || {}).value || '').trim(),
            labels: parts,
            series: series,
            showLegend: !!($('ch-legend') || {}).checked,
            showValues: !!($('ch-values') || {}).checked,
          });
          commit('修改图表数据');
          toast('图表已更新', 'ok');
          hideModal();
        } },
      ],
    });
  }

  /* 插入图片：文件 → dataURL → 直接写进画布 */
  function pickImageForElement() {
    var input = $('image-input');
    if (!input) return;
    input.value = '';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var root = rootEl();
        if (!root) return;
        var img = frameDoc().createElement('img');
        img.setAttribute('data-wd-added', 'image');
        img.src = String(reader.result);
        var st = img.style;
        st.position = 'absolute';
        st.left = '240px'; st.top = '240px';
        st.maxWidth = '1440px'; st.maxHeight = '800px';
        st.zIndex = String(nextZ());
        root.appendChild(img);
        setSelection([img]);
        commit('插入图片');
        renderLayers();
      };
      reader.readAsDataURL(f);
    };
    input.click();
  }

  /* 插入视频：文件 → objectURL 播放 + 抓一帧当封面。
     三点必须说清楚，否则会做出「看起来能用、存下来就废」的假功能：
     · 视频本体**不内嵌**进工程文件（动辄几十 MB，单文件 HTML 撑不住），
       工程里只留封面图。所以重新打开工程后视频播不了了，但版面和缩略图仍然正确。
     · 导出 PPTX 时它和「渐变 / 阴影 / 旋转」一样按**封面贴图**处理，不可再编辑。
       真正的可编辑视频需要写 OOXML 的 p:pic + 媒体关系与嵌入文件，不在当前范围内。
     · 封面不能「无脑抓第 0 帧」—— 见下面 shot() 里的注释。 */
  function pickVideoForElement() {
    var input = $('video-input');
    if (!input) return;
    input.value = '';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var root = rootEl();
      if (!root) return;
      var url = URL.createObjectURL(f);
      var v = frameDoc().createElement('video');
      v.setAttribute('data-wd-added', 'video');
      v.setAttribute('controls', '');
      v.setAttribute('preload', 'metadata');
      v.setAttribute('playsinline', '');
      v.src = url;
      var st = v.style;
      st.position = 'absolute';
      st.left = '240px'; st.top = '240px';
      st.width = '720px'; st.height = '405px';
      st.objectFit = 'cover';
      st.background = '#000';
      st.borderRadius = '8px';
      st.zIndex = String(nextZ());
      root.appendChild(v);
      setSelection([v]);
      renderLayers();
      /* 首帧抓成封面：画布、缩略图、PPTX 贴图都靠它。
         但**别无条件信第 0 帧**：实测 MediaRecorder 录出的 WebM、以及不少
         摄像头/转码流，解出来的第一帧整幅纯黑（非黑像素 0%），
         在那上面抓封面 = 画布、缩略图、导出的 PPTX 全变成黑块。
         所以先量再抓：缩到 32×18 抽样，非黑像素低于 2% 判为废帧，
         往后 seek 换时间点重抓；实在抓不到才认了。 */
      var shot = function () {
        try {
          var c = frameDoc().createElement('canvas');
          c.width = v.videoWidth || 720; c.height = v.videoHeight || 405;
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          /* 抽样统计很便宜：缩到 32×18 再数，避免 4K 视频 getImageData 撑爆内存 */
          var t = frameDoc().createElement('canvas');
          t.width = 32; t.height = 18;
          var g2 = t.getContext('2d');
          g2.drawImage(c, 0, 0, 32, 18);
          var d = g2.getImageData(0, 0, 32, 18).data;
          var lit = 0;
          for (var i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > 42) lit++;
          }
          if (lit / (32 * 18) < 0.02) return null;
          return c.toDataURL('image/jpeg', .82);
        } catch (e) { return null; }
      };
      var settled = false, bailTimer = null;
      var finish = function (poster) {
        if (settled) return;
        settled = true;
        if (bailTimer) clearTimeout(bailTimer);
        if (poster) v.setAttribute('poster', poster);
        v.removeAttribute('preload');
        commit('插入视频');
        scheduleThumbs();
      };
      /* OFFSETS[0] 是当前位置；第 i 轮是废帧就去 OFFSETS[i+1] 再抓。
         （别写成 if (!t) —— 0 会被当成假值，第一张废帧就白白放弃了。） */
      var OFFSETS = [0, 0.12, 0.3, 0.6];
      var attempt = function (i) {
        var url = shot();
        if (url) { finish(url); return; }
        if (i + 1 >= OFFSETS.length) { finish(null); return; }
        var t = OFFSETS[i + 1];
        var end = (v.seekable && v.seekable.length) ? v.seekable.end(v.seekable.length - 1) : 0;
        /* 极短视频 / 还在直播的源没有可 seek 的区间，别在这儿空等 */
        if (end <= t) { finish(null); return; }
        v.addEventListener('seeked', function () { attempt(i + 1); }, { once: true });
        try { v.currentTime = t; } catch (e) { finish(null); }
      };
      /* 兜底：seeked 万一不来，也别让这个元素永远缺封面、永远不提交 */
      bailTimer = setTimeout(function () { finish(shot() || null); }, 5000);
      if (v.readyState >= 2) attempt(0);
      else {
        v.addEventListener('loadeddata', function () { attempt(0); }, { once: true });
        v.addEventListener('error', function () { finish(null); }, { once: true });
      }
    };
    input.click();
  }

  /* ══════════════════════════════════════════════════════════════════════
     6.7 图层面板
     ══════════════════════════════════════════════════════════════════════ */

  var LAYER_ICONS = {
    IMG: '▣', SVG: '◆', CANVAS: '◆', H1: 'T', H2: 'T', H3: 'T', H4: 'T',
    P: '¶', UL: '≣', OL: '≣', TABLE: '▦', HR: '─', BUTTON: '▰', SPAN: '▰',
  };

  /* 按绘制顺序（先 DOM 后 z-index）列出画布的直接子元素 */
  function layerNodes() {
    var root = rootEl();
    if (!root) return [];
    var list = Array.prototype.filter.call(root.children, function (n) {
      return !U.shouldSkip(n);
    });
    return list.map(function (n, i) { return { node: n, domIndex: i }; })
      .sort(function (a, b) {
        var za = zOf(a.node), zb = zOf(b.node);
        if (za !== null && zb !== null && za !== zb) return za - zb;
        if (za !== null && zb === null) return 1;
        if (za === null && zb !== null) return -1;
        return a.domIndex - b.domIndex;
      })
      .map(function (x) { return x.node; });
  }

  function layerLabel(node) {
    var txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 22);
    var tag = node.tagName;
    var map = { DIV: '容器', IMG: '图片', SVG: '图形', P: '段落', H1: '标题', H2: '标题', SPAN: '标签' };
    return map[tag] || tag.toLowerCase();
  }

  function renderLayers() {
    var host = $('layer-list');
    if (!host) return;
    var nodes = layerNodes();
    var countEl = $('layers-count');
    if (countEl) countEl.textContent = nodes.length ? nodes.length + ' 个' : '';
    host.innerHTML = '';
    if (!nodes.length) return;

    /* 视觉上「上层在上」，所以倒序显示 */
    nodes.slice().reverse().forEach(function (n) {
      var row = el('div', {
        class: 'layer-item' + (isSelected(n) ? ' active' : '') +
          (n.style.display === 'none' ? ' hidden-layer' : ''),
        draggable: 'true',
        title: layerLabel(n),
      });
      row.appendChild(el('span', { class: 'layer-ico', text: LAYER_ICONS[n.tagName] || '▢' }));
      row.appendChild(el('span', { class: 'layer-name', text: layerLabel(n) }));

      var lockBtn = el('button', {
        class: 'layer-btn' + (n.hasAttribute('data-wd-locked') ? ' on' : ''),
        title: n.hasAttribute('data-wd-locked') ? '解锁' : '锁定',
        text: n.hasAttribute('data-wd-locked') ? '🔒' : '🔓',
      });
      lockBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setSelection([n]);
        toggleLockSelection();
        renderLayers();
      });
      row.appendChild(lockBtn);

      var eyeBtn = el('button', {
        class: 'layer-btn' + (n.style.display === 'none' ? '' : ' on'),
        title: n.style.display === 'none' ? '显示' : '隐藏',
        text: n.style.display === 'none' ? '◌' : '◉',
      });
      eyeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setSelection([n]);
        applyStyle({ display: n.style.display === 'none' ? '' : 'none' }, '切换可见性');
        renderLayers();
      });
      row.appendChild(eyeBtn);

      row.addEventListener('click', function (e) {
        if (e.shiftKey) {
          if (isSelected(n)) setSelection(E.selection.filter(function (x) { return x !== n; }));
          else setSelection(E.selection.concat([n]));
        } else {
          setSelection([n]);
        }
        renderLayers();
      });
      row.addEventListener('dblclick', function () {
        setSelection([n]);
        if ((n.textContent || '').trim()) beginTextEdit(n);
      });

      /* 拖动重排图层 */
      row.addEventListener('dragstart', function (e) {
        E.layerDrag = n;
        try { e.dataTransfer.setData('text/plain', 'wd-layer'); } catch (err) { /* ignore */ }
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', function (e) {
        if (!E.layerDrag || E.layerDrag === n) return;
        e.preventDefault();
        var r = row.getBoundingClientRect();
        var above = (e.clientY - r.top) < r.height / 2;
        row.classList.toggle('layer-drop-above', above);
        row.classList.toggle('layer-drop-below', !above);
      });
      row.addEventListener('dragleave', function () {
        row.classList.remove('layer-drop-above', 'layer-drop-below');
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        var src = E.layerDrag;
        E.layerDrag = null;
        row.classList.remove('layer-drop-above', 'layer-drop-below');
        if (!src || src === n) return;
        var r = row.getBoundingClientRect();
        var above = (e.clientY - r.top) < r.height / 2;
        reorderLayer(src, n, above);
      });

      host.appendChild(row);
    });
  }

  /* 把 src 放到 ref 的上方 / 下方（「上方」在绘制顺序里意味着更晚绘制） */
  function reorderLayer(src, ref, above) {
    var parent = ref.parentNode;
    if (src.parentNode !== parent) return;
    if (above) parent.insertBefore(src, ref.nextSibling);
    else parent.insertBefore(src, ref);
    refreshOverlay();
    renderLayers();
    commit('调整图层顺序');
  }

  /* ══════════════════════════════════════════════════════════════════════
     7. 文字编辑
     ══════════════════════════════════════════════════════════════════════ */

  var PLAIN_TEXT_OK = (function () {
    try {
      var d = document.createElement('div');
      d.setAttribute('contenteditable', 'plaintext-only');
      return d.contentEditable === 'plaintext-only';
    } catch (e) { return false; }
  })();

  /* 排版文字：找到该点上真正该编辑的那个块。
     坑：不能只认「双击命中的那个元素」。课件里的标题经常是
     `<h1>文字<em>强调</em></h1>` 这种中间夹着行内标签的写法，
     `pickAt` 会返回最内层的 <em>，而 <em> 是行内排版标签、根本不该单独选中，
     结果就是「双击标题进不去编辑」，用户只能反复双击试。
     所以这里从命中的节点往上找到最近的可编辑文字块。 */
  function textBlockFor(node, x, y) {
    var win = frameWin();
    var n = node;
    while (n && n !== rootEl()) {
      /* 表格单元格：不管有没有文字都算一个可编辑的块。
         下面那条「必须有文字」是为了防止误选容器，但对空单元格正好是反效果 ——
         空单元格没有文字 → 被跳过 → 往上落到整张表 → 表又有块级子元素 → 彻底找不到。 */
      if (n.tagName === 'TD' || n.tagName === 'TH') return n;
      if (isSelectable(n, win) && (n.textContent || '').trim() && !hasBlockChildren(n, win)) return n;
      n = n.parentElement;
    }
    /* 命中的元素自己就有块级子元素 → 往里找真正的那段文字 */
    if (node && x != null) {
      var inner = pickTextBlockInside(node, x, y);
      if (inner) return inner;
    }
    return null;
  }

  function beginTextEdit(node, caretXY) {
    if (!node) return;
    endTextEdit(true);
    E.editing = node;
    E.editingBackup = node.innerHTML;
    node.setAttribute('contenteditable', PLAIN_TEXT_OK ? 'plaintext-only' : 'true');
    node.setAttribute('spellcheck', 'false');
    node.setAttribute('data-wd-editing', '1');
    node.style.cursor = 'text';
    /* 显式放开选中：课件里常写了 user-select:none（为了做遮罩层），
       不覆盖掉的话双击选词、拖选整段全都失效 —— 就是「很难操作」的另一半。 */
    node.style.userSelect = 'text';
    node.style.webkitUserSelect = 'text';

    /* ⚠ 顺序很关键：必须**先 focus 再设选区**。
       反过来做（先 addRange 再 focus）时，focus 会把刚设的光标冲掉，
       表现为「双击进去了但光标乱跳 / 选不中想选的字」——非常难用。 */
    node.focus({ preventScroll: true });

    var sel = frameWin().getSelection();
    var range = frameDoc().createRange();
    if (caretXY) {
      /* 落在双击的那个词上，而不是每次都跳到末尾 */
      var r = caretPositionAt(node, caretXY.x, caretXY.y);
      if (r) { sel.removeAllRanges(); sel.addRange(r); }
      else { range.selectNodeContents(node); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
    } else {
      range.selectNodeContents(node);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    node.addEventListener('keydown', onEditKeyDown, true);
    node.addEventListener('blur', onEditBlur, true);
    node.addEventListener('input', onEditInput, true);
    refreshOverlay();
    setStatusHint('编辑文字中：Enter 换行 · Esc 结束 · 点空白处也可结束');
  }

  /* 双击选词：按双击点定位到具体位置，失败则退回节点末尾 */
  function caretPositionAt(node, x, y) {
    var win = frameWin();
    var doc = frameDoc();
    try {
      if (win.caretPositionFromPoint) {
        var pos = win.caretPositionFromPoint(x, y);
        /* 只在命中子树之内才采信，否则会跳到无关的兄弟节点上 */
        if (pos && pos.offsetNode && node.contains(pos.offsetNode)) {
          var r = doc.createRange();
          r.setStart(pos.offsetNode, pos.offset);
          r.collapse(true);
          return r;
        }
      } else if (doc.caretRangeFromPoint) {
        var r2 = doc.caretRangeFromPoint(x, y);
        if (r2 && node.contains(r2.startContainer)) return r2;
      }
    } catch (e) { /* 拿不到就退回末尾 */ }
    return null;
  }

  function onEditInput() {
    if (!E.editing) return;
    store.setDirty(true);
    refreshOverlaySoon();
  }

  function onEditKeyDown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      endTextEdit(true);
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      endTextEdit(true);
    }
    ev.stopPropagation();
  }

  function onEditBlur() {
    setTimeout(function () {
      if (E.editing) endTextEdit(true);
    }, 0);
  }

  function endTextEdit(apply) {
    var node = E.editing;
    if (!node) return;
    E.editing = null;
    node.removeEventListener('keydown', onEditKeyDown, true);
    node.removeEventListener('blur', onEditBlur, true);
    node.removeEventListener('input', onEditInput, true);
    node.removeAttribute('contenteditable');
    node.removeAttribute('data-wd-editing');
    node.removeAttribute('spellcheck');
    node.style.cursor = '';
    node.style.userSelect = '';
    node.style.webkitUserSelect = '';
    setStatusHint(null);

    if (apply) {
      if (node.innerHTML !== E.editingBackup) {
        commit('修改文字');
      } else {
        syncSlideDoc();
      }
    } else {
      node.innerHTML = E.editingBackup;
    }
    refreshOverlay();
  }

  /* ══════════════════════════════════════════════════════════════════════
     8. 键盘
     ══════════════════════════════════════════════════════════════════════ */

  /* 判断按键是否应该由「正在输入的输入框」吞掉。
     注意：不能用 ev.target —— 事件从 iframe 冒泡过来时 target 可能是 body 或帧里的元素，
     并不等于真正的焦点元素。以 document.activeElement 为准，并且只对
     真正需要输入的控件放行（复选框、按钮、颜色选择器不该吞掉 Delete / 方向键）。 */
  function isTypingTarget(ev) {
    var ae = document.activeElement;
    if (!ae) return false;
    var tag = ae.tagName;
    var type = (ae.getAttribute && ae.getAttribute('type') || '').toLowerCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      return type === 'text' || type === 'number' || type === 'search' ||
             type === 'url' || type === 'email' || type === 'password' || type === '';
    }
    if (ae.isContentEditable) return true;
    if (ae === document.body) return false;
    /* 兜底：事件目标本身是文本输入控件 */
    var t = ev && ev.target;
    if (t && t.tagName === 'INPUT') {
      var tt = (t.getAttribute && t.getAttribute('type') || '').toLowerCase();
      return tt === 'text' || tt === 'number' || tt === 'search' || tt === '' || tt === undefined;
    }
    return false;
  }

  function onKeyDown(ev) {
    if (!$('modal').hidden || !$('present').hidden) return;
    var mod = ev.ctrlKey || ev.metaKey;

    /* 防御：正常情况下拖动结束会把 E.drag 清空。
       万一某条路径漏了收尾（指针在窗口外松开、焦点被抢走等），
      E.drag 会一直挂着，而下面大部分分支都以「不在拖动中」为前提 ——
      结果就是快捷键集体失灵。宁可丢掉一次拖动，也不能让编辑器卡死。 */
    if (E.drag && !E.drag.pointerDown) {
      onDragEnd();
    }

    /* 纯输入框：只有「不需要修饰键」的那批快捷键让路；
       Ctrl+S / Ctrl+E 这类全局快捷键仍然生效，否则用户在输入框里按 Ctrl+S 会毫无反应。 */
    if (isTypingTarget(ev) && !mod) {
      if (ev.key === 'Escape') { /* 允许 Esc 收起面板 */ }
      else return;
    }

    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); doRedo(); return; }
    if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveProject(); return; }
    if (mod && ev.key.toLowerCase() === 'o') { ev.preventDefault(); $('file-input').click(); return; }
    if (mod && ev.key.toLowerCase() === 'e') { ev.preventDefault(); doExportPptx(); return; }
    if (mod && ev.key.toLowerCase() === 'a') {
      if (E.selection.length) { ev.preventDefault(); E.selection[0].focus(); }
      return;
    }
    if (mod && ev.key.toLowerCase() === 'd') {
      if (E.selection.length) { ev.preventDefault(); duplicateSelection(); }
      return;
    }
    if (mod && ev.key.toLowerCase() === 'c') {
      if (E.selection.length) { ev.preventDefault(); copySelection(); }
      return;
    }
    if (mod && ev.key.toLowerCase() === 'v') {
      if (E.clipboard) { ev.preventDefault(); pasteSelection(); }
      return;
    }
    /* 图层顺序：Ctrl+] 上移一层，Ctrl+[ 下移一层 */
    if (mod && (ev.key === ']' || ev.key === '}')) {
      if (E.selection.length) { ev.preventDefault(); layerAction('up'); }
      return;
    }
    if (mod && (ev.key === '[' || ev.key === '{')) {
      if (E.selection.length) { ev.preventDefault(); layerAction('down'); }
      return;
    }
    /* ? 打开快捷键一览（Shift+/ 也是 ?） */
    if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) {
      ev.preventDefault();
      showShortcuts();
      return;
    }
    if (ev.key === 'Escape') {
      if (E.editing) { endTextEdit(true); return; }
      if (E.selection.length) { clearSelection(); return; }
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (E.selection.length && !E.editing) { ev.preventDefault(); deleteSelection(); }
      return;
    }
    if (/^Arrow/.test(ev.key)) {
      if (!E.selection.length || E.editing) return;
      ev.preventDefault();
      var step = ev.shiftKey ? 10 : 1;
      var dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      var dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      E.selection.forEach(function (n) {
        var r = n.getBoundingClientRect();
        repositionElement(n, r.left + dx, r.top + dy);
      });
      refreshOverlay();
      updateInspectorValues();
      nudgePending = true;
      debouncedNudgeCommit();
      return;
    }
    /* 页面导航 */
    if (ev.key === 'PageDown' || (mod && ev.key === 'ArrowDown')) { ev.preventDefault(); goSlide(store.current + 1); }
    if (ev.key === 'PageUp' || (mod && ev.key === 'ArrowUp')) { ev.preventDefault(); goSlide(store.current - 1); }
    if (mod && ev.key === '0') { ev.preventDefault(); E.stage.fit(); updateZoomLabel(); }
    /* 顶栏的「面板」按钮已移除，一键显隐两侧改用 Ctrl+\ */
    if (mod && ev.key === '\\') { ev.preventDefault(); if (E.toggleBothPanels) E.toggleBothPanels(); }
    if (mod && (ev.key === '=' || ev.key === '+')) { ev.preventDefault(); E.stage.zoomBy(1.15); updateZoomLabel(); }
    if (mod && ev.key === '-') { ev.preventDefault(); E.stage.zoomBy(1 / 1.15); updateZoomLabel(); }
    if (ev.key === 'F5') { ev.preventDefault(); startPresent(); }
  }

  /* 微调的落库被延迟了 500ms（避免按住方向键时历史栈刷屏），
     但模型里的 slide.doc 在这 500ms 内还是旧的。
     用户若在这段时间里按 Ctrl+Z，`store.undo()` 会因为 `hIndex === 0` 直接返回 false，
     表现为「撤销没反应」；等 debounce 到点，又把**改动之后**的快照推进去，
     于是之后按撤销也回不到原位 —— 实测就是「怎么按都没用」。

     所以凡是**要读模型**的动作（撤销 / 重做 / 保存 / 导出）都必须先把待办的落库做掉。 */
  var nudgePending = false;
  var debouncedNudgeCommit = U.debounce(function () {
    if (!nudgePending) return;
    nudgePending = false;
    commit('微调位置');
  }, 500);

  function flushNudgeCommit() {
    if (!nudgePending) return;
    nudgePending = false;
    commit('微调位置');
  }

  /* ══════════════════════════════════════════════════════════════════════
     9. 元素操作
     ══════════════════════════════════════════════════════════════════════ */

  function deleteSelection() {
    if (!E.selection.length) return;
    E.selection.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    clearSelection();
    commit('删除元素');
    toast('已删除元素', 'ok', 1600);
  }

  function duplicateSelection() {
    if (!E.selection.length) return;
    var clones = E.selection.map(function (n) {
      var c = n.cloneNode(true);
      c.removeAttribute('data-wd-orig-pos');
      c.removeAttribute('data-wd-orig-static');
      n.parentNode.insertBefore(c, n.nextSibling);
      var st = c.style;
      if (st.position === 'absolute') {
        st.left = (U.parsePx(st.left, 0) + 24) + 'px';
        st.top = (U.parsePx(st.top, 0) + 24) + 'px';
      }
      return c;
    });
    setSelection(clones);
    commit('复制元素');
  }

  var clip = null;
  function copySelection() { E.clipboard = E.selection.map(function (n) { return n.cloneNode(true); }); toast('已复制 ' + E.clipboard.length + ' 个元素', 'ok', 1600); }

  function pasteSelection() {
    if (!E.clipboard || !E.clipboard.length) return;
    var root = rootEl();
    var clones = E.clipboard.map(function (n) {
      var c = n.cloneNode(true);
      c.removeAttribute('data-wd-orig-pos');
      c.removeAttribute('data-wd-orig-static');
      var st = c.style;
      if (st.position === 'absolute') {
        st.left = (U.parsePx(st.left, 0) + 32) + 'px';
        st.top = (U.parsePx(st.top, 0) + 32) + 'px';
      }
      root.appendChild(c);
      return c;
    });
    setSelection(clones);
    commit('粘贴元素');
  }

  /* 图层顺序。
     早期版本只实现了 front/back，菜单里的「上移一层 / 下移一层」直接落空；
     而且它只改 z-index —— 对本来没有 z-index 的兄弟元素完全无效
     （z-index:auto 的元素按 DOM 顺序绘制，光设 z-index 不会赢过它们）。
     所以：先按绘制顺序做兄弟重排，再补一次 z-index 兜底。 */
  function paintedOrder(node) {
    var root = rootEl();
    if (!root) return [];
    return Array.prototype.filter.call(root.children, function (c) {
      return !U.shouldSkip(c) && isSelectable(c, frameWin());
    });
  }

  function zOf(node) {
    var z = parseInt(node.style.zIndex, 10);
    return isNaN(z) ? null : z;
  }

  function layerAction(kind) {
    if (!E.selection.length) return;
    var root = rootEl();
    if (!root) return;

    if (kind === 'front' || kind === 'back') {
      E.selection.forEach(function (n) {
        n.style.zIndex = String(kind === 'front' ? nextZ() : nextZ(true));
        if (kind === 'front') root.appendChild(n);
        else root.insertBefore(n, root.firstChild);
      });
      refreshOverlay();
      commit(kind === 'front' ? '置于顶层' : '置于底层');
      return;
    }

    /* up / down：与相邻的同级元素交换绘制顺序 */
    var moved = 0;
    E.selection.forEach(function (n) {
      var domSibs = Array.prototype.slice.call(n.parentNode.children);
      var domIdx = domSibs.indexOf(n);
      if (kind === 'up') {
        if (domIdx < 0 || domIdx >= domSibs.length - 1) return;
        var after = domSibs[domIdx + 1];
        n.parentNode.insertBefore(after, n);
        var zn = zOf(n), za = zOf(after);
        /* 两者都有显式 z-index 时，光换 DOM 顺序不够，z-index 也要交换 */
        if (zn !== null && za !== null && zn >= za) {
          n.style.zIndex = String(za);
          after.style.zIndex = String(zn);
        }
      } else {
        if (domIdx <= 0) return;
        var before = domSibs[domIdx - 1];
        n.parentNode.insertBefore(n, before);
        var zn2 = zOf(n), zb = zOf(before);
        if (zn2 !== null && zb !== null && zn2 <= zb) {
          n.style.zIndex = String(zb);
          before.style.zIndex = String(zn2);
        }
      }
      moved++;
    });
    if (!moved) { toast(kind === 'up' ? '已经在最上层了' : '已经在最下层了', 'info', 1500); return; }
    refreshOverlay();
    updateInspectorValues();
    commit(kind === 'up' ? '上移一层' : '下移一层');
  }

  var zCounter = 1000;
  function nextZ(back) { return back ? --zCounter - 1000 : ++zCounter; }

  /* 对齐 / 分布（多选时相对选区包围盒，单选时相对画布） */
  function alignAction(kind) {
    if (!E.selection.length) return;
    var s = E.stage.scale;
    var boxes = E.selection.map(function (n) {
      var r = n.getBoundingClientRect();
      return { node: n, x: r.left, y: r.top, w: r.width, h: r.height };
    });
    var bounds;
    if (boxes.length > 1) {
      bounds = boxes.reduce(function (a, b) {
        var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
        var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }, { x: Infinity, y: Infinity, w: 0, h: 0 });
    } else {
      bounds = { x: 0, y: 0, w: W, h: H };
    }

    if (kind === 'dist-h' || kind === 'dist-v') {
      if (boxes.length < 3) { toast('分布需要至少 3 个元素', 'warn'); return; }
      var horiz = kind === 'dist-h';
      /* 按位置排序后，用「第一个起点 → 最后一个终点」作为分布区间。
         不要用外接矩形：两者在正常数据下等价，但写清楚意图后
         不会因为 extents 计算方式变化而悄悄错位。 */
      boxes.sort(function (a, b) { return horiz ? a.x - b.x : a.y - b.y; });
      var first = boxes[0];
      var last = boxes[boxes.length - 1];
      var start = horiz ? first.x : first.y;
      var end = horiz ? (last.x + last.w) : (last.y + last.h);
      var total = boxes.reduce(function (n, b) { return n + (horiz ? b.w : b.h); }, 0);
      var gap = (end - start - total) / (boxes.length - 1);
      var cursor = start;
      boxes.forEach(function (b) {
        if (horiz) repositionElement(b.node, cursor, b.y);
        else repositionElement(b.node, b.x, cursor);
        cursor += (horiz ? b.w : b.h) + gap;
      });
    } else {
      boxes.forEach(function (b) {
        var nx = b.x, ny = b.y;
        if (kind === 'left') nx = bounds.x;
        else if (kind === 'hcenter') nx = bounds.x + (bounds.w - b.w) / 2;
        else if (kind === 'right') nx = bounds.x + bounds.w - b.w;
        else if (kind === 'top') ny = bounds.y;
        else if (kind === 'vcenter') ny = bounds.y + (bounds.h - b.h) / 2;
        else if (kind === 'bottom') ny = bounds.y + bounds.h - b.h;
        repositionElement(b.node, nx, ny);
      });
    }
    refreshOverlay();
    updateInspectorValues();
    commit('对齐元素');
  }

  /* ══════════════════════════════════════════════════════════════════════
     10. 缩略图轨
     ══════════════════════════════════════════════════════════════════════ */

  var thumbTimer = null;

  function scheduleThumbs() {
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(function () { renderRailThumbs(); }, 220);
  }

  /* 重建左栏。
     这里原来每次都 `rail.innerHTML = ''` 再逐个重建，而缩略图是**异步**回填的：
     commit() 里 renderRail() 与 scheduleThumbs() 还会连着各触发一次。
     于是旧的那批 `.then` 回调会把 <img> 写进已经脱离文档的 .thumb-box，
     新建的盒子一个图都没有 —— 表现就是左栏「没渲染全」/闪一下才出来。
     现在：页数与页 id 都没变时**原地更新**，只动 active 态与标题；
     只有增删页 / 换文档时才整体重建。 */
  function renderRail() {
    var rail = $('rail');
    var empty = $('rail-empty');
    if (!store.model) {
      rail.innerHTML = '';
      empty.hidden = false;
      $('slide-count').textContent = '0';
      return;
    }
    empty.hidden = true;
    $('slide-count').textContent = String(store.count());

    var slides = store.model.slides;
    var items = $$('.rail-item', rail);
    var sameShape = items.length === slides.length &&
      items.every(function (it, i) { return it.getAttribute('data-id') === slides[i].id; });

    if (sameShape) {
      items.forEach(function (it, i) {
        it.classList.toggle('active', i === store.current);
        it.setAttribute('data-index', String(i));
        it.title = slides[i].title || slides[i].name;
        var num = it.querySelector('.rail-num');
        if (num) num.textContent = String(i + 1);
      });
    } else {
      rail.innerHTML = '';
      slides.forEach(function (slide, i) {
        rail.appendChild(buildRailItem(slide, i));
      });
    }

    /* 两条路径都要刷缩略图 —— 早前只在「全量重建」那条路上刷，
       于是「原地更新」之后左栏就不再更新缩略图了。 */
    scheduleThumbs();

    var active = rail.querySelector('.rail-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function buildRailItem(slide, i) {
    var box = el('div', { class: 'thumb-box' });
    var item = el('div', {
      class: 'rail-item' + (i === store.current ? ' active' : ''),
      'data-index': i,
      'data-id': slide.id,
      draggable: 'true',
      title: slide.title || slide.name,
      onclick: function (ev) {
        if (ev.target.closest('.rail-actions')) return;
        goSlide(i);
      }
    }, [
      box,
      el('span', { class: 'rail-num', text: String(i + 1) }),
      el('div', { class: 'rail-actions' }, [
        el('button', { class: 'mini-btn', title: '复制此页', text: '⧉', onclick: function (ev) { ev.stopPropagation(); store.duplicateSlide(i); goSlide(store.current); } }),
        el('button', { class: 'mini-btn', title: '删除此页', text: '✕', onclick: function (ev) { ev.stopPropagation(); doDeleteSlide(i); } })
      ])
    ]);

    item.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(i));
      item.classList.add('drag-src');
    });
    item.addEventListener('dragend', function () {
      item.classList.remove('drag-src');
      $$('.rail-item').forEach(function (n) {
        n.classList.remove('drag-over-before', 'drag-over-after');
      });
    });
    item.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      var r = item.getBoundingClientRect();
      var after = ev.clientY > r.top + r.height / 2;
      item.classList.toggle('drag-over-after', after);
      item.classList.toggle('drag-over-before', !after);
    });
    item.addEventListener('dragleave', function () {
      item.classList.remove('drag-over-before', 'drag-over-after');
    });
    item.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
      if (isNaN(from)) return;
      var r = item.getBoundingClientRect();
      var after = ev.clientY > r.top + r.height / 2;
      var to = after ? i + 1 : i;
      if (from < to) to--;
      if (from === to) return;
      store.moveSlide(from, to);
      goSlide(store.current);
    });

    return item;
  }

  /* 缩略图异步回填。
     每次调用领一个 generation 号，回调落地时按当前真实状态判断这张图还能不能用：
       · generation 过期 → 左栏被重建过，这批作废（下一批会重新生成）
       · 生成时是「当前页」、落地时已经翻页 → 实时截图作废，**退回静态缩略图**
       · 盒子被换掉（重排 / 换文档）→ 作废
     关键：翻页这种「图本身还有效、只是来源不对」的情况要**换源重算**而不是直接丢弃 ——
     早前这里直接 return，结果上一页的缩略图永远空着（表现为「有页面没内容」）。 */
  var thumbGen = 0;
  function renderRailThumbs() {
    var rail = $('rail');
    if (!rail || !store.model) return;
    var gen = ++thumbGen;
    var items = $$('.rail-item', rail);
    items.forEach(function (item) {
      var i = parseInt(item.getAttribute('data-index'), 10);
      var slide = store.slideAt(i);
      if (!slide) return;
      var box = item.querySelector('.thumb-box');
      if (!box) return;

      function put(url) {
        if (!url) return;
        if (gen !== thumbGen) return;
        if (!item.parentNode || item.getAttribute('data-index') !== String(i)) return;
        var old = box.querySelector('.thumb-poster');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        box.appendChild(el('img', { class: 'thumb-poster', src: url, alt: '' }));
      }

      var isCurrent = (i === store.current) && E.stage && E.stage.ready;
      var job = isCurrent ? liveStagePreview() : WD.render.thumbnail(slide);
      job.then(function (url) {
        /* 翻页了：这张实时截图不能用了，但这一格不能就这么空着 —— 退回静态缩略图 */
        if (isCurrent && i !== store.current) {
          WD.render.thumbnail(slide).then(put);
          return;
        }
        put(url);
      });
    });
  }

  /* 当前页直接用舞台里已经布局好的 DOM 生成缩略图，编辑时即时可见 */
  function liveStagePreview() {
    var root = E.stage.getRoot();
    var win = E.stage.getWin();
    if (!root || !win) return WD.render.thumbnail(store.slide());
    return WD.render.rasterizeRootSlice(root, win, WD.render.THUMB_WIDTH)
      .then(function (canvas) { return canvas ? canvas.toDataURL('image/png') : null; })
      .catch(function () { return WD.render.thumbnail(store.slide()); });
  }

  /* ══════════════════════════════════════════════════════════════════════
     11. 页面导航与舞台装载
     ══════════════════════════════════════════════════════════════════════ */

  var loadingToken = 0;

  function loadStage() {
    var slide = store.slide();
    if (!slide || !E.stage) return Promise.resolve();
    var token = ++loadingToken;
    clearSelection();
    E.editing = null;
    /* 有内容时要收起空状态遮罩，否则它盖在舞台上方 */
    $('stage-empty').hidden = true;
    /* 底部状态条的「放映」按钮同理：没有文档可放映时不出现 */
    $('btn-present').hidden = false;
    return E.stage.setHtml(slide.doc).then(function () {
      if (token !== loadingToken) return;
      bindFrameEvents();
      updateStatus();
      updateInspector();
      refreshOverlay();
      renderLayers();
      clearGuides();
    });
  }

  function goSlide(i) {
    if (!store.model) return;
    var n = store.count();
    if (i < 0 || i >= n) return;
    syncSlideDoc();
    store.goto(i);
    renderRail();
    loadStage().then(function () {
      /* 缩略图必须在**舞台装载完成之后**刷新。
         当前页的缩略图是拿活的舞台 DOM 栅格化的，
         在 loadStage() 之前刷会把上一页的画面当成这一页的缩略图。 */
      renderRailThumbs();
    });
  }

  function bindFrameEvents() {
    var doc = frameDoc();
    if (!doc || doc.__wdBound === E.stage.frame) return;
    doc.__wdBound = E.stage.frame;

    doc.addEventListener('pointerdown', onFramePointerDown, true);
    doc.addEventListener('pointermove', onFramePointerMove, true);
    doc.addEventListener('pointerleave', onFramePointerLeave, true);
    doc.addEventListener('dblclick', onFrameDblClick, true);

    /* 框选是在帧内起手的，后续 pointermove / pointerup 同样落在帧里，
       父页 window 收不到 —— 这里把它们换算成父页坐标后转交给框选逻辑。 */
    doc.addEventListener('pointermove', function (ev) {
      if (!marqueeState) return;
      var sr = E.stage.el.getBoundingClientRect();
      var s = E.stage.scale;
      onMarqueeMove({
        clientX: sr.left + ev.clientX * s,
        clientY: sr.top + ev.clientY * s,
        altKey: ev.altKey,
        preventDefault: function () { if (ev.preventDefault) ev.preventDefault(); }
      });
    }, true);
    doc.addEventListener('pointerup', function () {
      if (marqueeState) onMarqueeEnd();
    }, true);
    doc.addEventListener('pointercancel', function () {
      if (marqueeState) onMarqueeEnd();
    }, true);
    doc.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      openContextMenu(ev.clientX, ev.clientY);
    }, true);
    /* 阻止帧内链接跳转 */
    doc.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (a) { ev.preventDefault(); toast('编辑态下不会跳转链接：' + a.getAttribute('href'), 'info', 2200); }
    }, true);

    /* 键盘桥接：点进画布后焦点会落在 iframe 上，此时按键事件在**帧文档**里派发，
       父页 window 完全收不到 —— 表现就是「点一下画布之后 Delete / 方向键 / Ctrl+D 全部失灵」。
       把帧内的 keydown 转交给父页处理，保证快捷键不依赖于焦点落在哪一侧。 */
    doc.addEventListener('keydown', function (ev) {
      if (ev.__wdBridged) return;
      /* 文本编辑态交给 beginTextEdit 自己的处理器，避免重复处理 */
      if (E.editing) return;
      var clone = {
        key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey,
        shiftKey: ev.shiftKey, altKey: ev.altKey, target: ev.target,
        preventDefault: function () { ev.preventDefault(); },
        stopPropagation: function () { ev.stopPropagation(); },
        __wdBridged: true
      };
      onKeyDown(clone);
    }, true);
  }

  function onFramePointerDown(ev) {
    if (ev.button !== 0) return;
    var doc = frameDoc();
    if (E.editing && E.editing.contains(ev.target)) return;

    /* 格式刷优先：在改变选区之前套用样式 */
    if (painter) {
      var ptarget = pickAt(ev.clientX, ev.clientY);
      if (ptarget && tryPaint(ptarget)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }

    E.selectionBefore = E.selection.length;
    var hit = pickAt(ev.clientX, ev.clientY);
    if (!hit) {
      if (E.editing) endTextEdit(true);
      /* 空白处按下：不直接清空选区，而是开始框选。
         单击（没拖动）时由 onMarqueeEnd 收尾为「取消选择」，
         拖动则框选 —— 一处逻辑同时覆盖两种意图。 */
      beginMarqueeFromFrame(ev);
      return;
    }
    if (E.editing) {
      if (E.editing === hit) return;
      endTextEdit(true);
    }

    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      if (isSelected(hit)) setSelection(E.selection.filter(function (n) { return n !== hit; }));
      else setSelection(E.selection.concat([hit]));
    } else if (!isSelected(hit)) {
      setSelection([hit]);
    }

    ev.preventDefault();
    ev.stopPropagation();
    beginDrag('move', ev);
  }

  function onFramePointerMove(ev) {
    if (E.drag || E.editing) return;
    var doc = frameDoc();
    if (!doc) return;
    var hit = pickAt(ev.clientX, ev.clientY);
    /* 光标直接由本次命中结果决定，不做「变化才更新」的短路 ——
       空白处 pickAt 返回 null（假值），配合 hover 缓存很容易漏掉一次更新，
       结果就是「从元素移到空白，光标还停在 move」。 */
    E.hover = hit;
    /* 光标按「这里能做什么」来给：
       有文字 → text（双击就能改字），
       只是色块 / 图片 → move（拖得动），
       空白 → crosshair（可以拉框选）。 */
    doc.body.style.cursor = !hit ? 'crosshair' : hoverCursorFor(hit);
  }

  function hoverCursorFor(node) {
    if (!node) return 'crosshair';
    var locked = node.hasAttribute('data-wd-locked');
    if ((node.textContent || '').trim()) return 'text';
    return locked ? 'not-allowed' : 'move';
  }

  function onFramePointerLeave() {
    E.hover = null;
    var doc = frameDoc();
    if (doc && !E.drag) doc.body.style.cursor = '';
  }

  /* 命中的那个点所在的表格单元格（表格里点任何一格都算）。
     必须用 elementFromPoint 直接问，不能靠 pickAt —— pickAt 命中的是**整张表**
     （单击要选表才能拖动），而双击进编辑要的是「哪一格」。 */
  function cellAt(x, y) {
    var doc = frameDoc();
    if (!doc) return null;
    var hit;
    try { hit = doc.elementFromPoint(x, y); } catch (e) { return null; }
    var n = hit, guard = 0;
    while (n && guard++ < 8) {
      if (n.tagName === 'TD' || n.tagName === 'TH') return n;
      n = n.parentElement;
    }
    return null;
  }

  function onFrameDblClick(ev) {
    var hit = pickAt(ev.clientX, ev.clientY);
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();

    /* 图表：双击是「改数据」，不是「改字」 */
    if (hit.hasAttribute && hit.hasAttribute('data-wd-chart')) {
      setSelection([hit]);
      openChartDialog(hit);
      return;
    }

    /* 表格：双击落在**哪一格**就编辑哪一格。
       空单元格没有文字，原来那条「必须有文字才认」的规则会直接把它跳过，
       表现就是「只有第一行能填，后面全进不去」。 */
    var cell = cellAt(ev.clientX, ev.clientY);
    if (cell) {
      setSelection([cell]);
      beginTextEdit(cell, { x: ev.clientX, y: ev.clientY });
      return;
    }

    setSelection([hit]);
    /* 一律走 textBlockFor：不管 pickAt 命中的是标题本体、还是中间的 <em> 行内标签，
       都能落到真正可编辑的那块文字上；双击点带给 beginTextEdit 用来落光标。 */
    var block = textBlockFor(hit, ev.clientX, ev.clientY);
    if (block) {
      if (block !== hit) setSelection([block]);
      beginTextEdit(block, { x: ev.clientX, y: ev.clientY });
    } else {
      setStatusHint('这个元素没有可直接编辑的文字，先选中里面的子元素再双击');
    }
  }

  function pickTextBlockInside(node, x, y) {
    var win = frameWin();
    var walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, null);
    var n, best = null;
    while ((n = walker.nextNode())) {
      if (!isSelectable(n, win)) continue;
      if ((n.textContent || '').trim() && !hasBlockChildren(n, win)) {
        var r = n.getBoundingClientRect();
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) {
          if (!best || n.contains(best)) best = n;
        }
      }
    }
    return best;
  }

  function updateStatus() {
    var slide = store.slide();
    $('sb-slide').textContent = slide ? ('第 ' + (store.current + 1) + ' / ' + store.count() + ' 页 · ' + (slide.title || '')) : '—';
    $('sb-size').textContent = W + ' × ' + H + ' px';
    updateZoomLabel();
  }

  function updateZoomLabel() {
    if (!E.stage) return;
    $('zoom-label').textContent = Math.round(E.stage.scale * 100) + '%';
  }

  function setStatusHint(text) {
    $('sb-hint').textContent = text || '提示：双击元素改文字 · 拖动移动 · 角点缩放';
  }

  var refreshOverlaySoon = (function () {
    var pending = false;
    return function () {
      if (pending) return;
      pending = true;
      U.raf(function () { pending = false; refreshOverlay(); });
    };
  })();

  /* ══════════════════════════════════════════════════════════════════════
     12. 属性检查器
     ══════════════════════════════════════════════════════════════════════ */

  var SWATCHES = [
    '#ffffff', '#f5f7fa', '#e3e8ef', '#8b95a4', '#5b6472', '#31445c', '#1e2a3a', '#10141a', '#000000',
    '#f2994a', '#f7a600', '#ef4444', '#c9302c', '#ec4899', '#a855f7', '#5b8def', '#2f80ed', '#0ea5e9',
    '#27ae60', '#84cc16', '#eab308', '#fde68a', '#fee2e2', '#dbeafe', '#d1fae5', '#f3e8ff', 'transparent'
  ];

  function initSwatches() {
    var host = $('swatches');
    if (!host) return;
    host.innerHTML = '';
    SWATCHES.forEach(function (c) {
      var b = el('button', {
        class: 'swatch',
        title: c,
        onclick: function () {
          if (c === 'transparent') {
            applyStyle({ backgroundColor: '' });
          } else {
            applyStyle({ backgroundColor: c });
          }
        }
      });
      if (c === 'transparent') {
        b.style.background = 'repeating-conic-gradient(#e3e8ef 0% 25%, #ffffff 0% 50%) 50% / 8px 8px';
      } else {
        b.style.backgroundColor = c;
      }
      host.appendChild(b);
    });
  }

  function initFontOptions() {
    var sel = $('f-font');
    if (!sel) return;
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: '（继承）' }));
    var used = collectFonts();
    var list = used.concat(U.CJK_FONTS.filter(function (f) { return used.indexOf(f) < 0; }));
    list.forEach(function (f) {
      sel.appendChild(el('option', { value: f, text: f }));
    });
  }

  function collectFonts() {
    var doc = frameDoc();
    var out = [];
    if (!doc) return out;
    var seen = Object.create(null);
    var nodes = doc.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var cs;
      try { cs = frameWin().getComputedStyle(nodes[i]); } catch (e) { continue; }
      var fam = U.primaryFamily(cs.fontFamily);
      if (fam && !seen[fam]) { seen[fam] = true; out.push(fam); }
      if (out.length > 14) break;
    }
    return out;
  }

  function updateInspector() {
    var hasModel = !!store.model;
    $('sec-slide').hidden = !hasModel;
    var hasSel = E.selection.length > 0 && !E.editing;
    $('sec-element').hidden = !hasSel;
    $('sec-empty').hidden = hasSel || !hasModel;
    $('insp-title').textContent = hasSel ? '元素属性' : '幻灯片属性';
    updateCtxBar(hasModel, hasSel);
    updateFormatBar();

    /* 幻灯片区 */
    if (hasModel) {
      var slide = store.slide();
      var bg = slideBackground();
      var hex = bg ? U.toHex(bg) : '#ffffff';
      var st = $('f-slide-bg');
      if ($('f-slide-bg-text') !== document.activeElement) {
        st.value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff';
        $('f-slide-bg-text').value = bg ? (U.isOpaque(bg) ? U.toHex(bg) : U.toHexA(bg)) : 'transparent';
      }
      $('f-notes').value = slide.notes || '';
      $('f-slide-layout').value = slide.layout || 'blank';
      $('btn-slide-del').disabled = store.count() <= 1;
      $('btn-slide-up').disabled = store.current === 0;
      $('btn-slide-down').disabled = store.current >= store.count() - 1;
    }

    if (hasSel) updateInspectorValues();
    updateHistoryButtons();
  }

  /* 第二行上下文操作栏：跟着选区换内容。
     和右栏共用同一批控件节点，所以这里只管「显不显示」，不管「显示什么值」——
     值一律由 updateInspectorValues() 写，两边永远一致。 */
  function updateCtxBar(hasModel, hasSel) {
    var bar = $('ctx-bar');
    if (!bar) return;
    /* 整条栏跟着「有没有文档」走：没有文档时第二行没有任何可操作的东西，
       留一条空行只会把画布往下推。 */
    bar.hidden = !hasModel;
    $('ctx-slide').hidden = hasSel;
    $('ctx-el').hidden = !hasSel;
    if (!hasSel) return;
    /* 表格专属的行列增删：只有真的选中表格时才有意义 */
    var isTable = !!(E.selection[0] && E.selection[0].tagName === 'TABLE');
    var tt = $('tbl-tools');
    if (tt) tt.hidden = !isTable;
    var sep = $('ctx-sep-table');
    if (sep) sep.hidden = !isTable;
  }

  function slideBackground() {
    var root = rootEl();
    if (!root) return null;
    var cs = frameWin().getComputedStyle(root);
    return U.parseColor(cs.backgroundColor);
  }

  function updateHistoryButtons() {
    $('btn-undo').disabled = !store.canUndo();
    $('btn-redo').disabled = !store.canRedo();
    /* 未保存提示挂在文件名胶囊上（前面一个点），原先顶栏左侧的独立徽章已撤掉。
       点本身没有文字，得配个 title 才不至于让人猜它是什么意思。 */
    var chip = $('file-chip');
    chip.classList.toggle('dirty', store.dirty);
    chip.title = store.dirty ? '有未保存的修改' : '';
  }

  function updateInspectorValues() {
    var node = selected();
    if (!node) return;
    var win = frameWin();
    var cs = win.getComputedStyle(node);
    var r = node.getBoundingClientRect();
    var rootBox = rootEl().getBoundingClientRect();

    $('el-kind').textContent = U.describeElement(node);
    var tagEl = $('el-tag');
    tagEl.textContent = U.elementLabel(node);
    tagEl.title = tagEl.textContent;

    if (document.activeElement !== $('f-x')) $('f-x').value = Math.round(r.left - rootBox.left);
    if (document.activeElement !== $('f-y')) $('f-y').value = Math.round(r.top - rootBox.top);
    if (document.activeElement !== $('f-w')) $('f-w').value = Math.round(r.width);
    if (document.activeElement !== $('f-h')) $('f-h').value = Math.round(r.height);

    var rot = 0;
    if (cs.transform && cs.transform !== 'none') {
      var m = cs.transform.match(/matrix\(([^)]+)\)/);
      if (m) {
        var p = m[1].split(',').map(parseFloat);
        rot = U.round(Math.atan2(p[1], p[0]) * 180 / Math.PI, 1);
      }
    }
    if (document.activeElement !== $('f-rot')) $('f-rot').value = rot;

    var radius = U.parsePx(cs.borderTopLeftRadius, 0) || 0;
    if (document.activeElement !== $('f-radius')) $('f-radius').value = Math.round(radius);

    setColorField('fill', U.parseColor(cs.backgroundColor), cs.backgroundImage);
    setColorField('color', U.parseColor(cs.color));
    setColorField('border-color', U.parseColor(cs.borderTopColor));
    if (document.activeElement !== $('f-border-w')) $('f-border-w').value = U.parsePx(cs.borderTopWidth, 0) || 0;
    if (document.activeElement !== $('f-border-style')) $('f-border-style').value = cs.borderTopStyle === 'none' ? 'none' : cs.borderTopStyle;

    var fam = U.primaryFamily(cs.fontFamily);
    var fsel = $('f-font');
    if (fam && !Array.prototype.some.call(fsel.options, function (o) { return o.value === fam; })) {
      fsel.appendChild(el('option', { value: fam, text: fam }));
    }
    if (document.activeElement !== fsel) fsel.value = fam || '';

    /* 字号不再回写右栏输入框：它已经并进第二行的 fmt 组，
       那里由 updateFormatBar() 写 #fmt-size-label。
       留着这行会直接读 null 的 .value，一进编辑器就抛。 */
    if (document.activeElement !== $('f-line-height')) {
      $('f-line-height').value = cs.lineHeight === 'normal' ? '' : U.round(U.parsePx(cs.lineHeight, 0) || 0, 1);
    }
    if (document.activeElement !== $('f-letter-spacing')) {
      var ls = U.parsePx(cs.letterSpacing, 0) || 0;
      $('f-letter-spacing').value = ls ? U.round(ls, 2) : '';
    }
    if (document.activeElement !== $('f-opacity')) {
      var op = Math.round((parseFloat(cs.opacity) || 1) * 100);
      $('f-opacity').value = op;
      $('opacity-val').textContent = op + '%';
    }

    markSeg('seg-weight', 'weight', String(U.parseFontWeight(cs.fontWeight)));
    /* 文字对齐的第二行按钮由 updateFormatBar() 负责点亮（那里已经读 textAlign） */
  }

  function setColorField(prefix, color, bgImage) {
    var input = $('f-' + prefix);
    var text = $('f-' + prefix + '-text');
    if (!input || !text) return;
    var val = color ? (U.isOpaque(color) ? U.toHex(color) : U.toHexA(color)) : '';
    var inputVal;
    if (bgImage && bgImage !== 'none' && prefix === 'fill') {
      val = val ? val + '  +  渐变/图片' : '渐变/图片';
      inputVal = color ? U.toHex(color) : '#ffffff';
    } else {
      inputVal = (color && color.a > 0.02) ? U.toHex(color) : '#ffffff';
    }
    /* 只在值真的变化时写，并挂起同步保护：
       程序化写 .value 会同步派发 input 事件，若不保护会回灌成一次「改样式」。 */
    syncColorPartner(input, inputVal);
    if (document.activeElement !== text) syncColorPartner(text, val);
  }

  function markSeg(segId, attr, value) {
    var host = $('#' + segId);
    if (!host) return;
    $$('.seg-btn', host).forEach(function (b) {
      var v = b.getAttribute('data-' + attr);
      b.classList.toggle('active', v === value);
    });
  }

  /* 简写属性覆盖哪些长写子属性（清理简写后需要用当前计算值把它们补回去） */
  var SUBPROPS = {
    'background': ['background-color', 'background-image', 'background-repeat',
      'background-position', 'background-size', 'background-attachment', 'background-clip', 'background-origin'],
    'border': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
    'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
    'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
    'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
    'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
    'border-radius': ['border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius'],
    'font': ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size',
      'line-height', 'font-family'],
    'padding': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
    'margin': ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    'color': []
  };

  /* 长写属性 vs 简写属性：内联样式里若已存在简写（例如规范器产出的
     `background: rgb(238,242,247)`），再 setProperty('background-color', …)
     是**完全无效**的 —— 简写层叠优先级更高，长写会被忽略。
     所以改颜色前必须先把对应的简写属性清掉。 */
  var SHORTHAND_FOR = {
    'background-color': ['background'],
    'background-image': ['background'],
    'background-size': ['background'],
    'background-position': ['background'],
    'background-repeat': ['background'],
    'border-color': ['border', 'border-top', 'border-right', 'border-bottom', 'border-left'],
    'border-width': ['border', 'border-top', 'border-right', 'border-bottom', 'border-left'],
    'border-style': ['border', 'border-top', 'border-right', 'border-bottom', 'border-left'],
    'font-size': ['font'],
    'font-family': ['font'],
    'font-weight': ['font'],
    'font-style': ['font'],
    'padding': ['padding'],
    'margin': ['margin'],
  };

  /* 设置内联样式，必要时先清掉会压住它的简写属性。
     简写清掉后要把其它子属性用当前计算值补回去，否则 background 一清，
     原先的图片 / 位置会一起消失。 */
  /* 统一把 camelCase 转成 CSS 的连字符写法。
     坑：style.setProperty('backgroundColor', …) 是**完全静默无效**的 ——
     setProperty 只认 CSS 属性名（background-color）。传错名字既不报错也不生效，
     表现就是「选了颜色没反应」。所有设置样式的入口都必须先过这一层。 */
  function toCssProp(prop) {
    if (!prop) return prop;
    if (prop.indexOf('-') >= 0) return prop;
    return prop.replace(/[A-Z]/g, function (ch) { return '-' + ch.toLowerCase(); });
  }

  function setStyleSmart(node, prop, value) {
    prop = toCssProp(prop);
    var style = node.style;
    var shorthands = SHORTHAND_FOR[prop];
    if (shorthands && shorthands.length) {
      try {
        var win = frameWin();
        var cs = win ? win.getComputedStyle(node) : null;
        var restore = {};
        shorthands.forEach(function (sh) {
          if (!style.getPropertyValue(sh)) return;
          if (cs && SUBPROPS[sh]) {
            SUBPROPS[sh].forEach(function (sub) {
              if (sub === prop) return;
              var v = cs.getPropertyValue(sub);
              if (v) restore[sub] = v;
            });
          }
          style.removeProperty(sh);
          wdLog('  清简写', sh);
        });
        Object.keys(restore).forEach(function (sub) {
          if (!style.getPropertyValue(sub)) style.setProperty(sub, restore[sub]);
        });
        wdLog('  补回子属性后', JSON.stringify(String(node.getAttribute('style')).slice(0, 80)));
      } catch (blockErr) {
        wdLog('  简写处理抛错', String(blockErr && blockErr.message));
        console.error('[wizdeck] 简写处理失败', blockErr);
      }
    }
    if (value === '' || value === null) style.removeProperty(prop);
    else style.setProperty(prop, value);
    wdLog('setStyleSmart', prop, '入参=' + JSON.stringify(value),
      '结果=' + JSON.stringify(style.getPropertyValue(prop)));
  }

  /* 应用一组内联样式到当前选区 */
  function applyStyle(styles, label) {
    if (!E.selection.length) return;
    E.selection.forEach(function (node) {
      Object.keys(styles).forEach(function (prop) {
        setStyleSmart(node, prop, styles[prop]);
      });
    });
    refreshOverlay();
    updateInspectorValues();
    commit(label || '修改样式');
  }

  function styleChanged(prop, value, label) {
    if (!E.selection.length) return;
    wdLog('styleChanged', prop, JSON.stringify(value), 'sel=' + E.selection.length);
    E.selection.forEach(function (node) {
      try {
        setStyleSmart(node, prop, value);
      } catch (err) {
        wdLog('styleChanged 异常', String(err && err.message));
        console.error('[wizdeck] 应用样式失败', err);
      }
    });
    refreshOverlay();
    updateInspectorValues();
    commit(label || '修改样式');
  }

  /* ══════════════════════════════════════════════════════════════════════
     13. 检查器事件绑定
     ══════════════════════════════════════════════════════════════════════ */

  function bindInspector() {
    /* 位置 / 尺寸 */
    [['f-x', 'left'], ['f-y', 'top']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        var node = selected();
        if (!node) return;
        var v = parseFloat(this.value);
        if (isNaN(v)) { updateInspectorValues(); return; }
        var r = node.getBoundingClientRect();
        var rootBox = rootEl().getBoundingClientRect();
        var nx = pair[1] === 'left' ? v + rootBox.left : r.left;
        var ny = pair[1] === 'top' ? v + rootBox.top : r.top;
        repositionElement(node, nx, ny);
        refreshOverlay();
        commit('修改位置');
      });
    });
    [['f-w', 'width'], ['f-h', 'height']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        var node = selected();
        if (!node) return;
        var v = parseFloat(this.value);
        if (isNaN(v) || v < 1) { updateInspectorValues(); return; }
        /* ★ 必须**先量后写**。
           原先这里先 node.style[pair[1]] = v 再去量 start，
           于是 start.w 已经是新值，锁比例时算出的是「用新宽除以新宽」的循环 ——
           圆形改成 500 宽，高度跟着变成 423，比例越改越歪。 */
        var r = node.getBoundingClientRect();
        var start = { x: r.left, y: r.top, w: r.width, h: r.height };
        pinElement(node);
        var next = { x: start.x, y: start.y, w: start.w, h: start.h };
        /* 注意键名：约束对象用的是短键 w / h，不是 CSS 的 width / height。
           直接 next[pair[1]] = v 会写到一个没人读的属性上，
           元素尺寸纹丝不动，而输入框还显示着 500 —— 看着像生效了，其实没有。 */
        var dim = pair[1] === 'width' ? 'w' : 'h';
        next[dim] = v;
        WD.elements.applyConstraint(node, start, next, dim === 'w' ? 'e' : 's');
        node.style.width = U.round(next.w, 2) + 'px';
        node.style.height = U.round(next.h, 2) + 'px';
        if (Math.abs(next.x - start.x) > 0.5 || Math.abs(next.y - start.y) > 0.5) {
          repositionElement(node, next.x, next.y);
        }
        refreshOverlay();
        commit('修改尺寸');
      });
    });
    $('f-rot').addEventListener('change', function () {
      var node = selected();
      if (!node) return;
      var v = parseFloat(this.value);
      if (isNaN(v)) { updateInspectorValues(); return; }
      var cur = node.style.transform || '';
      var base = cur.replace(/\s*rotate\([^)]*\)/g, '').trim();
      node.style.transformOrigin = '50% 50%';
      node.style.transform = (base ? base + ' ' : '') + 'rotate(' + v + 'deg)';
      refreshOverlay();
      commit('旋转元素');
    });
    $('f-radius').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (isNaN(v) || v < 0) return;
      styleChanged('border-radius', v + 'px', '修改圆角');
    });

    /* 表格行列：重建结构并把已有文字搬回去。
       用 replaceWith 而不是 innerHTML —— 后者会连节点身份一起换掉，
       选区里那个 TABLE 引用就变成游离节点了。 */
    var tblOps = {
      'tbl-add-row': [1, 0], 'tbl-del-row': [-1, 0],
      'tbl-add-col': [0, 1], 'tbl-del-col': [0, -1],
    };
    Object.keys(tblOps).forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.addEventListener('click', function () {
        var node = selected();
        if (!node || node.tagName !== 'TABLE') return;
        var sz = WD.elements.tableSize(node);
        var r = sz.rows + tblOps[id][0];
        var c = sz.cols + tblOps[id][1];
        if (r < 1 || c < 1) { toast('表格至少要保留 1 行 1 列', 'warn'); return; }
        if (r > 40 || c > 20) { toast('最多 40 行 20 列', 'warn'); return; }
        var fresh = WD.elements.resizeTable(frameDoc(), node, r, c);
        pinElement(node);
        node.parentNode.replaceChild(fresh, node);
        fresh.setAttribute('data-wd-added', 'table');
        /* 补回 addElement 之外的初始化样式 */
        fresh.style.position = 'absolute';
        fresh.style.left = node.style.left;
        fresh.style.top = node.style.top;
        fresh.style.zIndex = node.style.zIndex || '';
        setSelection([fresh]);
        commit('调整表格行列');
      });
    });

    /* 颜色 */
    bindColorPair('fill', 'background-color', '填充');
    bindColorPair('color', 'color', '文字色');
    bindColorPair('border-color', 'border-color', '边框颜色');

    $('f-border-w').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (isNaN(v)) return;
      if (v <= 0) styleChanged('border-style', 'none', '移除边框');
      else {
        if (!$('f-border-style').value || $('f-border-style').value === 'none') {
          $('f-border-style').value = 'solid';
          styleChanged('border-style', 'solid');
        }
        styleChanged('border-width', v + 'px', '修改边框');
      }
    });
    $('f-border-style').addEventListener('change', function () {
      styleChanged('border-style', this.value, '修改边框');
    });

    /* 字体 */
    $('f-font').addEventListener('change', function () {
      var fam = this.value;
      if (!fam) styleChanged('font-family', '', '恢复字体');
      else {
        var stack = '"' + fam + '", "Microsoft YaHei", "PingFang SC", sans-serif';
        styleChanged('font-family', stack, '修改字体');
      }
    });
    /* 字号 / 文字对齐 / 文字色已并入第二行的 fmt 组（原顶栏那一段），
       右栏不再重复一份 —— 两处同名控件意味着两套状态。 */

    $('f-line-height').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (isNaN(v) || v <= 0) styleChanged('line-height', '', '恢复行高');
      else styleChanged('line-height', v + 'px', '修改行高');
    });
    $('btn-lh-15').addEventListener('click', function () { styleChanged('line-height', '1.5', '修改行高'); updateInspectorValues(); });
    $('btn-lh-18').addEventListener('click', function () { styleChanged('line-height', '1.8', '修改行高'); updateInspectorValues(); });
    $('f-letter-spacing').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (isNaN(v) || v === 0) styleChanged('letter-spacing', '', '恢复字距');
      else styleChanged('letter-spacing', v + 'px', '修改字距');
    });

    $('f-opacity').addEventListener('input', function () {
      $('opacity-val').textContent = this.value + '%';
      if (!E.selection.length) return;
      E.selection.forEach(function (n) {
        var v = parseInt(this.value, 10) / 100;
        if (v >= 1) n.style.removeProperty('opacity');
        else n.style.setProperty('opacity', String(v));
      }, this);
      refreshOverlay();
    });
    $('f-opacity').addEventListener('change', function () { commit('修改透明度'); });

    /* 字重 */
    $$('#seg-weight .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        styleChanged('font-weight', b.getAttribute('data-weight'), '修改字重');
        updateInspectorValues();
      });
    });
    /* 对齐 / 分布 */
    $$('#seg-align .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { alignAction(b.getAttribute('data-align')); });
    });

    /* 清除按钮 */
    $$('[data-clear]').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-clear');
        if (kind === 'slideBg') clearSlideBackground();
        else if (kind === 'fill') styleChanged('background', '', '清除填充');
        /* 「清除文字色」那个按钮随文字色一起去到第二行 fmt 组了，
           文字色改由 fmt-color-input 直接取色，没有独立的「清空」动作。 */
      });
    });

    /* 元素操作 */
    $('btn-el-dup').addEventListener('click', duplicateSelection);
    $('btn-el-del').addEventListener('click', deleteSelection);
    /* 置顶 / 置底原在元素属性段里另有一份（#btn-el-front/back），
       与图层段的 #btn-layer-front/back 调用的是同一个 layerAction()。
       第二行只留图层这一份，免得同一条里出现两个「置顶」。 */
    $('btn-el-group').addEventListener('click', groupSelection);
    $('btn-el-ungroup').addEventListener('click', ungroupSelection);

    /* 自定义 CSS */
    $('btn-css-apply').addEventListener('click', applyCustomCss);

    /* 幻灯片属性 */
    $('f-notes').addEventListener('change', function () { store.setNotes(this.value); });
    $('f-notes').addEventListener('blur', function () { store.setNotes(this.value); });
    $('f-slide-layout').addEventListener('change', function () {
      var s = store.slide();
      if (!s) return;
      s.layout = this.value;
      store.commit('修改版式');
    });
    $('f-slide-bg').addEventListener('input', function () {
      setSlideBackground(this.value, false);
    });
    $('f-slide-bg').addEventListener('change', function () {
      setSlideBackground(this.value, true);
    });
    $('f-slide-bg-text').addEventListener('change', function () {
      var v = this.value.trim();
      if (!v || v === 'transparent') clearSlideBackground();
      else setSlideBackground(v, true);
    });

    $('btn-slide-dup').addEventListener('click', function () { store.duplicateSlide(store.current); goSlide(store.current); });
    $('btn-slide-del').addEventListener('click', function () { doDeleteSlide(store.current); });
    $('btn-slide-up').addEventListener('click', function () { store.moveSlide(store.current, store.current - 1); goSlide(store.current); });
    $('btn-slide-down').addEventListener('click', function () { store.moveSlide(store.current, store.current + 1); goSlide(store.current); });
    $('btn-slide-bgimg').addEventListener('click', pickSlideBackgroundImage);
    $('btn-slide-bgimg-clear').addEventListener('click', function () { setSlideBackgroundImage(''); });
  }

  /* 颜色输入由「取色器 + 文本」两个控件共同驱动，两者必须互相同步。
     坑：程序化写 `input.value` 会**同步**派发一次 input 事件，
     于是取色器会用它的旧值再调一次 styleChanged，把刚改好的颜色覆盖回旧值
     （文本改色「看起来没反应」就是这么来的）。
     因此同步另一个控件时要挂起监听，并只在值真的变化时才写。 */
  var colorSyncGuard = false;

  function syncColorPartner(node, value) {
    if (!node) return;
    if (node.value === value) return;
    colorSyncGuard = true;
    node.value = value;
    colorSyncGuard = false;
  }

  function bindColorPair(key, prop, label) {
    var input = $('f-' + key);
    var text = $('f-' + key + '-text');
    var inputTimer = null;

    if (input) {
      /* 取色器拖拽会连发 input，防抖后再改样式，避免刷爆撤销栈 */
      input.addEventListener('input', function () {
        if (colorSyncGuard) return;
        var v = this.value;
        syncColorPartner(text, v);
        if (inputTimer) clearTimeout(inputTimer);
        var self = this;
        inputTimer = setTimeout(function () {
          inputTimer = null;
          styleChanged(prop, v, label);
        }, 90);
      });
      /* 松开取色器立刻落一次，保证不丢最后一次改动 */
      input.addEventListener('change', function () {
        if (colorSyncGuard) return;
        if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
        styleChanged(prop, this.value, label);
      });
    }

    if (text) {
      text.addEventListener('change', function () {
        if (colorSyncGuard) return;
        var v = this.value.trim();
        if (!v || v === 'transparent' || v === 'none') { styleChanged(prop, '', label); return; }
        var c = U.parseColor(v);
        if (!c) { toast('无法识别的颜色：' + v, 'warn'); updateInspectorValues(); return; }
        syncColorPartner(input, U.toHex(c));
        styleChanged(prop, U.toHexA(c) || v, label);
      });
      /* 回车直接提交，符合直觉 */
      text.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); this.blur(); this.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    }
  }

  function nudgeFont(delta) {
    if (!E.selection.length) return;
    E.selection.forEach(function (node) {
      var cs = frameWin().getComputedStyle(node);
      var cur = U.parsePx(cs.fontSize, 16) || 16;
      node.style.fontSize = Math.max(4, cur + delta) + 'px';
    });
    refreshOverlay();
    updateInspectorValues();
    commit('修改字号');
  }

  function applyCustomCss() {
    var raw = $('f-css').value;
    if (!raw.trim() || !E.selection.length) return;
    var applied = 0;
    raw.split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i < 0) return;
      var prop = line.slice(0, i).trim();
      var val = line.slice(i + 1).trim().replace(/;$/, '');
      if (!prop || !val) return;
      E.selection.forEach(function (node) { node.style.setProperty(prop, val); });
      applied++;
    });
    if (!applied) { toast('没有解析到有效的 CSS 声明', 'warn'); return; }
    $('f-css').value = '';
    refreshOverlay();
    commit('自定义样式');
    toast('已应用 ' + applied + ' 条声明', 'ok', 1800);
  }

  function setSlideBackground(value, doCommit) {
    var root = rootEl();
    if (!root) return;
    root.style.backgroundColor = value;
    if (doCommit) {
      syncSlideDoc();
      commit('修改页面背景');
      updateInspector();
      renderRailThumbs();
    } else {
      store.setDirty(true);
      refreshOverlaySoon();
    }
  }

  function clearSlideBackground() {
    var root = rootEl();
    if (!root) return;
    root.style.removeProperty('background-color');
    commit('清除页面背景');
    updateInspector();
  }

  function pickSlideBackgroundImage() {
    var input = el('input', { type: 'file', accept: 'image/*', hidden: true });
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { setSlideBackgroundImage(fr.result); };
      fr.readAsDataURL(f);
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () { input.remove(); }, 1000);
  }

  function setSlideBackgroundImage(dataUrl) {
    var root = rootEl();
    if (!root) return;
    if (!dataUrl) {
      root.style.removeProperty('background-image');
      root.style.removeProperty('background-size');
      root.style.removeProperty('background-position');
    } else {
      root.style.backgroundImage = 'url("' + dataUrl + '")';
      root.style.backgroundSize = 'cover';
      root.style.backgroundPosition = 'center';
    }
    commit(dataUrl ? '设置页面背景图' : '移除页面背景图');
  }

  /* 组合：用一个 wrapper 把选中元素包起来 */
  function groupSelection() {
    if (E.selection.length < 2) { toast('请先选中至少 2 个元素再组合', 'warn'); return; }
    var root = rootEl();
    var boxes = E.selection.map(function (n) {
      var r = n.getBoundingClientRect();
      return { node: n, x: r.left, y: r.top, w: r.width, h: r.height };
    });
    var bounds = boxes.reduce(function (a, b) {
      var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
      var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }, { x: Infinity, y: Infinity, w: 0, h: 0 });

    var rootBox = root.getBoundingClientRect();
    var wrap = el('div');
    wrap.setAttribute('data-wd-group', '1');
    wrap.style.cssText = 'position:absolute;left:' + U.round(bounds.x - rootBox.left, 2) + 'px;top:' +
      U.round(bounds.y - rootBox.top, 2) + 'px;width:' + U.round(bounds.w, 2) + 'px;height:' +
      U.round(bounds.h, 2) + 'px;';

    var first = boxes[0].node;
    first.parentNode.insertBefore(wrap, first);
    boxes.forEach(function (b) {
      wrap.appendChild(b.node);
      var st = b.node.style;
      st.position = 'absolute';
      st.left = U.round(b.x - bounds.x, 2) + 'px';
      st.top = U.round(b.y - bounds.y, 2) + 'px';
      st.right = 'auto';
      st.bottom = 'auto';
      st.margin = '0';
    });
    setSelection([wrap]);
    commit('组合元素');
    toast('已组合 ' + boxes.length + ' 个元素', 'ok');
  }

  function ungroupSelection() {
    var node = selected();
    if (!node || !node.hasAttribute('data-wd-group')) { toast('请选中一个组合', 'warn'); return; }
    var parent = node.parentNode;
    var items = Array.prototype.slice.call(node.children);
    var nr = node.getBoundingClientRect();
    items.forEach(function (child) {
      var st = child.style;
      var cx = U.parsePx(st.left, 0) || 0;
      var cy = U.parsePx(st.top, 0) || 0;
      parent.insertBefore(child, node);
      child.style.position = 'absolute';
      child.style.left = U.round(nr.left - parent.getBoundingClientRect().left + cx, 2) + 'px';
      child.style.top = U.round(nr.top - parent.getBoundingClientRect().top + cy, 2) + 'px';
    });
    node.remove();
    setSelection(items);
    commit('解组元素');
  }

  /* ══════════════════════════════════════════════════════════════════════
     13.5 顶栏文字格式工具条

     bento 的界面约定是「常用功能在上方、完整操作在右侧」。
     顶栏这条只在选中「有文字的块级元素」时出现，提供最高频的几项：
     加粗 / 斜体 / 下划线、字号增减、对齐、文字颜色。
     完整的字体、行高、字距等仍在右侧「元素属性」里。
     ══════════════════════════════════════════════════════════════════════ */

  /* 取当前文字元素上的某个字体相关计算值 */
  function textStyleOf(node, prop) {
    var win = frameWin();
    if (!win || !node) return '';
    try { return win.getComputedStyle(node)[prop] || ''; } catch (e) { return ''; }
  }

  function currentFontPx() {
    var n = selected();
    if (!n) return 16;
    return U.parsePx(textStyleOf(n, 'fontSize'), 16) || 16;
  }

  /* 选区里是否都是某种状态（用于按钮高亮） */
  function allHaveStyle(check) {
    if (!E.selection.length) return false;
    return E.selection.every(function (n) { return check(n); });
  }

  function updateFormatBar() {
    var group = $('fmt-group');
    if (!group) return;
    /* 只在单选 / 多选到有文字的元素时出现 */
    var show = E.selection.length > 0 && !E.editing && E.selection.some(function (n) {
      return (n.textContent || '').trim().length > 0;
    });
    group.hidden = !show;
    if (!show) return;

    var bold = allHaveStyle(function (n) {
      return U.isBoldWeight(U.parseFontWeight(textStyleOf(n, 'fontWeight')));
    });
    var italic = allHaveStyle(function (n) { return /italic|oblique/.test(textStyleOf(n, 'fontStyle')); });
    var under = allHaveStyle(function (n) {
      return /underline/.test(textStyleOf(n, 'textDecorationLine') || textStyleOf(n, 'textDecoration'));
    });
    var align = textStyleOf(E.selection[0], 'textAlign');

    $('fmt-bold').classList.toggle('on', bold);
    $('fmt-italic').classList.toggle('on', italic);
    $('fmt-underline').classList.toggle('on', under);
    $('fmt-align-left').classList.toggle('on', align === 'left' || align === 'start');
    $('fmt-align-center').classList.toggle('on', align === 'center');
    $('fmt-align-right').classList.toggle('on', align === 'right' || align === 'end');
    $('fmt-align-justify').classList.toggle('on', align === 'justify');

    var px = currentFontPx();
    $('fmt-size-label').textContent = Math.round(px) + 'px';

    var col = U.parseColor(textStyleOf(E.selection[0], 'color'));
    var ci = $('fmt-color-input');
    if (col && document.activeElement !== ci) ci.value = U.toHex(col);
    var bar = $('fmt-color-bar');
    if (bar) bar.style.background = col ? U.toHex(col) : 'currentColor';
  }

  function bindFormatBar() {
    if (!$('fmt-group')) return;

    /* 加粗：按当前状态取反 */
    $('fmt-bold').addEventListener('click', function () {
      var isBold = allHaveStyle(function (n) {
        return U.isBoldWeight(U.parseFontWeight(textStyleOf(n, 'fontWeight')));
      });
      styleChanged('font-weight', isBold ? '400' : '700', isBold ? '取消加粗' : '加粗');
      updateFormatBar();
    });

    $('fmt-italic').addEventListener('click', function () {
      var isIt = allHaveStyle(function (n) { return /italic|oblique/.test(textStyleOf(n, 'fontStyle')); });
      styleChanged('font-style', isIt ? '' : 'italic', isIt ? '取消斜体' : '斜体');
      updateFormatBar();
    });

    $('fmt-underline').addEventListener('click', function () {
      var isUn = allHaveStyle(function (n) {
        return /underline/.test(textStyleOf(n, 'textDecorationLine') || textStyleOf(n, 'textDecoration'));
      });
      styleChanged('text-decoration', isUn ? '' : 'underline', isUn ? '取消下划线' : '下划线');
      updateFormatBar();
    });

    $('fmt-size-dec').addEventListener('click', function () { nudgeFont(-2); updateFormatBar(); });
    $('fmt-size-inc').addEventListener('click', function () { nudgeFont(2); updateFormatBar(); });

    ['left', 'center', 'right', 'justify'].forEach(function (a) {
      $('fmt-align-' + a).addEventListener('click', function () {
        styleChanged('text-align', a, '对齐方式');
        updateFormatBar();
      });
    });

    /* 颜色：点按钮打开取色器 */
    $('fmt-color').addEventListener('click', function () { $('fmt-color-input').click(); });
    $('fmt-color-input').addEventListener('input', function () {
      styleChanged('color', this.value, '文字颜色');
      var bar = $('fmt-color-bar');
      if (bar) bar.style.background = this.value;
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     14. 文件操作
     ══════════════════════════════════════════════════════════════════════ */

  function doUndo() {
    flushNudgeCommit();            /* 待办的微调先落库，否则会「没有可撤销的操作」 */
    if (!store.undo()) { toast('没有可撤销的操作', 'info', 1500); return; }
    /* 撤销会重建整份页面文档，旧的选区引用全部失效，
       必须清掉再重载，否则选择框会指向游离节点而“消失”。 */
    clearSelection();
    loadStage().then(function () { renderRail(); updateHistoryButtons(); updateInspector(); });
  }

  function doRedo() {
    flushNudgeCommit();
    if (!store.redo()) { toast('没有可重做的操作', 'info', 1500); return; }
    clearSelection();
    loadStage().then(function () { renderRail(); updateHistoryButtons(); updateInspector(); });
  }

  function doDeleteSlide(i) {
    if (store.count() <= 1) { toast('至少要保留一页', 'warn'); return; }
    store.deleteSlide(i);
    loadStage().then(function () { renderRail(); updateInspector(); });
  }

  function newDeck() {
    var deck = {
      title: '未命名演示',
      slides: [
        {
          id: U.uid('slide'), name: '第 1 页', title: '标题页', layout: 'title', notes: '',
          doc: WD.parse.blankSlideDoc('', { layout: 'title' })
        },
        {
          id: U.uid('slide'), name: '第 2 页', title: '内容页', layout: 'content', notes: '',
          doc: WD.parse.blankSlideDoc('', { layout: 'content' })
        }
      ]
    };
    adoptDeck(deck, '');
    toast('已新建演示，可直接编辑或导入 HTML', 'ok');
  }

  function adoptDeck(deck, fileName) {
    WD.render.clearThumbs();
    store.load(deck, fileName);
    /* 换了文稿，旧选区指向的是上一份文档里的节点，必须丢弃 */
    E.selection = [];
    E.editing = null;
    E.drag = null;
    E.hover = null;
    /* 胶囊现在是 flex 布局（点 + 文件名），文件名要单独包一层才能省略号截断；
       用 createElement + textContent 而不是拼字符串，顺带避免文件名里的尖括号注入。 */
    var chip = $('file-chip');
    chip.textContent = '';
    var chipName = fileName || deck.title || '';
    if (chipName) {
      var chipText = document.createElement('span');
      chipText.textContent = chipName;
      chip.appendChild(chipText);
    }
    document.title = (deck.title || '未命名演示') + ' · 智演引擎 WizDeck';
    $('stage-empty').hidden = true;
    $('btn-present').hidden = false;
    renderRail();
    initFontOptions();
    loadStage().then(function () {
      updateStatus();
      updateInspector();
      updateHistoryButtons();
      refreshOverlay();
    });
  }

  function importHtml(text, fileName) {
    /* 先看是不是 WizDeck 工程文件 */
    if (WD.parse.looksLikeProject(text)) {
      var project = WD.parse.parseProject(text);
      if (project) {
        adoptDeck(project, fileName);
        toast('已载入 WizDeck 工程：' + project.slides.length + ' 页', 'ok');
        return;
      }
      toast('工程文件解析失败，改为按普通 HTML 解析', 'warn');
    }

    busy('正在解析 HTML…', '定位幻灯片…');
    var t0 = performance.now();
    WD.parse.loadHtml(text, {
      baseUrl: (global.location && global.location.href) || 'about:blank',
      onProgress: function (msg, ratio) {
        busyUpdate('正在解析 HTML…', msg);
      },
      onAssetError: function (url, err) {
        console.warn('[wizdeck] 素材内联失败', url, err);
      }
    }).then(function (result) {
      var deck = {
        title: result.title || WD.util.safeFileName(fileName, '未命名演示'),
        style: result.style || '',
        slides: result.slides
      };
      adoptDeck(deck, fileName);
      busyDone();
      var ms = Math.round(performance.now() - t0);
      var msg = '解析完成：' + result.slides.length + ' 页（' + ms + ' ms）';
      if (result.missing) msg += '，' + result.missing + ' 个外部素材无法内联';
      toast(msg, result.missing ? 'warn' : 'ok', 5200);
      if (result.plan && result.plan.confidence === 'low') {
        toast('未识别到明确的分页结构，已按整篇 1 页处理；可在左侧复制页面后手工拆分。', 'warn', 8000);
      }
    }).catch(function (e) {
      busyDone();
      console.error(e);
      showModal({
        title: '解析失败',
        html: '<p>无法把这个 HTML 解析成幻灯片：</p><pre>' + U.escapeHtml(e && e.message ? e.message : String(e)) +
          '</pre><p>可以尝试：</p><ul><li>确认文件是完整的 HTML（含 <code>&lt;body&gt;</code>）</li>' +
          '<li>把页面尺寸设为 1920 × 1080，或用 <code>&lt;section class="slide"&gt;</code> 标记每一页</li>' +
          '<li>先用示例课件验证编辑器是否正常</li></ul>'
      });
    });
  }

  function readFile(file) {
    var fr = new FileReader();
    fr.onload = function () { importHtml(String(fr.result), file.name); };
    fr.onerror = function () { toast('读取文件失败：' + file.name, 'error'); };
    fr.readAsText(file, 'utf-8');
  }

  function saveProject() {
    if (!store.model) { toast('还没有可保存的内容', 'warn'); return; }
    flushNudgeCommit();          /* 待办的微调先落库，否则存出去的是旧状态 */
    syncSlideDoc();
    var html = WD.parse.serializeProject(store.model);
    U.downloadText(html, U.safeFileName(store.fileName || store.model.title, 'wizdeck') + '.wd.html', 'text/html');
    store.setDirty(false);
    updateHistoryButtons();
    toast('工程已保存（.wd.html，可再次打开继续编辑）', 'ok', 4200);
  }

  function saveCleanHtml() {
    if (!store.model) { toast('还没有可导出的内容', 'warn'); return; }
    syncSlideDoc();
    var name = U.safeFileName(store.fileName || store.model.title, 'wizdeck');
    var pages = store.model.slides.map(function (s, i) { return s.doc; }).join('\n');
    /* 多页合并：保留第一页的 head，其余页的 body 追加 */
    var first = store.model.slides[0].doc;
    var head = first.slice(0, first.indexOf('<body'));
    var tail = '</body>\n</html>';
    var bodies = store.model.slides.map(function (s) {
      var b = s.doc;
      var i0 = b.indexOf('<body');
      var i1 = b.lastIndexOf('</body>');
      return i0 >= 0 && i1 > i0 ? b.slice(b.indexOf('>', i0) + 1, i1) : '';
    }).join('\n');
    U.downloadText(head + '<body data-wizdeck-pages="' + store.model.slides.length + '">\n' +
      bodies + '\n' + tail, name + '.html', 'text/html');
    toast('已导出纯 HTML（' + store.model.slides.length + ' 页内容）', 'ok');
  }

  /* ══════════════════════════════════════════════════════════════════════
     15. PPTX 导出
     ══════════════════════════════════════════════════════════════════════ */

  function doExportPptx() {
    if (!store.model) { toast('还没有可导出的内容', 'warn'); return; }
    endTextEdit(true);
    flushNudgeCommit();          /* 同上：导出读的是模型，必须先落库 */
    syncSlideDoc();

    var t0 = performance.now();
    busy('正在生成 PPTX…', '准备中…');
    WD.pptx.exportPptx(store.model, {
      onProgress: function (msg, ratio, i, n) {
        busyUpdate('正在生成 PPTX…', msg);
      }
    }).then(function (r) {
      busyDone();
      var name = U.safeFileName(store.fileName || store.model.title, 'wizdeck');
      U.downloadBytes(r.bytes, name + '.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      var ms = Math.round(performance.now() - t0);
      var size = (r.bytes.length / 1048576).toFixed(2);
      toast('PPTX 已生成：' + r.slides + ' 页 · ' + size + ' MB · ' + ms + ' ms' +
        (r.media ? '（含 ' + r.media + ' 张图片素材）' : ''), 'ok', 6000);
      if (r.warnings && r.warnings.length) {
        toast(r.warnings.length + ' 处降级处理：' + r.warnings.slice(0, 2).join('；'), 'warn', 7000);
      }
    }).catch(function (e) {
      busyDone();
      console.error(e);
      showModal({
        title: '导出失败',
        html: '<p>生成 PPTX 时出错：</p><pre>' + U.escapeHtml(e && e.message ? e.message : String(e)) + '</pre>' +
          '<p>可以先试试「保存工程」，避免编辑内容丢失。</p>'
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     16. 放映
     ══════════════════════════════════════════════════════════════════════ */

  var presentIndex = 0;
  var prevBtn = null, nextBtn = null, fsBtn = null;

  /* HUD 自动隐藏：演示时画面右下角不该有条控制栏，
     但它又必须「一挪鼠标就出现」—— 这是演示软件的通行做法。 */
  var hudTimer = null;
  function showHud() {
    var h = document.querySelector('.present-hud');
    if (!h || $('present').hidden) return;
    h.classList.add('show');
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { h.classList.remove('show'); }, 2500);
  }

  function startPresent() {
    if (!store.model) { toast('还没有可放映的内容', 'warn'); return; }
    endTextEdit(true);
    syncSlideDoc();
    presentIndex = store.current;
    $('present').hidden = false;
    showPresentSlide(presentIndex);
    scalePresent();
    showHud();
    window.addEventListener('resize', scalePresent);
    window.addEventListener('keydown', onPresentKey, true);
    $('present').addEventListener('mousemove', showHud);
  }

  function showPresentSlide(i) {
    var slide = store.slideAt(i);
    if (!slide) return;
    var frame = $('present-frame');
    frame.addEventListener('load', function once() {
      frame.removeEventListener('load', once);
      /* 放映态放开动画：帧里没有编辑用的静止样式，只需确认文档可读 */
      var doc = frame.contentDocument;
      if (doc && doc.documentElement) doc.documentElement.removeAttribute('data-wd-still');
      var still = doc && doc.getElementById('wd-still');
      if (still) still.remove();
    }, { once: false });
    frame.srcdoc = slide.doc;
    $('present-pos').textContent = (i + 1) + ' / ' + store.count();
    $('present-notes').textContent = slide.notes || '（本页没有备注）';
    /* 翻到头尾时把对应按钮置灰：不给一个「点了没反应」的按钮，
       而是在禁用态上直接说明已经没有下一页了。 */
    if (prevBtn) prevBtn.disabled = i <= 0;
    if (nextBtn) nextBtn.disabled = i >= store.count() - 1;
    /* 翻页时备注内容会变，长度不同、面板高度也不同 ——
       下一行一长就会比刚才高，画布却不重新让位，于是底部又被压住。
       所以每次翻页都要重算一次可用高度。 */
    scalePresent();
  }

  /* 翻页收敛到一处：键盘、按钮、点击全屏，三条路径共用，
     边界钳位与按钮置灰不会在某个入口漏掉。 */
  function goPresent(delta) {
    var next = Math.max(0, Math.min(store.count() - 1, presentIndex + delta));
    if (next === presentIndex) return;
    presentIndex = next;
    showPresentSlide(presentIndex);
  }

  /* 放映时的安全边距：留一点呼吸位，同时兜住浏览器自身可能吃掉的一两像素
     （Windows 任务栏自动隐藏的动画、macOS 刘海、缩放取整）。
     8px 视觉上几乎看不出来，但能保证「整页都在屏幕内」是硬保证而不是概率。 */
  var PRESENT_PAD = 8;

  function scalePresent() {
    var frame = $('present-frame');
    if (!frame) return;
    var notes = $('present-notes');
    /* 备注面板是从底部盖上来的（max-height 26vh）。不把它算进可用高度，
       备注一展开就压住幻灯片底部 —— 演示时那几行字根本看不见。
       面板是 hidden 时 offsetHeight 为 0，正好当「没占位」处理。 */
    var notesH = (notes && !notes.hidden) ? notes.offsetHeight : 0;
    var availW = Math.max(80, window.innerWidth - PRESENT_PAD * 2);
    var availH = Math.max(60, window.innerHeight - PRESENT_PAD * 2 - notesH);
    var s = Math.min(availW / W, availH / H);
    /* 居中 + 缩放合成一个 transform：CSS 里是 translate(-50%,-50%) scale(1)，
       这里只改 scale 的系数。顺序不能反 —— 先缩放再平移会让位移量也跟着缩。 */
    frame.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
    /* ★ 光缩不放是不行的：可用高度变了，可**中心**也得跟着变。
       只缩不挪的话画布仍然按整屏居中，底部照样压在备注面板上
       （实测备注高 51px 时，缩对了却仍被压住 18px）。
       垂直中心 = (视口高 - 备注高) / 2 —— 两边的 PRESENT_PAD 正好抵消。
       left 保持 50% 不动，横向不受备注影响。 */
    frame.style.top = ((window.innerHeight - notesH) / 2) + 'px';
  }

  /* 备注显隐会改变可用高度，必须重算，否则画布不会让位 */
  function togglePresentNotes() {
    var n = $('present-notes');
    if (!n) return;
    n.hidden = !n.hidden;
    scalePresent();
  }

  /* 全屏：之前整份代码里一次 requestFullscreen 都没有，
     所谓「放映」只是把幻灯片缩放进浏览器窗口 ——
     标签栏、地址栏、书签栏、任务栏全都还占着地方。
     演示时真正要的是「屏幕上只有这一页」。 */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    try {
      if (isFullscreen()) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
          var p = exit.call(document);
          /* 这两个 API 返回 Promise，拒绝时（比如无用户手势、被策略拒绝）
             若不接住就会变成未处理的 Promise 拒绝 ——
             表现是控制台一条 Uncaught，而功能其实「按设计就是不进全屏」。 */
          if (p && p.catch) p.catch(function () {});
        }
      } else {
        var req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
        if (req) {
          var q = req.call(document.documentElement);
          if (q && q.catch) q.catch(function () {});
        }
      }
    } catch (e) { /* 某些环境（无手势、iframe 内）会抛，忽略即可 */ }
  }

  /* 进出全屏都要重量一次：视口尺寸变了，缩放系数和垂直中心都跟着变。 */
  document.addEventListener('fullscreenchange', function () {
    if ($('present').hidden) return;
    scalePresent();
    if (fsBtn) {
      var on = isFullscreen();
      fsBtn.textContent = on ? '退出全屏' : '全屏';
      fsBtn.classList.toggle('on', on);
    }
  });

  function onPresentKey(ev) {
    if ($('present').hidden) return;
    /* Esc 分两级：先退全屏，再按一次才退放映。
       浏览器在全屏下会自己吞掉 Esc（规范如此），所以这里要判断当前是不是全屏 ——
       否则用户在全屏里按 Esc 会「什么都没发生」，得等浏览器先退全屏、
       再按一次才退放映，中间没有提示，像是卡住了。 */
    if (ev.key === 'Escape') {
      if (isFullscreen()) { toggleFullscreen(); ev.preventDefault(); return; }
      stopPresent(); ev.preventDefault(); return;
    }
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') {
      goPresent(1); ev.preventDefault();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') {
      goPresent(-1); ev.preventDefault();
    } else if (ev.key === 'Home') {
      goPresent(-store.count()); ev.preventDefault();
    } else if (ev.key === 'End') {
      goPresent(store.count()); ev.preventDefault();
    } else if (ev.key === 'n' || ev.key === 'N') {
      togglePresentNotes();
    } else if (ev.key === 'f' || ev.key === 'F') {
      toggleFullscreen(); ev.preventDefault();
    }
  }

  function stopPresent() {
    /* 退出放映时必须把全屏一起退掉：不然用户会留在一个「全屏的浏览器」里，
       面前只有黑色背景，工作台被藏在全屏层后面 —— 看起来像应用崩了。
       fullscreenchange 里已经处理了「present 隐藏时不重量」，所以这里安全。 */
    if (isFullscreen()) toggleFullscreen();
    $('present').hidden = true;
    if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
    window.removeEventListener('resize', scalePresent);
    window.removeEventListener('keydown', onPresentKey, true);
    $('present').removeEventListener('mousemove', showHud);
    $('present-frame').src = 'about:blank';
    if (fsBtn) { fsBtn.textContent = '全屏'; fsBtn.classList.remove('on'); }
  }

  /* ══════════════════════════════════════════════════════════════════════
     17. 示例与帮助
     ══════════════════════════════════════════════════════════════════════ */

  var SAMPLE_DOC = null;

  function loadSample() {
    if (SAMPLE_DOC) { importHtml(SAMPLE_DOC, '示例课件.html'); return; }
    busy('正在准备示例…', '载入内置课件');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'samples/sample-fractions.html', true);
    xhr.onload = function () {
      busyDone();
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
        SAMPLE_DOC = xhr.responseText;
        importHtml(SAMPLE_DOC, '示例课件.html');
      } else {
        toast('示例文件读取失败，请用「打开 HTML」选择本地文件', 'warn');
      }
    };
    xhr.onerror = function () {
      busyDone();
      toast('示例文件读取失败（离线环境下示例需要与 WizDeck.html 放在一起）', 'warn', 6000);
    };
    xhr.send();
  }

  function showHelp() {
    showModal({
      wide: true,
      title: '智演引擎 WizDeck · 使用说明',
      html: [
        '<h4>它是什么</h4>',
        '<p>把任意 1920×1080 的 HTML 课件解析成幻灯片，在可视化工作台里直接编辑版式与文字，再导出成<b>真正可编辑的 .pptx</b>。全部处理都在本机浏览器内完成，不联网、不上传。</p>',
        '<h4>三步上手</h4>',
        '<ol><li><b>打开 HTML</b>：把课件 HTML 拖进来，或点「打开 HTML」选择文件。</li>',
        '<li><b>编辑</b>：左栏切页/排序；画布上拖动、缩放、双击改字；右栏改颜色、字号、圆角。</li>',
        '<li><b>导出 PPTX</b>：点右上角「保存与导出」，在展开的菜单里选「导出 PPTX」，浏览器直接下载 .pptx。</li></ol>',
        '<h4>快捷键</h4>',
        '<ul>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">Z</span> / <span class="kbd">Ctrl</span>+<span class="kbd">Shift</span>+<span class="kbd">Z</span> 撤销 / 重做</li>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">O</span> 打开 HTML（也可直接把文件拖进窗口）</li>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">S</span> 保存工程 · <span class="kbd">Ctrl</span>+<span class="kbd">E</span> 导出 PPTX</li>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">F</span> 查找文字（<span class="kbd">Enter</span> 下一个 / <span class="kbd">Shift</span>+<span class="kbd">Enter</span> 上一个）</li>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">C</span>/<span class="kbd">V</span>/<span class="kbd">D</span> 复制 / 粘贴 / 就地复制元素</li>',
        '<li>方向键微调 1px，<span class="kbd">Shift</span>+方向键 10px</li>',
        '<li><span class="kbd">Alt</span>+拖动 复制元素 · <span class="kbd">Shift</span>+点击 多选 · <span class="kbd">Delete</span> 删除</li>',
        '<li><span class="kbd">F5</span> 放映 · <span class="kbd">Esc</span> 退出</li>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">0</span> 适合窗口（也可点底部的百分比） · <span class="kbd">Ctrl</span>+<span class="kbd">+</span>/<span class="kbd">-</span> 缩放</li>',
        '<li><span class="kbd">Ctrl</span>+<span class="kbd">\\</span> 一键显示 / 隐藏两侧面板（也可以拖卡片边缘的拉手单独收起）</li>',
        '</ul>',
        '<h4>导出的 PPTX 里什么是矢量的</h4>',
        '<ul>',
        '<li><b>文字</b> → 真文本框，可改字、改字号、改颜色；断行位置与浏览器一致。</li>',
        '<li><b>纯色块、边框、圆角矩形</b> → 真形状，可改填充与轮廓。</li>',
        '<li><b>图片</b> → 真图片对象。</li>',
        '<li><b>渐变、外阴影、滤镜、旋转、SVG、半透明</b> → 浏览器渲染后作为贴图插入，视觉 100% 一致，但这一层不可再编辑文字。</li>',
        '<li>若某个贴图元素盖住了文字，被盖住的部分会一起进入贴图，保证导出与画布完全一致。</li>',
        '<li>页面底部预览的<b>演讲备注</b>会写进 PPTX 的备注页。</li>',
        '</ul>',
        '<h4>写 HTML 时的分页约定（可选）</h4>',
        '<p>引擎会自动识别常见的分页写法；如果要 100% 确定，用下面任意一种：</p>',
        '<pre>&lt;section class="slide"&gt; … &lt;/section&gt;\n' +
        '&lt;div data-wd-slide&gt; … &lt;/div&gt;\n' +
        '&lt;div class="slides"&gt;&lt;section&gt;…&lt;/section&gt;&lt;/div&gt;   &lt;!-- reveal.js --&gt;</pre>',
        '<p>页面尺寸建议 <code>1920 × 1080</code>，字体用系统字体（如 PingFang SC / Microsoft YaHei），并在页面里使用绝对定位，这样还原度最高。</p>',
        '<h4>已知限制</h4>',
        '<ul>',
        '<li>跨域图片 / 跨域字体读不到内容，会被跳过（本地文件与 data URI 不受影响）。</li>',
        '<li>文字依赖演示电脑上已安装的字体；引擎已为中文单独声明 <code>eastAsia</code> 字体以降低回退风险。</li>',
        '<li>自定义 <code>@font-face</code> 不会嵌入 PPTX，如需保真请改用系统字体或把该处做成图片。</li>',
        '</ul>'
      ].join(''),
      buttons: [{ label: '开始使用', primary: true }]
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     17.5 右键菜单
     选中元素时给出元素操作，未选中时给出页面操作 —— 这是「顺手编辑」
     的关键一环：层级、对齐、复制、删除都不该逼用户去顶栏找按钮。
     ══════════════════════════════════════════════════════════════════════ */

  function closeContextMenu() {
    var m = $('ctxmenu');
    if (m) m.hidden = true;
  }

  function buildContextItems(ctx) {
    ctx = ctx || {};
    var onSlide = ctx.slideIndex !== undefined && ctx.slideIndex !== null;
    var slideIndex = onSlide ? ctx.slideIndex : store.current;
    var hasSel = E.selection.length > 0;
    var multi = E.selection.length > 1;

    if (onSlide) {
      return [
        { ico: '＋', text: '在上方插入一页', run: function () { insertSlideAt(slideIndex); } },
        { ico: '＋', text: '在下方插入一页', run: function () { insertSlideAt(slideIndex + 1); } },
        { sep: true },
        { ico: '⧉', text: '复制此页', run: function () { duplicateSlide(slideIndex); } },
        { ico: '✕', text: '删除此页', danger: true, run: function () { doDeleteSlide(slideIndex); } },
        { sep: true },
        { ico: '?', text: '快捷键一览', run: showShortcuts },
      ];
    }

    if (!hasSel) {
      return [
        { ico: '▣', text: '全选本页元素', run: selectAllOnSlide },
        { sep: true },
        { ico: '＋', text: '新建一页', run: function () { insertSlideAt(store.count()); } },
        { ico: '⧉', text: '复制当前页', run: function () { duplicateSlide(store.current); } },
        { sep: true },
        { ico: '?', text: '快捷键一览', run: showShortcuts },
        { ico: '◐', text: '切换深色 / 浅色', run: toggleTheme },
      ];
    }

    var items = [
      { ico: '✎', text: '编辑文字', run: function () {
        var n = E.selection[0];
        if ((n.textContent || '').trim()) beginTextEdit(n);
        else toast('这个元素没有可编辑的文字', 'info', 1800);
      } },
      { sep: true },
      { ico: '⧉', text: '复制', hint: 'Ctrl+C', run: copySelection },
      { ico: '⎘', text: '再制', hint: 'Ctrl+D', run: duplicateSelection },
      { ico: '🗑', text: '删除', hint: 'Del', danger: true, run: deleteSelection },
      { sep: true },
      { ico: '⬆', text: '上移一层', hint: 'Ctrl+]', run: function () { layerAction('up'); } },
      { ico: '⬇', text: '下移一层', hint: 'Ctrl+[', run: function () { layerAction('down'); } },
      { ico: '⤒', text: '置于顶层', run: function () { layerAction('front'); } },
      { ico: '⤓', text: '置于底层', run: function () { layerAction('back'); } },
      { sep: true },
      { ico: '⊡', text: '锁定 / 解锁', run: toggleLockSelection },
    ];

    if (multi) {
      items = items.concat([
        { sep: true },
        { ico: '⬅', text: '左对齐', run: function () { alignAction('left'); } },
        { ico: '↔', text: '水平居中', run: function () { alignAction('hcenter'); } },
        { ico: '➡', text: '右对齐', run: function () { alignAction('right'); } },
        { ico: '⬆', text: '顶对齐', run: function () { alignAction('top'); } },
        { ico: '↕', text: '垂直居中', run: function () { alignAction('vcenter'); } },
        { ico: '⬇', text: '底对齐', run: function () { alignAction('bottom'); } },
        { ico: '⇔', text: '水平等距', run: function () { alignAction('dist-h'); } },
        { ico: '⇕', text: '垂直等距', run: function () { alignAction('dist-v'); } },
      ]);
    }

    items.push({ sep: true });
    items.push({ ico: '?', text: '快捷键一览', run: showShortcuts });
    return items;
  }

  function openContextMenu(x, y, ctx) {
    var menu = $('ctxmenu');
    if (!menu) return;
    menu.innerHTML = '';
    buildContextItems(ctx).forEach(function (it) {
      if (it.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); return; }
      var btn = el('button', {
        class: 'ctx-item' + (it.danger ? ' danger' : ''), type: 'button'
      });
      btn.appendChild(el('span', { class: 'ctx-ico', text: it.ico || '' }));
      btn.appendChild(el('span', { class: 'ctx-txt', text: it.text }));
      if (it.hint) btn.appendChild(el('span', { class: 'ctx-hint', text: it.hint }));
      btn.addEventListener('click', function () { closeContextMenu(); it.run(); });
      menu.appendChild(btn);
    });

    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(Math.max(6, x), window.innerWidth - w - 6) + 'px';
    menu.style.top = Math.min(Math.max(6, y), window.innerHeight - h - 6) + 'px';
  }

  function insertSlideAt(index) {
    /* addBlankSlide(layout, index) 会把新页插到 index 处并切过去 */
    var at = Math.max(0, Math.min(store.count(), index));
    store.addBlankSlide('blank', at);
    loadStage().then(function () { renderRail(); updateInspector(); });
  }

  function duplicateSlide(index) {
    store.duplicateSlide(index);
    loadStage().then(function () { renderRail(); updateInspector(); });
  }

  function selectAllOnSlide() {
    var doc = frameDoc();
    var root = WD.render.findRoot(doc);
    if (!root) return;
    var win = frameWin();
    var picked = [];
    for (var i = 0; i < root.children.length; i++) {
      if (U.shouldSkip(root.children[i])) continue;
      if (isSelectable(root.children[i], win)) picked.push(root.children[i]);
    }
    if (!picked.length) { toast('本页没有可选择的元素', 'info', 1600); return; }
    setSelection(picked);
  }

  function toggleLockSelection() {
    var anyUnlocked = E.selection.some(function (n) { return !n.hasAttribute('data-wd-locked'); });
    E.selection.forEach(function (n) {
      if (anyUnlocked) n.setAttribute('data-wd-locked', '1');
      else n.removeAttribute('data-wd-locked');
    });
    refreshOverlay();
    commit(anyUnlocked ? '锁定元素' : '解锁元素');
    toast(anyUnlocked ? '已锁定所选元素' : '已解锁所选元素', 'ok', 1800);
  }

  function showShortcuts() {
    var rows = [
      ['选择', '单击选中 · Shift+单击多选 · 空白处拖动框选 · Esc 取消'],
      ['移动', '拖动元素 · 方向键 1px · Shift+方向键 10px'],
      ['缩放 / 旋转', '拖四角手柄 · 拖顶部圆点旋转（按住 Shift 吸附 15°）'],
      ['改文字', '双击元素直接编辑 · Esc 或 Ctrl+Enter 退出'],
      ['复制删除', 'Ctrl+C 复制 · Ctrl+V 粘贴 · Ctrl+D 再制 · Delete 删除'],
      ['层级', 'Ctrl+] 上移一层 · Ctrl+[ 下移一层'],
      ['历史', 'Ctrl+Z 撤销 · Ctrl+Shift+Z 重做'],
      ['对齐', '多选后用浮动工具条或右键菜单对齐'],
      ['插入', '顶栏「文本框 / 标题 / 形状 / 图片 / 视频」'],
      ['查找', 'Ctrl+F 查找文字 · Enter 下一个 · Esc 关闭'],
      ['样式搬运', '顶栏格式刷：选中源元素后点它，再点目标元素'],
      ['面板', 'Ctrl+\\ 一键显隐两侧 · 也可以拖卡片边缘的拉手单独收起'],
      ['放映', 'F5 进入 · ← → 或空格翻页 · Home/End 跳首页尾页 · N 备注 · F 全屏 · Esc 退全屏、再按退放映'],
      ['其他', 'Ctrl+O 打开 HTML · Ctrl+S 保存工程 · Ctrl+E 导出 PPTX · Ctrl+0 适合窗口'],
    ];
    var html = '<table class="shortcuts"><tbody>' + rows.map(function (r) {
      return '<tr><th>' + U.escapeHtml(r[0]) + '</th><td>' + U.escapeHtml(r[1]) + '</td></tr>';
    }).join('') + '</tbody></table>';
    showModal({ title: '快捷键一览', html: html });
  }

  /* ══════════════════════════════════════════════════════════════════════
     18. 初始化
     ══════════════════════════════════════════════════════════════════════ */

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('wizdeck.theme'); } catch (e) { /* ignore */ }
    applyTheme(saved || 'light');
  }

  function applyTheme(theme) {
    store.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('wizdeck.theme', theme); } catch (e) { /* ignore */ }
  }

  function toggleTheme() {
    applyTheme(store.theme === 'dark' ? 'light' : 'dark');
  }

  /* 面板折叠 / 展开时让舞台缩放**逐帧跟随** CSS 宽度过渡。
     坑：以前 measure() 只在过渡开始前跑一次 + transitionend 收尾一次，
     中间态画布始终停在旧尺寸；一旦过渡被 ResizeObserver 打断又补一次
     measure，就会出现「先跳一半、再跳到底」的两段式抖动，用户主观感受
     就是"PPT 放大不流畅"。改成 rAF 每帧重读 canvas rect,画布就跟着
     面板同一条 cubic-bezier 曲线连续变化，视觉上是一次平滑的贴合。 */
  var FOLLOW_MS = 260;           /* 覆盖 220ms 过渡 + 一点余量 */
  var followRaf = 0;
  var settleTimer = null;

  function stopFollow() {
    if (followRaf) { cancelAnimationFrame(followRaf); followRaf = 0; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (E.stage) E.stage._animLock = false;
    if (E.stage && E.stage.el) E.stage.el.classList.remove('stage-following');
  }

  function settleStage() {
    stopFollow();
    if (!E.stage) return;
    var avail = E.stage.canvasEl.getBoundingClientRect();
    E.stage._applyScale(avail.width, avail.height);
    updateZoomLabel();
    refreshOverlay();
  }

  function armSettleFallback() {
    /* 兜底：后台标签页 rAF 会被挂起 / 浏览器没派发 transitionend 时
       不能让画布永远停在中间态。340ms 覆盖 260ms 主动画 + 富余。 */
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settleStage, 340);
  }

  function startFollow() {
    if (!E.stage) return;
    if (followRaf) cancelAnimationFrame(followRaf);
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    E.stage._animLock = true;
    E.stage.el.classList.add('stage-following');
    var start = performance.now();
    function tick(now) {
      if (!E.stage) { followRaf = 0; return; }
      var avail = E.stage.canvasEl.getBoundingClientRect();
      E.stage._applyScale(avail.width, avail.height);
      updateZoomLabel();
      if (now - start < FOLLOW_MS) {
        followRaf = requestAnimationFrame(tick);
      } else {
        followRaf = 0;
        E.stage._animLock = false;
        E.stage.el.classList.remove('stage-following');
        /* 收尾再对齐一次,吃掉 CSS 过渡最后几帧的舍入误差 */
        var r2 = E.stage.canvasEl.getBoundingClientRect();
        E.stage._applyScale(r2.width, r2.height);
        updateZoomLabel();
        refreshOverlay();
      }
    }
    followRaf = requestAnimationFrame(tick);
    armSettleFallback();
  }

  /* transitionend 只在 rAF 循环没跑起来时才作为兜底收尾。
     循环自己会在 FOLLOW_MS 后干净结束,不需要额外触发。 */
  document.addEventListener('transitionend', function (e) {
    if (e.propertyName !== 'width') return;
    if (e.target !== $('sidebar') && e.target !== $('inspector')) return;
    if (followRaf) return;         /* 循环正在跑, 别抢 */
    settleStage();
  });

  /* 折叠 / 展开左右面板，并同步浮动拉手与顶栏按钮的状态 */
  function setPanelCollapsed(which, collapsed) {
    var panel = $(which === 'sidebar' ? 'sidebar' : 'inspector');
    if (!panel) return;
    panel.classList.toggle('collapsed', !!collapsed);

    var tab = $(which === 'sidebar' ? 'btn-rail-open' : 'btn-insp-open');
    var head = $(which === 'sidebar' ? 'btn-rail-collapse' : 'btn-insp-collapse');
    if (tab) tab.hidden = !collapsed;
    if (head) head.textContent = collapsed
      ? (which === 'sidebar' ? '⟩' : '⟨')
      : (which === 'sidebar' ? '⟨' : '⟩');

    startFollow();
  }

  function init() {
    initTheme();
    initSwatches();

    E.stage = new WD.render.Stage({
      el: $('stage'),
      frame: $('stage-frame'),
      canvas: $('stage-canvas'),
      onReady: function () {
        updateZoomLabel();
        refreshOverlay();
      }
    });

    /* 顶栏 */
    /* 顶栏的「打开 HTML」按钮已按要求移除；打开入口现在在
       空状态的「打开 HTML 文件」按钮、保存与导出菜单里的第一项，以及 Ctrl+O / 拖拽。 */
    var openBtn = $('btn-open'); if (openBtn) openBtn.addEventListener('click', function () { $('file-input').click(); });
    $('btn-open-2').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) readFile(f);
      this.value = '';
    });
    /* 「示例」按钮与「载入示例课件」按钮都已按要求移除。
       loadSample 仍然保留为可编程入口（自动化测试与 localStorage 自动载入用）。 */
    var sampleBtn = $('btn-sample'); if (sampleBtn) sampleBtn.addEventListener('click', loadSample);
    var sampleBtn2 = $('btn-sample-2'); if (sampleBtn2) sampleBtn2.addEventListener('click', loadSample);
    $('btn-undo').addEventListener('click', doUndo);
    $('btn-redo').addEventListener('click', doRedo);
    $('btn-add-slide').addEventListener('click', function () {
      if (!store.model) { newDeck(); return; }
      /* 新建页一律是空白页（版式由用户在页内自己搭） */
      store.addBlankSlide('blank');
      goSlide(store.current);
    });
    /* 「适合窗口」按钮已移除，Ctrl+0 与底部百分比点击仍可唤起 */
    $('btn-zoom-in').addEventListener('click', function () { E.stage.zoomBy(1.15); updateZoomLabel(); });
    $('btn-zoom-out').addEventListener('click', function () { E.stage.zoomBy(1 / 1.15); updateZoomLabel(); });
    $('zoom-label').addEventListener('click', function () {
      if (E.stage.zoom === 1) E.stage.fit(); else E.stage.setZoom(1);
      updateZoomLabel();
    });
    /* 保存 / 导出合并成一个下拉 */
    bindSaveMenu();
    $('btn-present').addEventListener('click', startPresent);
    $('btn-theme').addEventListener('click', toggleTheme);
    $('btn-help').addEventListener('click', showHelp);

    /* 插入组：文本框 / 标题 / 形状 / 表格 / 公式 / 图表 走各自的子菜单，
       图片 / 视频与表格是直插（图片视频弹文件选择器，表格弹行列对话框）。 */
    $('btn-insert-image').addEventListener('click', function () { addElement('image'); });
    $('btn-insert-video').addEventListener('click', function () { addElement('video'); });
    $('btn-insert-table').addEventListener('click', function () { addElement('table'); });
    bindInsertMenu();
    /* 格式刷与查找 */
    bindPainter();
    bindFind();

    /* 面板折叠
       坑：原来的展开按钮就在面板的 .panel-head 里，而 .panel-head 在折叠时
       是 display:none —— 收起之后按钮跟着消失，再也点不回来。
       现在改成：折叠后由「贴边的浮动拉手」负责展开，顶栏也有总开关。 */
    $('btn-rail-collapse').addEventListener('click', function () {
      setPanelCollapsed('sidebar', !$('sidebar').classList.contains('collapsed'));
    });
    $('btn-insp-collapse').addEventListener('click', function () {
      setPanelCollapsed('inspector', !$('inspector').classList.contains('collapsed'));
    });
    $('btn-rail-open').addEventListener('click', function () { setPanelCollapsed('sidebar', false); });
    $('btn-insp-open').addEventListener('click', function () { setPanelCollapsed('inspector', false); });
    /* 顶栏的「面板」总开关按钮已按要求移除。
       一键显隐两侧改绑到 Ctrl+\ —— 单侧仍然由卡片边缘的拉手控制，
       所以并没有丢失操作路径。 */
    var toggleBothPanels = function () {
      var anyOpen = !$('sidebar').classList.contains('collapsed') ||
                    !$('inspector').classList.contains('collapsed');
      setPanelCollapsed('sidebar', anyOpen);
      setPanelCollapsed('inspector', anyOpen);
    };
    E.toggleBothPanels = toggleBothPanels;

    /* 浮层工具条 */
    $$('#ov-toolbar button').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-tb');
        if (t === 'edit-text') {
          var n = pickTextBlockInside(selected(), 0, 0) || selected();
          if (n && (n.textContent || '').trim()) beginTextEdit(n);
          else toast('这个元素没有可编辑的文字', 'warn');
        } else if (t === 'dup') duplicateSelection();
        else if (t === 'front') layerAction('front');
        else if (t === 'back') layerAction('back');
        else if (t === 'del') deleteSelection();
      });
    });

    /* 添加元素已上移到顶栏的「文本框 / 标题 / 形状」插入组 */

    /* 图层操作按钮 */
    var layerBtn = function (id, kind) {
      var b = $(id);
      if (!b) return;
      b.addEventListener('click', function () {
        if (!E.selection.length) { toast('请先选中一个元素', 'warn', 1600); return; }
        layerAction(kind);
        renderLayers();
      });
    };
    layerBtn('btn-layer-up', 'up');
    layerBtn('btn-layer-down', 'down');
    layerBtn('btn-layer-front', 'front');
    layerBtn('btn-layer-back', 'back');

    /* 选择框交互 */
    var frameBox = $('frame-box');
    frameBox.addEventListener('pointerdown', function (ev) {
      if (ev.target.classList.contains('handle')) return;
      if (E.selection.length && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
        setSelection(E.selection.slice(1));
        return;
      }
      beginDrag('move', ev);
      ev.preventDefault();
    });
    $$('.handle', frameBox).forEach(function (h) {
      h.addEventListener('pointerdown', function (ev) {
        if (h.getAttribute('data-h') === 'rot') beginDrag('rotate', ev);
        else beginDrag('resize', ev);
        ev.preventDefault();
        ev.stopPropagation();
      });
    });

    /* 右键菜单：画布与左栏缩略图都可唤起 */
    $('stage-frame').addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      openContextMenu(ev.clientX, ev.clientY);
    });
    $('rail').addEventListener('contextmenu', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.rail-item') : null;
      if (!item) return;
      ev.preventDefault();
      openContextMenu(ev.clientX, ev.clientY, { slideIndex: Number(item.getAttribute('data-index')) });
    });

    /* 模态 / 放映关闭 */
    $('modal-close').addEventListener('click', hideModal);
    $('modal').addEventListener('click', function (ev) { if (ev.target === $('modal')) hideModal(); });
    $('present-exit').addEventListener('click', stopPresent);
    $('present-notes-btn').addEventListener('click', togglePresentNotes);
    prevBtn = $('present-prev');
    nextBtn = $('present-next');
    fsBtn = $('present-fs');
    if (prevBtn) prevBtn.addEventListener('click', function () { goPresent(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { goPresent(1); });
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
    $('present').addEventListener('click', function (ev) {
      if (ev.target === $('present') || ev.target === $('present-frame')) {
        goPresent(1);
      }
    });

    /* ══ 舞台空白区：点击取消选择，拖动则框选 ══
       #marquee 的元素与样式一直存在，但从未接过逻辑 —— 框选其实是缺失的。
       难点：空白区上方盖着 iframe，指针事件会落到帧里；一旦帧收到 pointerdown
       还会把它当成「拖动元素」。所以进入框选时先关掉舞台的 pointer-events，
       让事件全部回到父页，由 window 监听统一处理。 */
    $('stage-canvas').addEventListener('pointerdown', function (ev) {
      var t = ev.target;
      if (t !== $('stage-canvas') && t !== $('stage') && t !== $('stage-frame')) return;
      if (ev.button !== 0) return;
      startMarquee(ev);
    });

    /* 窗口缩放 */
    var onResize = U.debounce(function () {
      E.stage.measure();
      updateZoomLabel();
      refreshOverlay();
    }, 120);
    window.addEventListener('resize', onResize);
    if (global.ResizeObserver) {
      new ResizeObserver(onResize).observe($('stage-canvas'));
    }

    /* 右键菜单的关闭时机：任意点击 / 滚动 / 缩放 / Esc 都应收起 */
    window.addEventListener('pointerdown', function (ev) {
      var menu = $('ctxmenu');
      if (!menu || menu.hidden) return;
      if (ev.target === menu || (ev.target.closest && ev.target.closest('#ctxmenu'))) return;
      closeContextMenu();
    }, true);
    window.addEventListener('wheel', closeContextMenu, { passive: true });
    window.addEventListener('resize', closeContextMenu);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeContextMenu();
    }, true);

    /* 拖放文件 */
    var dragDepth = 0;
    window.addEventListener('dragenter', function (ev) {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
      dragDepth++;
      document.body.classList.add('dragging-file');
    });
    window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging-file');
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging-file');
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!f) return;
      if (!/\.(html?|wd\.html)$/i.test(f.name)) { toast('请拖入 .html / .htm / .wd.html 文件', 'warn'); return; }
      readFile(f);
    });

    /* 全局键盘 */
    window.addEventListener('keydown', onKeyDown);

    /* 离开前提醒 */
    window.addEventListener('beforeunload', function (ev) {
      if (store.dirty) { ev.preventDefault(); ev.returnValue = ''; return ''; }
    });

    /* 状态订阅 */
    store.on('change', function () { updateHistoryButtons(); });
    store.on('dirty', function () { updateHistoryButtons(); });
    store.on('history', function () { updateHistoryButtons(); });
    store.on('slide', function () { updateStatus(); });

    bindInspector();
    bindFormatBar();
    setStatusHint(null);
    updateZoomLabel();
    updateHistoryButtons();

    /* 自动尝试载入示例（仅在通过 http/file 且存在示例时） */
    tryLoadAutostart();
  }

  function tryLoadAutostart() {
    var wantSample = false;
    try {
      if (localStorage.getItem('wizdeck.autosample') === '1') wantSample = true;
    } catch (e) { /* ignore */ }
    if (wantSample) loadSample();
  }

  /* 暴露给外部调试与自动化校验 */
    /* ══════════════════════════════════════════════════════════════════════
     19. 顶栏新组件：下拉菜单 / 插入组 / 格式刷 / 查找
     ══════════════════════════════════════════════════════════════════════ */

  /* 通用下拉：点外面或按 Esc 关闭。菜单用 JS 填充，方便按状态动态生成。 */
  var openMenu = null;
  function closeMenus(except) {
    if (!openMenu || openMenu === except) { openMenu = null; return; }
    openMenu.menu.hidden = true;
    if (openMenu.trigger) openMenu.trigger.setAttribute('aria-expanded', 'false');
    /* 必须置空。曾经这里漏了 openMenu = null，于是：
       点一次打开 → 再点一次收起 → 第三次再也打不开。
       因为 toggle 逻辑判断的是 openMenu.menu === menu，
       而 openMenu 一直指着那个「已经 hidden」的菜单，每次都误判成「本来就开着」。 */
    openMenu = null;
  }
  function showMenu(trigger, menu, build) {
    /* 判断「这次是开还是关」只能看菜单自己的 hidden ——
       不能看 openMenu，因为 openMenu 会被全局兜底逻辑提前改动。 */
    var wasOpen = !menu.hidden;
    closeMenus();
    if (wasOpen) return;
    menu.innerHTML = '';
    build(menu);
    menu.hidden = false;
    positionMenu(trigger, menu);
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { menu: menu, trigger: trigger };
  }

  /* 菜单用 fixed 定位，坐标每次现算。
     为什么不用 absolute：顶栏改成了横向滚动容器（按钮都变成「图标 + 文字」，
     宽度装不下时必须能滚），而 absolute 的后代会被祖先的 overflow 直接裁掉 ——
     下拉一展开就只剩一条边。fixed 的包含块是视口，不受滚动容器裁剪影响。 */
  function positionMenu(trigger, menu) {
    var r = trigger.getBoundingClientRect();
    var w = menu.offsetWidth || 200;
    var h = menu.offsetHeight || 120;
    /* 两边都要夹。以前只夹了左边：菜单是「触发按钮右缘 - 菜单宽」定位的，
       一旦触发按钮本身被顶栏横向滚动推出了视口（插入组变宽 + 文字格式条出现
       就会这样），菜单就会整块落在屏幕右边看不见的地方。
       顶栏本来就装不下而要滚动，所以「按钮可能不在视野内」是常态，不是意外。 */
    var left = r.right - w;
    if (left + w > window.innerWidth - 10) left = window.innerWidth - 10 - w;
    if (left < 10) left = 10;
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 10) top = Math.max(10, window.innerHeight - 10 - h);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  function bindSaveMenu() {
    var trigger = $('btn-save-menu');
    var menu = $('menu-save');
    if (!trigger || !menu) return;
    trigger.addEventListener('click', function (ev) {
      ev.stopPropagation();
      showMenu(trigger, menu, function (m) {
        [
          /* 顶栏的「打开 HTML」按钮已按要求移除，
             打开入口收进这个文件菜单 —— 否则载入文档之后就再也没法换文件了。
             快捷键 Ctrl+O 与拖拽仍然有效。 */
          { ico: '📂', txt: '打开 HTML 文件', hint: 'Ctrl+O', run: function () { $('file-input').click(); } },
          { ico: '💾', txt: '保存工程（.wd.html）', hint: 'Ctrl+S', run: saveProject },
          { ico: '🗎', txt: '导出 HTML', hint: '', run: saveCleanHtml },
          { ico: '📊', txt: '导出 PPTX', hint: 'Ctrl+E', run: doExportPptx },
        ].forEach(function (it) {
          var b = el('button', { class: 'menu-item', type: 'button' });
          b.appendChild(el('span', { class: 'mi-ico', text: it.ico }));
          b.appendChild(el('span', { class: 'mi-txt', text: it.txt }));
          if (it.hint) b.appendChild(el('span', { class: 'mi-hint', text: it.hint }));
          b.addEventListener('click', function () { closeMenus(); it.run(); });
          m.appendChild(b);
        });
      });
    });
  }

  /* 插入组：「形状」下拉。图标是 Unicode 几何符号 ——
     它们只占 16px 的一格，右边还有文字说明，不需要自己画一套 SVG。 */
  var SHAPE_KINDS = [
    { k: 'rect', ico: '▭', txt: '矩形' },
    { k: 'round', ico: '▢', txt: '圆角矩形' },
    { k: 'circle', ico: '◯', txt: '圆形' },
    { k: 'oval', ico: '⬭', txt: '椭圆' },
    { k: 'triangle', ico: '△', txt: '三角形' },
    { k: 'para', ico: '▱', txt: '平行四边形' },
    { k: 'line', ico: '─', txt: '直线' },
    { k: 'arrow', ico: '⟶', txt: '箭头' },
    { k: 'dblarrow', ico: '⟷', txt: '双向箭头' },
    /* 图片 / 视频不混在这里 —— 它们要弹文件选择器、是「独立能力」而不是「形状」，
       混在形状里既容易被误点，也让这个下拉名不副实。已上移为顶栏两个按钮。 */
  ];

  /* 标题：一到四级。图标写 H1~H4 —— 四个一模一样的「H」并排放着，
     光看图标根本分不出级别，只能把鼠标一个个停上去等 tooltip。 */
  var TITLE_KINDS = [
    { k: 'title1', ico: 'H1', txt: '一级标题' },
    { k: 'title2', ico: 'H2', txt: '二级标题' },
    { k: 'title3', ico: 'H3', txt: '三级标题' },
    { k: 'title4', ico: 'H4', txt: '四级标题' },
  ];

  /* 文本框：横排 / 竖排 */
  var TEXT_KINDS = [
    { k: 'text', ico: '↔', txt: '横向文本框' },
    { k: 'textv', ico: '↕', txt: '竖向文本框' },
  ];

  /* 公式：直接插入 / LaTeX 弹窗（自动解析）。
     文案照 PowerPoint 的「插入公式 / 插入 LaTeX」来：那个图标本身就在讲
     「这是公式 / 这是 LaTeX」，用户不需要先读懂文字再决定点哪个。 */
  var FORMULA_KINDS = [
    { k: 'formula', ico: '√x', txt: '插入公式' },
    { k: 'latex', ico: 'TeX', txt: '插入 LaTeX' },
  ];

  /* 图表 */
  var CHART_KINDS = [
    { k: 'bar', ico: '▊', txt: '柱状图' },
    { k: 'chartline', ico: '⟋', txt: '折线图' },
    { k: 'pie', ico: '◔', txt: '饼状图' },
  ];

  /* 插入组的通用下拉：文本框 / 标题 / 形状 / 公式 / 图表。
     条目样式与「保存与导出」完全一致 —— **左边图标、右边文字**。
     以前这里是一排只有符号的方块：四个「H」并排放在一起，
     哪个是一级哪个是四级全靠猜；中文标签被藏在 title 里，得把鼠标停上去等一秒才读得到。 */
  function bindKindMenu(triggerId, menuId, kinds) {
    var trigger = $(triggerId);
    var menu = $(menuId);
    if (!trigger || !menu) return;
    trigger.addEventListener('click', function (ev) {
      ev.stopPropagation();
      showMenu(trigger, menu, function (m) {
        var row = el('div', { class: 'shape-row' });
        kinds.forEach(function (s) {
          var b = el('button', { class: 'menu-item', type: 'button', title: s.txt });
          b.appendChild(el('span', { class: 'mi-ico', text: s.ico }));
          b.appendChild(el('span', { class: 'mi-txt', text: s.txt }));
          b.addEventListener('click', function () { closeMenus(); addElement(s.k); });
          row.appendChild(b);
        });
        m.appendChild(row);
      });
    });
  }

  function bindInsertMenu() {
    bindKindMenu('btn-insert-shape', 'menu-insert', SHAPE_KINDS);
    bindKindMenu('btn-insert-title', 'menu-title', TITLE_KINDS);
    bindKindMenu('btn-insert-text', 'menu-text', TEXT_KINDS);
    bindKindMenu('btn-insert-formula', 'menu-formula', FORMULA_KINDS);
    bindKindMenu('btn-insert-chart', 'menu-chart', CHART_KINDS);
  }

  /* ── 格式刷：把源元素的「视觉相关」内联样式复制到目标元素 ──
     只搬视觉属性，不搬定位/尺寸 —— 否则会把目标的版面整个顶掉。 */
  var PAINT_PROPS = [
    'color', 'background-color', 'background-image', 'background-size', 'background-position',
    'background-repeat', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-align', 'text-decoration',
    'line-height', 'letter-spacing', 'text-transform', 'opacity', 'filter', 'mix-blend-mode',
  ];
  var painter = null;   /* { source: 节点, styles: {} } */

  function capturePaint(node) {
    var out = {};
    var cs = frameWin().getComputedStyle(node);
    PAINT_PROPS.forEach(function (p) {
      var v = cs.getPropertyValue(p);
      if (v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') {
        out[p] = v;
      }
    });
    return out;
  }

  function setPainterActive(on) {
    var b = $('btn-painter');
    if (b) b.classList.toggle('on', !!on);
  }

  function bindPainter() {
    var btn = $('btn-painter');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (painter) { painter = null; setPainterActive(false); setStatusHint('格式刷已取消'); return; }
      var src = E.selection[0];
      if (!src) { toast('先选中一个元素，再点格式刷', 'warn'); return; }
      painter = { styles: capturePaint(src), name: U.elementLabel(src) };
      setPainterActive(true);
      setStatusHint('格式刷已就绪：点另一个元素套用 · 再点一次按钮取消');
    });
  }

  /* 格式刷生效点：挂在画布 pointerdown 的最前面（E.selection 变化之前） */
  function tryPaint(target) {
    if (!painter || !target) return false;
    var styles = painter.styles;
    Object.keys(styles).forEach(function (p) { setStyleSmart(target, p, styles[p]); });
    refreshOverlay();
    updateInspectorValues();
    commit('格式刷');
    /* 一次性：用完即失效，避免误连点把整页刷成一样 */
    painter = null;
    setPainterActive(false);
    setStatusHint('已套用格式 · 需要继续请再点一次格式刷');
    return true;
  }

  /* ── 查找 ── */
  var findState = { hits: [], idx: -1, nodes: [] };

  function clearFindMarks() {
    var doc = frameDoc();
    if (!doc) return;
    doc.querySelectorAll('[data-wd-find-hit]').forEach(function (n) { n.removeAttribute('data-wd-find-hit'); });
  }

  function runFind(q, dir) {
    clearFindMarks();
    findState.hits = []; findState.nodes = []; findState.idx = -1;
    var cnt = $('find-count');
    if (!q) { if (cnt) cnt.textContent = ''; return; }

    /* 搜当前页全部文本节点；命中后把所属的可选元素标出来 */
    var doc = frameDoc();
    var win = frameWin();
    if (!doc) return;
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.toLowerCase().indexOf(q.toLowerCase()) < 0) continue;
      var host = n.parentElement;
      while (host && !isSelectable(host, win)) host = host.parentElement;
      if (!host) continue;
      if (findState.nodes.indexOf(host) < 0) findState.nodes.push(host);
    }

    findState.nodes.forEach(function (el) {
      el.setAttribute('data-wd-find-hit', '1');
      findState.hits.push(el);
    });

    if (!findState.hits.length) {
      if (cnt) cnt.textContent = '无结果';
      setStatusHint('没有找到「' + q + '」');
      return;
    }
    findState.idx = dir < 0 ? findState.hits.length - 1 : 0;
    focusFindHit();
  }

  function focusFindHit() {
    var n = findState.hits[findState.idx];
    var cnt = $('find-count');
    if (cnt && n) cnt.textContent = (findState.idx + 1) + ' / ' + findState.hits.length;
    if (!n) return;
    clearSelection();
    setSelection([n]);
    var doc = frameDoc();
    var root = rootEl();
    if (!root) return;
    var nr = n.getBoundingClientRect(), rr = root.getBoundingClientRect();
    /* 滚到可视范围内（帧里 scrolling=no，用 scrollTop 挪） */
    try {
      if (nr.top - rr.top < 60 || nr.bottom - rr.top > H - 60) {
        doc.documentElement.scrollTop = Math.max(0, nr.top - rr.top - H / 2);
      }
    } catch (e) { /* 忽略 */ }
    refreshOverlay();
  }

  function stepFind(dir) {
    if (!findState.hits.length) return;
    findState.idx = (findState.idx + dir + findState.hits.length) % findState.hits.length;
    focusFindHit();
  }

  function toggleFind(force) {
    var bar = $('find-bar');
    var btn = $('btn-find');
    if (!bar) return;
    var show = force === undefined ? bar.hidden : force;
    bar.hidden = !show;
    if (btn) btn.setAttribute('aria-expanded', String(show));
    if (show) {
      var input = $('find-input');
      if (input) { input.focus(); input.select(); }
    } else {
      clearFindMarks();
      findState.hits = []; findState.nodes = []; findState.idx = -1;
      var cnt = $('find-count'); if (cnt) cnt.textContent = '';
    }
  }

  function bindFind() {
    var input = $('find-input');
    if (!input) return;
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { runFind(input.value.trim(), 1); }, 180);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); toggleFind(false); }
    });
    $('find-next').addEventListener('click', function () { stepFind(1); });
    $('find-prev').addEventListener('click', function () { stepFind(-1); });
    $('find-close').addEventListener('click', function () { toggleFind(false); });
    $('btn-find').addEventListener('click', function (ev) { ev.stopPropagation(); toggleFind(); });
  }

  /* 关闭菜单 / 查找的全局兜底。
     注意这里是**冒泡**而不是捕获：捕获阶段会先于按钮自己的 handler 执行，
     于是「点一下打开、再点一下收起」的第二次点击会先被这里关掉，
     紧接着按钮又把它打开 —— 下拉就成了「只能下拉一次」。
     冒泡阶段里触发按钮已经 stopPropagation，走不到这里；
     再补一个 contains 判断兜住将来别的触发器。 */
  document.addEventListener('click', function (ev) {
    if (openMenu && openMenu.trigger && openMenu.trigger.contains(ev.target)) return;
    closeMenus();
  });
  /* 菜单是 fixed 定位的：顶栏一旦横向滚动，菜单就会和它的按钮脱节，
     所以滚动时直接收起来（也是 Office 那套 ribbon 的行为）。 */
  document.addEventListener('scroll', function (ev) {
    if (ev.target && ev.target.classList && ev.target.classList.contains('topbar')) closeMenus();
  }, true);
  window.addEventListener('resize', function () { closeMenus(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeMenus();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      toggleFind();
    }
  });

  WD.app = {
    E: E, store: store, init: init, importHtml: importHtml, loadSample: loadSample,
    toast: toast, busy: busy, busyDone: busyDone, commit: commit,
    newDeck: newDeck, showHelp: showHelp, doExportPptx: doExportPptx,
    /* 直接载入一份现有模型（供脚本 / 自动化使用，跳过文件选择对话框） */
    loadDeck: function (deck, fileName) {
      adoptDeck(deck, fileName || (deck && deck.title) || '');
      return { slides: store.count() };
    },
    /* 重新装载当前舞台（模型被外部改动后调用） */
    reload: function () {
      renderRail();
      initFontOptions();
      return loadStage().then(function () { updateInspector(); updateHistoryButtons(); });
    },
  /* 内部函数暴露给自动化测试（真实用户不会用到） */
    _internal: {
      applyStyle: applyStyle,
      styleChanged: styleChanged,
      setStyleSmart: setStyleSmart,
      beginDrag: beginDrag,
      onDragMove: onDragMove,
      onDragEnd: onDragEnd,
      onKeyDown: onKeyDown,
      isTypingTarget: isTypingTarget,
      pickAt: pickAt,
      isSelectable: isSelectable,
      isInlineTextTag: isInlineTextTag,
      isPageBackdrop: isPageBackdrop,
      hasOwnPaint: hasOwnPaint,
      visualBox: visualBox,
      pinElement: pinElement,
      repositionElement: repositionElement,
      normalizePoint: normalizePoint,
      deleteSelection: deleteSelection,
      duplicateSelection: duplicateSelection,
      alignAction: alignAction,
      layerAction: layerAction,
      refreshOverlay: refreshOverlay,
      updateInspector: updateInspector,
      updateInspectorValues: updateInspectorValues,
      onFramePointerDown: onFramePointerDown,
      endTextEdit: endTextEdit,
      beginTextEdit: beginTextEdit,
      textBlockFor: textBlockFor,
      onFrameDblClick: onFrameDblClick,
      caretPositionAt: caretPositionAt,
      elementsInRect: elementsInRect,
      startMarquee: startMarquee,
      beginMarqueeFromFrame: beginMarqueeFromFrame,
      onMarqueeMove: onMarqueeMove,
      onMarqueeEnd: onMarqueeEnd,
      selectAllOnSlide: selectAllOnSlide,
      toggleLockSelection: toggleLockSelection,
      insertSlideAt: insertSlideAt,
      duplicateSlide: duplicateSlide,
      buildContextItems: buildContextItems,
      openContextMenu: openContextMenu,
      closeContextMenu: closeContextMenu,
      zOf: zOf,
      paintedOrder: paintedOrder,
      setSelection: setSelection,
      clearSelection: clearSelection,
      marqueeState: function () { return marqueeState; },
      addElement: addElement,
      elementSpecs: function () { return Object.keys(ELEMENT_SPECS); },
      renderLayers: renderLayers,
      layerNodes: layerNodes,
      reorderLayer: reorderLayer,
      computeSnap: computeSnap,
      snapTargets: snapTargets,
      drawGuides: drawGuides,
      clearGuides: clearGuides,
      guidesDom: function () { return ($('guides') || {}).innerHTML || ''; },
    },
    debug: {
      on: function () { WD_DEBUG = true; global.__wdLog = []; },
      off: function () { WD_DEBUG = false; },
      log: function () { return global.__wdLog || []; },
      clear: function () { global.__wdLog = []; },
    },
    /* 把每一页按浏览器渲染结果栅格化，返回 PNG dataURL 数组（用于导出保真度比对） */
    renderSlidePngs: function (width) {
      var out = [];
      var list = store.model ? store.model.slides : [];
      return list.reduce(function (p, slide, i) {
        return p.then(function () {
          return WD.render.mountFrame(slide.doc, { timeout: 20000 }).then(function (m) {
            var root = WD.render.findRoot(m.doc);
            return WD.render.rasterizeRootSlice(root, m.win, width || W).then(function (canvas) {
              out.push(canvas ? canvas.toDataURL('image/png') : null);
              m.frame.remove();
            });
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(typeof window !== 'undefined' ? window : globalThis);
