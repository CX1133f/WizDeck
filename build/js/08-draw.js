/* ============================================================================
   画布绘制工具：自由绘制 · 多边形
   ----------------------------------------------------------------------------
   这两个形状没法像矩形那样「插一个默认值再拖手柄」：它们的几何是**画出来的**。
       · 自由绘制：按住拖，笔迹跟着指针走，松开成图；
       · 多边形：逐点点出顶点，双击 / 回车 / 点回起点收口。

   为什么绘制态单独一个模块，而不是塞进 06-ui：
   06-ui 已经背着面板、检查器、右键菜单一整套；绘制是「一段有开始有结束的
   交互流程」，它自己管监听、预览与收尾，边界清楚，单独放更好读。

   两条实现要点：

   ① 监听挂在**帧文档**上，坐标直接用 ev.clientX/clientY。
      舞台是 1920×1080 的 iframe 套 transform:scale，帧内指针事件的
      clientX/clientY 就是帧内 CSS 像素（= 画布坐标）。
      这一层与 06-ui 里 pickAt / 框选桥接的约定完全一致，
      不要拿父页坐标来做换算，否则缩放一变就画歪。

   ② 预览层放在父页的 .overlay 里，**不写进帧文档**。
      帧文档里的每个节点都会被同步进工程文件、也会被撤销栈记录；
      把一根临时的预览线留在里面，撤销一次就会看到它「变实」。
      .overlay 本身就是画布坐标系、跟着 .stage 一起缩放，正好拿来预览。
      （它带 .overlay > * { pointer-events:auto }，所以预览 SVG 要显式关掉指针事件，
        否则整块画布都点不动。）
   ========================================================================== */
(function (global) {
  var WD = global.WD = global.WD || {};

  var SVG_NS = 'http://www.w3.org/2000/svg';
  /* 相邻采样点的最小间距（画布像素）：鼠标事件比手抖密得多，不抽稀的话
     一笔就能存下几百个点，工程文件与序列化都会明显变重。 */
  var MIN_STEP = 6;
  /* 一笔 / 一个多边形至少要有这么大的包围盒才值得落地，否则就是误点一下 */
  var MIN_BOX = 6;

  /* 闭合判定的容差（画布像素）：点回起点附近就算收口 */
  var CLOSE_SNAP = 18;

  /* 「双击 / 点回起点」闭合的冷却窗口（ms）：
     闭合发生在双击的**第一下**（点回起点→收口），但浏览器随后还会派发
     第二下 pointerdown 与一次 dblclick。若不管，第二下就会从**同一个起点**
     又开出一条新多边形（正是「闭合后从某一点继续绘图」那个 bug），
     dblclick 再把这个只有 1 点的残株判成「至少 3 顶点」弹错误提示。
     窗口取略大于系统双击间隔，足以吞掉同一次双击的余波，又不影响用户
     稍后重新起手画下一个多边形。 */
  var CLOSE_COOLDOWN = 350;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function DrawTool() {
    this.tool = null;
    this.pts = [];
    this.dragging = false;
    this.preview = null;
    this.svg = null;
    this.path = null;      /* 已落定的边（多边形折线 / 自由绘制笔迹） */
    this.band = null;      /* 橡皮筋：多边形「最后一个顶点 → 当前指针」的在途边 */
    this.dots = null;
    this.cursor = null;    /* 当前指针位置（画布坐标），多边形橡皮筋用 */
    this.firstDot = null;  /* 起点圆点引用，靠近时高亮「点这里闭合」 */
    this.last = null;
    this.closedAt = 0;     /* 上一次多边形成功闭合的时间戳，用于吞掉双击余波 */
    this.bound = null;
  }

  /* 桥（由 06-ui 在初始化时装上）：
       stage / doc / root / overlay —— 舞台访问
       create / hint / done        —— 落地元素与提示
     拿不到桥就什么都不做，绝不抛异常把整个应用带下去。 */
  DrawTool.prototype._b = function () { return WD.drawBridge || null; };

  DrawTool.prototype.active = function () { return !!this.tool; };

  /* ══ 进入 / 退出绘制态 ══════════════════════════════════════════════ */

  DrawTool.prototype.start = function (kind) {
    var b = this._b();
    if (!b) return false;
    if (!b.root || !b.root()) { if (b.hint) b.hint('请先打开一份 HTML 或新建页面', 'warn'); return false; }
    if (this.tool === kind) { this.stop(); return false; }   /* 再点一次 = 取消 */
    this.stop();
    this.tool = kind;
    this.closedAt = 0;
    this._bind();
    if (b.setCursor) b.setCursor('crosshair');
    if (b.hint) {
      b.hint(kind === 'drawn'
        ? '自由绘制：按住左键在画布上拖动画一笔（Esc 退出）'
        : '多边形：逐点单击定顶点，双击 / 回车 / 点回起点闭合（Esc 退出）', 'info', 4200);
    }
    return true;
  };

  DrawTool.prototype.stop = function () {
    var b = this._b();
    this.tool = null;
    this.dragging = false;
    this.pts = []; this.cursor = null; this.last = null;
    this._clearPreview();
    this._unbind();
    if (b && b.setCursor) b.setCursor('');
  };

  /* ══ 监听 ══════════════════════════════════════════════════════════ */

  DrawTool.prototype._bind = function () {
    if (this.bound) return;
    var self = this;
    var b = this._b();
    if (!b || !b.doc) return;
    var doc = b.doc();
    if (!doc) return;
    /* capture=true：抢在 onFramePointerDown（它会开始拖动元素）之前拿到事件，
       并在 handleDown 里 stopPropagation，避免画一笔顺手把底下的元素拖走。 */
    var down = function (e) { self.handleDown(e); };
    var move = function (e) { self.handleMove(e); };
    var up = function (e) { self.handleUp(e); };
    var dbl = function (e) { self.handleDblClick(e); };
    doc.addEventListener('pointerdown', down, true);
    doc.addEventListener('pointermove', move, true);
    doc.addEventListener('pointerup', up, true);
    doc.addEventListener('dblclick', dbl, true);
    global.addEventListener('keydown', this._onKey = function (e) {
      if (!self.tool) return;
      if (e.key === 'Escape') { self.stop(); if (b.hint) b.hint('已退出绘制', 'info', 1600); }
      else if (e.key === 'Enter' && self.tool === 'poly') { self.finish('enter'); }
    }, true);
    this.bound = { doc: doc, down: down, move: move, up: up, dbl: dbl };
  };

  DrawTool.prototype._unbind = function () {
    var b = this.bound;
    if (!b) return;
    try {
      b.doc.removeEventListener('pointerdown', b.down, true);
      b.doc.removeEventListener('pointermove', b.move, true);
      b.doc.removeEventListener('pointerup', b.up, true);
      b.doc.removeEventListener('dblclick', b.dbl, true);
    } catch (e) { /* 文档可能已经换掉了 */ }
    if (this._onKey) global.removeEventListener('keydown', this._onKey, true);
    this._onKey = null;
    this.bound = null;
  };

  /* ══ 指针 ══════════════════════════════════════════════════════════ */

  DrawTool.prototype.handleDown = function (e) {
    if (!this.tool || e.button !== 0) return;
    /* 编辑文字时不抢事件，否则在文本框里点一下都会开始画 */
    var b = this._b();
    if (b && b.isEditing && b.isEditing()) return;
    /* 刚闭合：吞掉同一次双击的第二下，避免从起点又开一条新多边形 */
    if (this.tool === 'poly' && Date.now() - this.closedAt < CLOSE_COOLDOWN) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.tool === 'drawn') {
      this.dragging = true;
      this.pts = [[e.clientX, e.clientY]];
      this.last = { x: e.clientX, y: e.clientY };
      this.cursor = [e.clientX, e.clientY];
      this._renderCommitted(false);
    } else {
      this.addCorner(e.clientX, e.clientY);
    }
  };

  DrawTool.prototype.handleMove = function (e) {
    if (!this.tool) return;
    if (this.tool === 'drawn') {
      if (!this.dragging) return;
      e.preventDefault();
      var dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      /* 抽稀：距离太近的点不记。1px 抖一下也存一个点，一笔能存几百个 */
      if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) return;
      this.last = { x: e.clientX, y: e.clientY };
      this.pts.push([e.clientX, e.clientY]);
      this.cursor = [e.clientX, e.clientY];
      this._renderCommitted(false);
    } else if (this.tool === 'poly') {
      /* 多边形：指针移动只更新「橡皮筋」那条在途边，不重画已落定的折线 */
      this.cursor = [e.clientX, e.clientY];
      this._renderBand();
    }
  };

  DrawTool.prototype.handleUp = function (e) {
    if (!this.tool || this.tool !== 'drawn' || !this.dragging) return;
    e.preventDefault();
    this.dragging = false;
    this.finish(e.clientX, e.clientY);
  };

  /* 双击闭合多边形。dblclick 在帧文档上也会触发 onFrameDblClick（进文字编辑），
     所以这里必须抢在它前面停掉 —— 否则「双击闭合」会顺手在底下的元素上进入编辑。 */
  DrawTool.prototype.handleDblClick = function (e) {
    if (!this.tool || this.tool !== 'poly') return;
    e.preventDefault();
    e.stopPropagation();
    /* 刚闭合：这次 dblclick 只是同一次双击的收尾，不能再 finish 那 1 点残株 */
    if (Date.now() - this.closedAt < CLOSE_COOLDOWN) return;
    this.finish('dblclick');
  };

  /* 多边形：加一个顶点。点回起点附近就收口。 */
  DrawTool.prototype.addCorner = function (x, y) {
    if (this.pts.length >= 3 && this._nearFirst(x, y)) { this.finish('close'); return; }
    this.pts.push([x, y]);
    this.cursor = [x, y];
    /* 新顶点落下：把这条边「画出来」（animate=true 触发描边动画），再挂橡皮筋 */
    this._renderCommitted(true);
    this._renderBand();
  };

  /* 指针 / 落点是否落在起点附近（收口容差内）。 */
  DrawTool.prototype._nearFirst = function (x, y) {
    if (!this.pts.length) return false;
    var f = this.pts[0], dx = x - f[0], dy = y - f[1];
    return dx * dx + dy * dy <= CLOSE_SNAP * CLOSE_SNAP;
  };

  /* 去掉**连续**的近似同点。双击闭合会把同一个坐标派发两次（两下 pointerdown
     各 push 一次），不清掉多边形末尾就会叠着两个重合顶点。阈值取约 1.2px，
     远小于自由绘制的抽稀间距（MIN_STEP=6）与正常手点，不会误删真实顶点。 */
  DrawTool.prototype._dedupe = function (pts) {
    if (!pts || pts.length < 2) return pts || [];
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i], q = out[out.length - 1];
      var dx = p[0] - q[0], dy = p[1] - q[1];
      if (dx * dx + dy * dy <= 1.5) continue;
      out.push(p);
    }
    return out;
  };

  /* ══ 收尾：比例化 → 交给 06-ui 落地 ═════════════════════════════════ */

  DrawTool.prototype.finish = function (why) {
    var b = this._b();
    var pts = this._dedupe(this.pts);
    this.pts = []; this.cursor = null; this.last = null; this.dragging = false;
    this._clearPreview();
    if (!b || !b.create) return;

    var kind = this.tool;
    var need = kind === 'poly' ? 3 : 2;
    if (!pts || pts.length < need) {
      /* 多边形点不够（只点了 1~2 下）：不报错，静默丢弃即可 —— 用户本来就可能改主意 */
      if (kind === 'poly' && why !== 'escape') b.hint('多边形至少要 3 个顶点', 'warn', 2000);
      return;
    }

    /* 包围盒 → 0~100 的比例点。存比例而不是绝对坐标，是为了让元素缩放 /
       换画布尺寸之后笔迹依然贴合自己的边框（见 07-elements 的 scaledPoints）。 */
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < minX) minX = pts[i][0];
      if (pts[i][1] < minY) minY = pts[i][1];
      if (pts[i][0] > maxX) maxX = pts[i][0];
      if (pts[i][1] > maxY) maxY = pts[i][1];
    }
    var bw = Math.max(MIN_BOX, maxX - minX);
    var bh = Math.max(MIN_BOX, maxY - minY);
    var norm = pts.map(function (p) {
      var x = clamp01((p[0] - minX) / bw) * 100;
      var y = clamp01((p[1] - minY) / bh) * 100;
      return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
    });

    b.create({
      kind: kind,
      points: norm,
      x: Math.round(minX),
      y: Math.round(minY),
      w: Math.round(bw),
      h: Math.round(bh),
    });
    /* 记下落定时刻：若这次闭合是「双击起点」触发的，紧随其后的第二下
       pointerdown / dblclick 会被 handleDown、handleDblClick 的冷却窗口吞掉，
       不会从同一个起点又开一条新多边形。 */
    if (kind === 'poly') this.closedAt = Date.now();
    if (b.hint) {
      b.hint(kind === 'drawn' ? '已添加笔迹' : '已添加多边形（' + norm.length + ' 个顶点）', 'ok', 1800);
    }
    /* 自由绘制保持激活：连着画几笔不用反复点菜单。
       多边形则画完一个就退出绘制态 —— 用户希望「下一个要再点一次」，
       避免闭合后随手一停又多冒出一个顶点。 */
    if (kind === 'poly') this.stop();
  };

  /* ══ 预览层 ═════════════════════════════════════════════════════════ */

  DrawTool.prototype._ensurePreview = function () {
    if (this.svg && this.svg.parentNode) return true;
    var b = this._b();
    var host = b && b.overlay ? b.overlay() : null;
    if (!host || !b.size) return false;
    var sz = b.size();
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'wd-draw-preview');
    svg.setAttribute('width', sz.w);
    svg.setAttribute('height', sz.h);
    svg.setAttribute('viewBox', '0 0 ' + sz.w + ' ' + sz.h);
    svg.style.pointerEvents = 'none';   /* .overlay > * 默认 auto，必须显式关掉 */
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'wd-draw-path');
    var band = document.createElementNS(SVG_NS, 'path');
    band.setAttribute('class', 'wd-draw-band');
    var dots = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(path);
    svg.appendChild(band);
    svg.appendChild(dots);
    host.appendChild(svg);
    this.svg = svg; this.path = path; this.band = band; this.dots = dots;
    return true;
  };

  /* ── 已落定的边 + 顶点 ──
     ★ 关键修复：以前这里读的是 this.px，而多边形只在 this.pts 上加点，
     px 从头到尾是空数组 —— 于是逐点点顶点时画布上「什么都不显示」，
     用户点了几下看不到任何折线与圆点，以为工具坏了。改成只认 this.pts。 */
  DrawTool.prototype._renderCommitted = function (animate) {
    if (!this._ensurePreview()) return;
    var pts = this.pts || [];
    var r = function (v) { return Math.round(v * 10) / 10; };
    if (!pts.length) { this.path.setAttribute('d', ''); this.dots.innerHTML = ''; this.firstDot = null; return; }

    var d = 'M' + r(pts[0][0]) + ',' + r(pts[0][1]);
    for (var i = 1; i < pts.length; i++) d += ' L' + r(pts[i][0]) + ',' + r(pts[i][1]);
    this.path.setAttribute('d', d);

    /* 多边形每落一个顶点，把这条边「画出来」：dashoffset 由全长 → 0，
       旧边随新边一起从头描一遍，视觉上就是线在一段段长出来。 */
    if (animate && this.tool === 'poly' && pts.length >= 2 && this.path.getTotalLength) {
      try {
        var L = this.path.getTotalLength();
        this.path.style.transition = 'none';
        this.path.style.strokeDasharray = L + ' ' + L;
        this.path.style.strokeDashoffset = String(L);
        void this.path.getBoundingClientRect();        /* 强制回流，动画才从头开始 */
        this.path.style.transition = 'stroke-dashoffset .24s cubic-bezier(.22,.61,.36,1)';
        this.path.style.strokeDashoffset = '0';
      } catch (e) { this.path.style.strokeDasharray = ''; this.path.style.strokeDashoffset = ''; }
    }

    /* 顶点圆点：起点画大一点（那是「点这里闭合」的目标），最新落点带个 pop */
    this.dots.innerHTML = '';
    this.firstDot = null;
    if (this.tool === 'poly') {
      for (var j = 0; j < pts.length; j++) {
        var c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', r(pts[j][0]));
        c.setAttribute('cy', r(pts[j][1]));
        c.setAttribute('r', j === 0 ? 6 : 3.5);
        c.setAttribute('class', j === 0 ? 'wd-draw-dot first'
          : (j === pts.length - 1 && animate ? 'wd-draw-dot pop' : 'wd-draw-dot'));
        this.dots.appendChild(c);
        if (j === 0) this.firstDot = c;
      }
    }
  };

  /* ── 橡皮筋：多边形「最后一个顶点 → 当前指针」的在途边 ──
     这条边带 marching-dash 动画，就是用户要的「线段的动画过程」：
     还没点下去之前，下一条款边跟着鼠标走，点下去才落地。 */
  DrawTool.prototype._renderBand = function () {
    if (!this._ensurePreview() || !this.band) return;
    var pts = this.pts || [];
    var r = function (v) { return Math.round(v * 10) / 10; };
    if (this.tool === 'poly' && pts.length >= 1 && this.cursor) {
      var last = pts[pts.length - 1];
      var closing = pts.length >= 3 && this._nearFirst(this.cursor[0], this.cursor[1]);
      var target = closing ? pts[0] : this.cursor;
      this.band.setAttribute('d', 'M' + r(last[0]) + ',' + r(last[1]) + ' L' + r(target[0]) + ',' + r(target[1]));
      this.band.classList.toggle('closing', closing);
      this._markFirstNear(closing);
    } else {
      this.band.setAttribute('d', '');
      this.band.classList.remove('closing');
      this._markFirstNear(false);
    }
  };

  DrawTool.prototype._markFirstNear = function (near) {
    if (this.firstDot) this.firstDot.classList.toggle('near', !!near);
  };

  DrawTool.prototype._clearPreview = function () {
    if (this.svg && this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
    this.svg = null; this.path = null; this.band = null; this.dots = null; this.firstDot = null;
  };

  WD.DrawTool = DrawTool;
  WD.drawTool = new DrawTool();

  /* 模块加载完就把常用入口挂上，便于自动化脚本断言绘制态 */
  WD.__drawReady = true;
})(typeof window !== 'undefined' ? window : globalThis);
