/* ============================================================================
   元素工厂：形状约束 · 线条 · 表格 · 公式（LaTeX）· 图表
   ----------------------------------------------------------------------------
   这里解决的核心问题：**元素形状必须知道自己能被怎样拉伸**。

   原来的 resize 路径是无差别的：手柄拖动和检查器宽高都直接写
   `style.width` / `style.height`，于是：
     · 圆形（border-radius:50% 的方盒子）拖一下角就变成了椭圆；
     · 线条（height 只有几像素的条）拖一下角就长成了二维色块。
   两者都不是「用户拖错了」，而是代码里根本没有「圆形不能拉扁」
   「线条只能改长度」这种概念。

   所以本模块给每种形状挂一条 constraint，resize / 检查器 / 复制 / 撤销
   全都按它算，而不是各写各的。
   ========================================================================== */
(function (global) {
  var WD = global.WD = global.WD || {};
  var E = WD.elements = WD.elements || {};

  /* ══════════════════════════════════════════════════════════════════════
     1. 形状约束
     ══════════════════════════════════════════════════════════════════════ */

  /* mode:
       free         宽高各自独立变（矩形、三角形、表格…）
       ratio        锁定宽高比，圆形 ratio = 1，任何拖法都还是圆

     ★ 线条类（line / arrow / dblarrow / curve / connector / connectorcurve）
     这里**故意不给约束** —— 它们已经改成「两点头模型」：
     几何由 data-wd-p1 / p2（/ bend）三个比例点描述，盒子就是这三点的包围盒。

     原来给它们挂 lock-h / lock-h-min 是为了「斜拖不把线拉成色块」，
     但那条约束同时把线**锁死成水平**，与「两点可以任意拖动」直接冲突。
     现在换成：8 个盒手柄全部隐藏（见 deadHandles），只留两个端点手柄，
     宽度 / 高度由拖端点**自己推出来** —— 既不会被拉成色块，
     又允许画任意角度的斜线。 */
  var CONSTRAINTS = {
    circle:   { mode: 'ratio' },
    /* 自由绘制与多边形是**等比**的：笔迹与顶点集都按原始包围盒存成比例值，
       宽高各自独立拉伸会把字迹压扁成另一幅画。锁比例之后「改大小」就是整体缩放。 */
    drawn:          { mode: 'ratio' },
    poly:           { mode: 'ratio' },
  };

  function kindOf(node) {
    return node && node.getAttribute ? node.getAttribute('data-wd-added') : null;
  }

  /* 取约束模式；未知类型返回 null（= 无约束，保持旧行为）。
     这里只负责「是什么形状」，具体比例由 applyConstraint 按 start 现场算。 */
  E.constraintOf = function (node) {
    var k = kindOf(node);
    if (!k) return null;
    return CONSTRAINTS[k] || null;
  };

  E.hasOwnLock = function (node) { return !!E.constraintOf(node); };

  /* ──────────────────────────────────────────────────────────────────────
     把一组缩放结果按约束修正。
     nx/ny/nw/nh 是「无约束」算出来的值，这里就地改写并返回是否动了位置。

     ★ 比例必须用**传进来的 start**算，不能就地再量一次元素：
     调用方通常在量完 start 之后才 pinElement（把它转成绝对定位），
     那一步会改变盒子。这两处各量各的，就会得到一个自相矛盾的比例 ——
     实测圆形改成 500 宽时高度变成 423：start 是方的，
       而 constraintOf 在 pinElement 之后量到的是被压扁过的盒子。
     ────────────────────────────────────────────────────────────────────── */
  E.applyConstraint = function (node, start, next, handle) {
    var c = E.constraintOf(node);
    if (!c) return;
    var wAxis = handle.indexOf('e') >= 0 || handle.indexOf('w') >= 0;
    var hAxis = handle.indexOf('n') >= 0 || handle.indexOf('s') >= 0;

    if (c.mode === 'ratio') {
      var r = (start.h > 0) ? start.w / start.h : 1;
      if (!isFinite(r) || r <= 0.05) r = 1;
      /* 主导轴决定尺寸：横向手柄以宽为准，纵向手柄以高为准。
         角手柄同时带两根轴，仍然只看横向 —— 这样圆形往右下拖是「变大」，
         往右上拖也是「变大」，不会出现拖到一半变成椭圆。 */
      if (wAxis) {
        next.h = Math.max(6, next.w / r);
      } else if (hAxis) {
        next.w = Math.max(6, next.h * r);
      }
      /* 尺寸跟着变，锚点那一侧要把位置补回去，否则元素会漂 */
      if (handle.indexOf('n') >= 0) next.y = start.y + (start.h - next.h);
      if (handle.indexOf('w') >= 0) next.x = start.x + (start.w - next.w);
      return;
    }

    if (c.mode === 'lock-h' || c.mode === 'lock-h-min') {
      next.h = start.h;
      if (handle.indexOf('n') >= 0) next.y = start.y;
      if (handle.indexOf('s') >= 0) next.y = start.y;
      return;
    }
  };

  /* 一维元素上，有哪些手柄是**没有意义**的（点了不会有反应）。
     覆盖层据此隐藏它们 —— 让用户看不到死按钮，比点了没反应好。

     线条类更彻底：8 个盒手柄 +「旋转」手柄**全部**隐藏，只留两个端点手柄。
     理由：两点头模型里，盒子只是三个点的包围盒，改盒子不是用户想做的事；
     他要把端点拖到哪儿去，直接拖那个点（见 06-ui 的 beginEndpointDrag）。
     旋转对角度的影响，和「把某个端点拖过去」是同一件事 —— 拖端点就是旋转，
     再挂一个旋转键只会让人以为线能被整条拧转，反而误导。
     留一排盒手柄 / 旋转键只会让人拖了发现「整条线跟着缩放」而不是「这一端动了」。 */
  var BOX_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  E.deadHandles = function (node) {
    var kind = kindOf(node);
    if (LINE_KINDS[kind]) return BOX_HANDLES.concat(['rot']);
    var c = E.constraintOf(node);
    if (!c) return null;
    if (c.mode === 'lock-h' || c.mode === 'lock-h-min') return ['n', 's', 'nw', 'ne', 'sw', 'se'];
    return null;
  };

  /* ══════════════════════════════════════════════════════════════════════
     2. 线条：直线 / 箭头 / 双箭头
     ──────────────────────────────────────────────────────────────────────
     一维元素靠 SVG 画，但箭头不能靠 clip-path —— 那种百分比会把箭头头部
     跟着宽度一起拉长。这里改成**固定像素的箭头 + 拉伸的杆**，
     每次尺寸或颜色变化都重画一次（refreshOverlay 每次都会调）。

     为什么不用 <svg> 的 marker：marker 定义在文档级 <defs> 里，
     而舞台文档是 iframe，每次重载文档都要重建，marker 引用容易指向旧文档。
     直接算 path 的坐标反而更省事，也不会跨文档失效。
     ══════════════════════════════════════════════════════════════════════ */

  var HEAD_W = 16;   /* 箭头宽（固定，不随长度变） */
  var HEAD_H = 8;    /* 箭头半高 */
  var SHAFT_T = 3;   /* 杆厚 */

  function sizeOf(node) {
    var w = parseFloat(node.style.width);
    var h = parseFloat(node.style.height);
    if (!(w > 0)) w = node.getBoundingClientRect().width || 400;
    if (!(h > 0)) h = node.getBoundingClientRect().height || 6;
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }

  function fillOf(node) {
    var c = '';
    try {
      var view = node.ownerDocument && node.ownerDocument.defaultView;
      c = view ? view.getComputedStyle(node).backgroundColor : '';
    } catch (e) { c = ''; }
    if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') c = '#3b6fd4';
    return c;
  }

  var NS = 'http://www.w3.org/2000/svg';

  /* ── 两点头模型：线条 / 曲线 / 连接线 ──────────────────────────────
     参考实现（Bento slides）把这类图形统一建模成 shape:"path"：
     一个 SVG `d` 描述几何 + `pathBox` 描述它的包围盒。
     这里用**同一思路**，但几何不存 `d`、存「两个端点 + 可选拐点」，
     点一律是盒子内的 0~100 比例：

       data-wd-p1   = "[x,y]"   起点
       data-wd-p2   = "[x,y]"   终点
       data-wd-bend = "[x,y]"   拐点（曲线 / 连接线才有）

     为什么用比例点而不是 `d`：
       · 缩放时**不用重算坐标** —— 比例点跟着盒子自动缩放（自由绘制 / 多边形
         用的也是这套，见 scaledPoints）；
       · 「两点」正好是用户要拖的东西，命中测试与拖动都只需要读写两个点；
       · 盒子 = 这三个点的包围盒，于是斜线天然成立 —— 原来 height 被锁死、
         只能画水平线，正是「两点」这个模型缺位的表现。

     ★ 顺带修掉一个真 bug：旧的 curve / connector 默认 `d` 是按 ~100×100 的
     坐标空间写的（'M0,78 C34,10 66,10 100,78'），却配上了元素真实尺寸的
     viewBox（620×150）—— 于是曲线只画在盒子左侧 16% 的地方。换成比例点之后
     几何与盒子从一开始就是同一套坐标，这个错位不会再发生。 */
  var LINE_KINDS = {
    line: 1, arrow: 1, dblarrow: 1, curve: 1, connector: 1, connectorcurve: 1
  };

  /* 曲线族升级为三次贝塞尔：用两端各一条**切线手柄**（c1 / c2）代替旧的单一拐点。
     · c1 挂在起点 p1 上、c2 挂在终点 p2 上；拖切线手柄 = 改该端的切线方向与长度（弯曲程度），
       拖端点 = 改大小 / 位置。连接线（connector，肘形）不属于这一族，仍用 bend。 */
  var CURVE_KINDS = { curve: 1, connectorcurve: 1 };

  /* 默认两点（0~100 比例）。line / arrow / dblarrow 是水平线；
     曲线起止贴底、拐点贴顶（一段上凸的弧）；连接线起止对角、拐点做肘。 */
  var POINT_DEFAULTS = {
    line:           { p1: [0, 50], p2: [100, 50], bend: null },
    arrow:          { p1: [0, 50], p2: [100, 50], bend: null },
    dblarrow:       { p1: [0, 50], p2: [100, 50], bend: null },
    /* 曲线：起止贴底、拐点贴顶（一段上凸的弧）。c1/c2 由旧拐点 bend 等价派生：
       二次→三次 = c1 = p1 + 2/3(bend-p1)，c2 = p2 + 2/3(bend-p2)。 */
    curve:          { p1: [0, 92], p2: [100, 92], bend: [50, 6], c1: [33.33, 34.67], c2: [66.67, 34.67] },
    connector:      { p1: [0, 90], p2: [100, 10], bend: [50, 90] },
    connectorcurve: { p1: [0, 90], p2: [100, 10], bend: [50, 50], c1: [33.33, 63.33], c2: [66.67, 36.67] },
  };

  function parsePt(raw, fallback) {
    if (raw) {
      try {
        var a = JSON.parse(raw);
        if (Array.isArray(a) && a.length >= 2 && isFinite(a[0]) && isFinite(a[1])) {
          return [Number(a[0]), Number(a[1])];
        }
      } catch (e) { /* 坏数据就退回默认，不抛 */ }
    }
    return fallback ? [fallback[0], fallback[1]] : null;
  }

  E.isLineKind = function (kind) { return !!LINE_KINDS[kind]; };

  /* 曲线族 = 需要展示 / 拖动两条切线手柄（c1 / c2）的线条类。 */
  E.isCurveKind = function (kind) { return !!CURVE_KINDS[kind]; };

  /* 多边形顶点集（0~100 比例），把每个点归一成 [x,y]。无 / 坏数据回退空数组。
     覆盖层据此为每个顶点摆一个可拖手柄；拖顶点走 beginVertexDrag。 */
  E.verticesOf = function (node) {
    var raw = node && node.getAttribute ? node.getAttribute('data-wd-points') : null;
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.map(function (p) {
        var x = Array.isArray(p) ? p[0] : (p && p.x);
        var y = Array.isArray(p) ? p[1] : (p && p.y);
        return [isFinite(x) ? x : 0, isFinite(y) ? y : 0];
      });
    } catch (e) { return []; }
  };

  function roundPt(p) { return [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]; }

  /* 读一个线条元素的点集（0~100 比例）。返回 null 表示不是线条类。
     曲线族额外带一对切线手柄 c1 / c2（三次贝塞尔的两个控制点）。 */
  E.linePointsOf = function (node) {
    var kind = kindOf(node);
    var def = POINT_DEFAULTS[kind];
    if (!def) return null;
    var lp = {
      p1: parsePt(node.getAttribute('data-wd-p1'), def.p1),
      p2: parsePt(node.getAttribute('data-wd-p2'), def.p2),
      bend: def.bend ? parsePt(node.getAttribute('data-wd-bend'), def.bend) : null,
      c1: null,
      c2: null,
    };
    if (CURVE_KINDS[kind]) {
      var c1raw = node.getAttribute('data-wd-c1');
      var c2raw = node.getAttribute('data-wd-c2');
      if (c1raw && c2raw) {
        lp.c1 = parsePt(c1raw, def.c1);
        lp.c2 = parsePt(c2raw, def.c2);
      } else {
        /* 迁移：旧曲线只有一个拐点 bend（等价于二次贝塞尔控制点）。
           把它换算成三次贝塞尔的两个控制点 —— 形状完全一致，只是换成
           两端各一条可独立拖动的切线手柄。落一次盘，之后 c1/c2 就是真源。 */
        var b = lp.bend || [def.c1 ? def.c1[0] : 50, def.c1 ? def.c1[1] : 30];
        var d1 = [lp.p1[0] + (b[0] - lp.p1[0]) * 2 / 3, lp.p1[1] + (b[1] - lp.p1[1]) * 2 / 3];
        var d2 = [lp.p2[0] + (b[0] - lp.p2[0]) * 2 / 3, lp.p2[1] + (b[1] - lp.p2[1]) * 2 / 3];
        lp.c1 = roundPt(d1);
        lp.c2 = roundPt(d2);
        node.setAttribute('data-wd-c1', JSON.stringify(lp.c1));
        node.setAttribute('data-wd-c2', JSON.stringify(lp.c2));
      }
    }
    return lp;
  };

  /* 比例点 → 当前盒子里的绝对坐标 */
  function absPoints(node, w, h) {
    var lp = E.linePointsOf(node);
    if (!lp) return null;
    var toAbs = function (p) { return [(p[0] / 100) * w, (p[1] / 100) * h]; };
    return {
      p1: toAbs(lp.p1),
      p2: toAbs(lp.p2),
      bend: lp.bend ? toAbs(lp.bend) : null,
      c1: lp.c1 ? toAbs(lp.c1) : null,
      c2: lp.c2 ? toAbs(lp.c2) : null,
    };
  }

  /* 纯描边的形状（曲线、连接线、笔迹、多边形）：填充透明、只画 stroke。
     直线 / 箭头 / 双箭头不在此列 —— 它们是**填充**的杆 + 固定像素箭头头。 */
  var STROKE_KINDS = { curve: 1, connector: 1, connectorcurve: 1, drawn: 1, poly: 1 };

  function strokeW(node) {
    var raw = node.style.borderTopWidth || node.style.borderWidth || '';
    var v = parseFloat(raw);
    if (!(v > 0)) v = 3;
    return Math.max(1, Math.min(40, v));
  }

  function pointsOf(node) {
    var raw = node.getAttribute('data-wd-points');
    if (!raw) return [];
    try {
      var a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  /* 比例点 → 绝对坐标串。
     自由绘制与多边形都按**原始包围盒**存 0~100 的比例点，
     这里再乘回当前宽高，所以缩放 / 拉伸都不会让笔画错位。 */
  function scaledPoints(node) {
    var sz = sizeOf(node);
    var n = function (v) { return Math.round(v * 100) / 100; };
    return pointsOf(node).map(function (p) {
      var x = Array.isArray(p) ? p[0] : p.x;
      var y = Array.isArray(p) ? p[1] : p.y;
      x = isFinite(x) ? x : 0;
      y = isFinite(y) ? y : 0;
      return { x: (x / 100) * sz.w, y: (y / 100) * sz.h };
    });
  }

  /* 笔迹用二次贝塞尔把相邻点连成平滑曲线（取相邻两点的中点作为曲线终点，
     原始点作为控制点）—— 直接 lineTo 在鼠标采样稀疏时会画出折线感。 */
  function drawnPath(node) {
    var ps = scaledPoints(node);
    if (ps.length < 2) return '';
    var n = function (v) { return Math.round(v * 100) / 100; };
    var d = 'M' + n(ps[0].x) + ',' + n(ps[0].y);
    for (var i = 1; i < ps.length - 1; i++) {
      var mx = (ps[i].x + ps[i + 1].x) / 2;
      var my = (ps[i].y + ps[i + 1].y) / 2;
      d += ' Q' + n(ps[i].x) + ',' + n(ps[i].y) + ' ' + n(mx) + ',' + n(my);
    }
    d += ' L' + n(ps[ps.length - 1].x) + ',' + n(ps[ps.length - 1].y);
    return d;
  }

  function polyPath(node) {
    var ps = scaledPoints(node);
    if (ps.length < 3) return '';
    var n = function (v) { return Math.round(v * 100) / 100; };
    var d = 'M' + n(ps[0].x) + ',' + n(ps[0].y);
    for (var i = 1; i < ps.length; i++) d += ' L' + n(ps[i].x) + ',' + n(ps[i].y);
    return d + ' Z';
  }

  /* 直线 / 箭头的填充路径（杆 + 固定像素箭头头），沿 p1→p2 方向摆。
     箭头头是**固定像素**的，不会随长度一起拉长 —— 长箭头的头不该变成大三角。
     整个图形在 p1→p2 的局部坐标系里算（u = 沿线单位向量，n = 法线），
     所以斜线也能正确摆头。
     thick 是杆厚，由 data-wd-w 传进来（检查器里改「边框宽度」就是它）。 */
  function arrowPathAlong(a, b, hasStart, hasEnd, thick) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    var n = function (v) { return Math.round(v * 100) / 100; };
    if (len < 1.5) {
      /* 退化成一点：给一个极小的方块，别画出畸形箭头 */
      return 'M' + n(a[0] - 1) + ',' + n(a[1] - 1) + ' L' + n(a[0] + 1) + ',' + n(a[1] - 1)
        + ' L' + n(a[0] + 1) + ',' + n(a[1] + 1) + ' L' + n(a[0] - 1) + ',' + n(a[1] + 1) + ' Z';
    }
    var ux = dx / len, uy = dy / len;
    var nx = -uy, ny = ux;
    var t = Math.min(thick || SHAFT_T, Math.max(1, len / 3));
    var hw = Math.min(HEAD_W, Math.max(4, len / 2.5));   /* 箭头沿线的长度 */
    var hh = Math.min(HEAD_H, Math.max(2, len / 4));     /* 箭头半高 */
    var h = Math.max(0.5, t / 2);
    /* 局部 (沿, 法) → 绝对坐标串 */
    var pt = function (along, side) {
      return n(a[0] + ux * along + nx * side) + ',' + n(a[1] + uy * along + ny * side);
    };
    var parts = [];
    var s0 = hasStart ? hw * 0.92 : 0;
    var s1 = hasEnd ? len - hw * 0.92 : len;
    /* 杆 */
    parts.push('M' + pt(s0, -h) + ' L' + pt(s1, -h) + ' L' + pt(s1, h) + ' L' + pt(s0, h) + ' Z');
    /* 终点箭头 */
    if (hasEnd) parts.push('M' + pt(len, 0) + ' L' + pt(len - hw, -hh) + ' L' + pt(len - hw, hh) + ' Z');
    /* 起点箭头（朝后） */
    if (hasStart) parts.push('M' + pt(0, 0) + ' L' + pt(hw, -hh) + ' L' + pt(hw, hh) + ' Z');
    return parts.join(' ');
  }

  /* 直线：一条有厚度的杆。p1/p2 是中心线的两端，
     杆由中心线向两侧各偏 t/2 得到 —— 斜线时就是一个旋转过的矩形。 */
  function barPathAlong(a, b, thickness) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    var n = function (v) { return Math.round(v * 100) / 100; };
    var t = Math.max(1, thickness);
    if (len < 0.5) return 'M' + n(a[0]) + ',' + n(a[1]) + ' L' + n(a[0]) + ',' + n(a[1] + t) + ' Z';
    var ux = dx / len, uy = dy / len;
    var nx = -uy, ny = ux;
    var h = t / 2;
    var pt = function (along, side) {
      return n(a[0] + ux * along + nx * side) + ',' + n(a[1] + uy * along + ny * side);
    };
    return 'M' + pt(0, -h) + ' L' + pt(len, -h) + ' L' + pt(len, h) + ' L' + pt(0, h) + ' Z';
  }

  /* 两点（+拐点）图形的路径。thick = 杆厚 / 线宽（来自 data-wd-w）。 */
  function pointPath(node, kind, w, h, thick) {
    var ap = absPoints(node, w, h);
    if (!ap) return '';
    var n = function (v) { return Math.round(v * 100) / 100; };
    var p1 = ap.p1, p2 = ap.p2, bend = ap.bend, c1 = ap.c1, c2 = ap.c2;
    var t = thick || SHAFT_T;

    if (kind === 'line') {
      /* 直线用「杆」而不是 stroke：保持填充语义，
         这样 PPTX 导出 / 栅格化仍然把它当纯色块处理。 */
      var len0 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      return barPathAlong(p1, p2, Math.min(t, Math.max(1, len0 / 3)));
    }
    if (kind === 'arrow') return arrowPathAlong(p1, p2, false, true, t);
    if (kind === 'dblarrow') return arrowPathAlong(p1, p2, true, true, t);

    if (kind === 'curve' || kind === 'connectorcurve') {
      /* 三次贝塞尔：两端各一条切线手柄 c1 / c2 决定弯曲程度与方向，
         端点 p1 / p2 决定大小与位置。缺 c1/c2（异常数据）时从 bend 派生兜底。 */
      if (!c1 || !c2) {
        var cb = bend || [(p1[0] + p2[0]) / 2, Math.min(p1[1], p2[1])];
        c1 = [p1[0] + (cb[0] - p1[0]) * 2 / 3, p1[1] + (cb[1] - p1[1]) * 2 / 3];
        c2 = [p2[0] + (cb[0] - p2[0]) * 2 / 3, p2[1] + (cb[1] - p2[1]) * 2 / 3];
      }
      return 'M' + n(p1[0]) + ',' + n(p1[1])
        + ' C' + n(c1[0]) + ',' + n(c1[1])
        + ' ' + n(c2[0]) + ',' + n(c2[1])
        + ' ' + n(p2[0]) + ',' + n(p2[1]);
    }
    if (kind === 'connector') {
      /* 肘形：先横到拐点的 x，再竖到拐点的 y，最后横到终点。
         拐点只取 x 作「竖段在哪」，y 由两端决定 —— 这样拖动两端时
         肘形仍然是对齐的直角，不会歪成斜线。 */
      var bx = bend ? bend[0] : (p1[0] + p2[0]) / 2;
      return 'M' + n(p1[0]) + ',' + n(p1[1])
        + ' L' + n(bx) + ',' + n(p1[1])
        + ' L' + n(bx) + ',' + n(p2[1])
        + ' L' + n(p2[0]) + ',' + n(p2[1]);
    }
    return 'M' + n(p1[0]) + ',' + n(p1[1]) + ' L' + n(p2[0]) + ',' + n(p2[1]);
  }

  /* 路径生成表。
     ⚠ 签名统一是 (node, w, h)：线条类要读元素上的比例点、drawn / poly 也是，
     只给宽高不够。这里曾经把 node 参数省掉写成 function (w, h)，于是
     syncLine 传进去的尺寸被当成 node 用，一插自由绘制就抛
     「Cannot read properties of undefined (reading 'width')」。 */
  var PATH_FOR = {
    drawn: function (node) { return drawnPath(node); },
    poly: function (node) { return polyPath(node); },
  };
  ['line', 'arrow', 'dblarrow', 'curve', 'connector', 'connectorcurve'].forEach(function (k) {
    PATH_FOR[k] = function (node, w, h) {
      return pointPath(node, k, w, h, parseFloat(node.getAttribute('data-wd-w')) || SHAFT_T);
    };
  });

  /* 线条类的「颜色 / 粗细」存在 data-* 上，不放在 CSS 盒子上。
     原因：线条的盒子必须保持透明（图形是里面那个 SVG 画的），
     而 SVG 的 fill / stroke-width 又要跟着颜色与粗细走。
     早期实现是「读 backgroundColor 当颜色、读 borderTopWidth 当粗细」，
     但 syncLine 结尾要把盒子刷成透明 —— 那一步会把用户刚选的颜色一起抹掉，
     于是**改完颜色只要再重画一次就弹回默认蓝**（实测第二次 syncLine 就回退）。
     现在：data-wd-stroke / data-wd-w 是唯一真源，CSS 盒子只负责透明。
     旧工程没有这两个属性，syncLine 会把 CSS 上的值**迁移**过来一次。 */
  function paintOf(node) {
    var stroke = node.getAttribute('data-wd-stroke');
    if (!stroke) {
      /* 迁移：旧文档把颜色写在 background-color 上 */
      var legacy = fillOf(node);
      stroke = legacy;
      node.setAttribute('data-wd-stroke', stroke);
    }
    var w = parseFloat(node.getAttribute('data-wd-w'));
    if (!(w > 0)) {
      w = strokeW(node);          /* 迁移：旧文档把粗细写在 border-top-width 上 */
      node.setAttribute('data-wd-w', String(w));
    }
    return { stroke: stroke, width: w };
  }

  /* 按当前尺寸和颜色重画这个线条 / 形状元素。返回 true 表示确实重画了。
     两类渲染：
       · 填充类（line / arrow / dblarrow）：路径被 fill 填充，d 里已经夹出杆厚；
       · 描边类（curve / connector / connectorcurve / drawn / poly）：
         路径是一条中心线，用 stroke + stroke-width 画，填充透明。 */
  E.syncLine = function (node) {
    var kind = kindOf(node);
    if (!PATH_FOR[kind]) return false;
    var sz = sizeOf(node);
    var paint = paintOf(node);
    var doc = node.ownerDocument;
    var strokeMode = !!STROKE_KINDS[kind];
    var d = PATH_FOR[kind](node, sz.w, sz.h);

    var svg = node.querySelector(':scope > svg');
    if (!svg) {
      /* 直线原来靠「自身背景色 = 那根杆」画，不需要 svg。
         换成两点头模型之后它可能是**斜的**，色块画不出斜杆 ——
         所以和箭头一样改用 SVG 路径（一个旋转过的矩形）。 */
      svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'wd-line-svg');
      var p = doc.createElementNS(NS, 'path');
      svg.appendChild(p);
      node.appendChild(svg);
    }
    /* ★ 内层 SVG 的定位/裁剪必须**写成内联样式**，不能靠 style.css 里的
       `[data-wd-added="line"] > svg { position:absolute; overflow:visible }`。
       舞台是 iframe：插入的元素活在**帧文档**里，而应用样式表挂在父页上，
       那条规则根本匹配不到帧内的节点（getComputedStyle 实测是
       position:static / display:inline / overflow:hidden）。
       后果：inline 的 SVG 会按基线排版、被下推十几像素，再被元素盒子或
       foreignObject 的高度裁掉 —— 8px 高的「直线」因此栅格化成全透明
       （实测覆盖率 0%；同一个 SVG 单独渲染有 25%）。
       所以这类元素的样式一律自带，和 addElement 里那套内联写法是同一个约定。 */
    var ss = svg.style;
    ss.position = 'absolute';
    ss.left = '0';
    ss.top = '0';
    ss.overflow = 'visible';
    ss.pointerEvents = 'none';
    ss.display = 'block';
    var path = svg.firstChild;
    svg.setAttribute('viewBox', '0 0 ' + sz.w + ' ' + sz.h);
    svg.setAttribute('width', sz.w);
    svg.setAttribute('height', sz.h);
    path.setAttribute('d', d);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (strokeMode) {
      /* 描边类图形：颜色走 stroke。其中 curve / connector / connectorcurve /
         drawn 是**开放**线条，内部无「面」可填 → fill 恒为 none。
         而 poly（多边形）是**闭合**图形，用户希望能填底色：填充色存在专属的
         data-wd-fill 上（未设 = 不填充，回退 none），描边仍用 paint.stroke。
         盒子背景保持透明（见下方），填充画在内层 path 上，两者不冲突。 */
      var fillVal = 'none';
      if (kind === 'poly') fillVal = node.getAttribute('data-wd-fill') || 'none';
      path.setAttribute('fill', fillVal);
      path.setAttribute('stroke', paint.stroke);
      path.setAttribute('stroke-width', paint.width);
    } else {
      path.setAttribute('fill', paint.stroke);
      path.setAttribute('stroke', 'none');
    }
    /* 盒子只负责定位：背景透明、边框透明。
       边框宽度留着透明边框是为了让旧的 strokeW 迁移仍有值可读；
       颜色/粗细的真源已经是 data-wd-stroke / data-wd-w。 */
    node.style.background = 'transparent';
    node.style.borderColor = 'transparent';
    return true;
  };

  /* ══════════════════════════════════════════════════════════════════════
     3. 表格
     ══════════════════════════════════════════════════════════════════════ */

  var TBL_BORDER = '#c8d3e0';
  var TBL_HEAD_BG = '#eef3fa';

  E.buildTable = function (doc, rows, cols, opt) {
    opt = opt || {};
    rows = Math.max(1, Math.min(40, rows | 0 || 3));
    cols = Math.max(1, Math.min(20, cols | 0 || 3));
    var t = doc.createElement('table');
    var st = t.style;
    st.position = 'absolute';
    st.borderCollapse = 'collapse';
    st.tableLayout = 'fixed';
    /* 关键：单元格默认是 content-box。td 上写死 width/height 时，
       padding 与折叠边框会**额外**累加上去，整张表被内容顶得比声明的宽还大
       （实测 5 列 200px → 实际 1106px，检查器里写 620 也纹丝不动）。
       统一 border-box 之后，表格的 width/height 才是唯一说了算的那个。 */
    st.boxSizing = 'border-box';
    st.background = '#ffffff';
    t.setAttribute('data-wd-added', 'table');
    t.setAttribute('data-wd-rows', String(rows));
    t.setAttribute('data-wd-cols', String(cols));
    var w = opt.w || 1000;
    st.width = w + 'px';
    var rh = opt.rowH || 56;
    st.height = (rh * rows) + 'px';

    for (var r = 0; r < rows; r++) {
      var tr = doc.createElement('tr');
      tr.style.height = rh + 'px';
      for (var c = 0; c < cols; c++) {
        var td = doc.createElement('td');
        var ts = td.style;
        /* 宽度/高度一律不写死：table-layout:fixed 下由表格盒子等分，
           写死单元格尺寸会和表格尺寸各算各的（这正是上面那个坑）。 */
        ts.boxSizing = 'border-box';
        ts.border = '1px solid ' + TBL_BORDER;
        ts.padding = '6px 10px';
        ts.verticalAlign = 'middle';
        ts.font = '400 20px/1.35 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
        ts.color = '#1e2a3a';
        ts.background = r === 0 ? TBL_HEAD_BG : 'transparent';
        ts.fontWeight = r === 0 ? '700' : '400';
        ts.overflow = 'hidden';
        td.textContent = r === 0 ? '表头 ' + (c + 1) : '';
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    return t;
  };

  E.tableSize = function (node) {
    return {
      rows: (node.getAttribute('data-wd-rows') | 0) || node.rows.length,
      cols: (node.getAttribute('data-wd-cols') | 0) || (node.rows[0] ? node.rows[0].cells.length : 0),
    };
  };

  /* 增删行列。表格是**唯一**必须改结构而不只是改样式的元素，
     所以走 rebuild：重画一遍再把已有文字搬回去。 */
  E.resizeTable = function (doc, node, rows, cols) {
    var keep = [];
    for (var r = 0; r < node.rows.length; r++) {
      var line = [];
      for (var c = 0; c < node.rows[r].cells.length; c++) line.push(node.rows[r].cells[c].innerHTML);
      keep.push(line);
    }
    var oldW = parseFloat(node.style.width) || 1000;
    var fresh = E.buildTable(doc, rows, cols, { w: oldW });
    /* 搬回原有内容 */
    for (var r2 = 0; r2 < fresh.rows.length; r2++) {
      for (var c2 = 0; c2 < fresh.rows[r2].cells.length; c2++) {
        if (keep[r2] && keep[r2][c2] != null && keep[r2][c2] !== '') {
          fresh.rows[r2].cells[c2].innerHTML = keep[r2][c2];
        }
      }
    }
    return fresh;
  };

  /* ══════════════════════════════════════════════════════════════════════
     4. LaTeX → MathML
     ──────────────────────────────────────────────────────────────────────
     单文件离线，没法引 KaTeX；但 Chrome 109+ 原生支持 MathML Core，
     所以自带一个**够用**的 LaTeX 子集解析器，直接吐 MathML。

     覆盖：分数 / 上下标 / 根号 / 希腊字母 / 常用符号与关系符 /
           函数名（sin cos log …）/ \text / \hat \bar \vec / 括号分组。
     不覆盖：矩阵环境、多行对齐、\begin{array}、自定义宏 —— 遇到未知命令
           一律按原样输出成文字，不会吞掉也不会报错。
     ══════════════════════════════════════════════════════════════════════ */

  var SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', varrho: 'ϱ',
    sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ',
    chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '⋅', ast: '∗', star: '⋆',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
    equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
    infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
    sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', sqrt: '√',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
    prime: '′', angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
    larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', mapsto: '↦',
    quad: ' ', qquad: '  ', thinspace: ' ',
  };

  /* 需要上下标模式的「大算符」：求和号的上标放右上、下标放右下 */
  var BIG_OPS = { sum: 1, prod: 1, int: 1, iint: 1, oint: 1, lim: 1 };

  var FUNCS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'deg'];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── 词法 ───────────────────────────────────────────────────────────── */
  function tokenize(src) {
    var toks = [], i = 0;
    var src2 = String(src).replace(/\\left|\\right/g, '');   /* 括号尺寸交给 MathML 自己 */
    while (i < src2.length) {
      var c = src2[i];
      if (c === '\\') {
        var m = /^\\([A-Za-z]+|.)/.exec(src2.slice(i));
        if (!m) { i++; continue; }
        toks.push({ t: 'cmd', v: m[1] });
        i += m[0].length;
        continue;
      }
      /* {…} 整段吞成一个 token 并保留原文。
         不这么做有两个后果：\text{当 } 里的空格会被当成空白吃掉；
         而嵌套花括号要在解析器里做深度计数，很容易在未闭合时死循环。 */
      if (c === '{') {
        var depth = 1, j = i + 1;
        while (j < src2.length && depth > 0) {
          if (src2[j] === '\\') { j += 2; continue; }
          if (src2[j] === '{') depth++;
          else if (src2[j] === '}') depth--;
          j++;
        }
        var body = src2.slice(i + 1, depth === 0 ? j - 1 : src2.length);
        toks.push({ t: 'grp', raw: body });
        i = depth === 0 ? j : src2.length;
        continue;
      }
      if (/\s/.test(c)) { toks.push({ t: 'sp' }); i++; continue; }
      if (/[0-9]/.test(c)) {
        var num = /^[0-9]+(\.[0-9]+)?/.exec(src2.slice(i))[0];
        toks.push({ t: 'num', v: num }); i += num.length; continue;
      }
      if (/[A-Za-z]/.test(c)) {
        /* 连续的字母：sin / lim 之类整体当函数名 */
        var k = i;
        while (k < src2.length && /[A-Za-z]/.test(src2[k])) k++;
        var word = src2.slice(i, k);
        toks.push({ t: 'word', v: word }); i = k; continue;
      }
      toks.push({ t: 'ch', v: c });
      i++;
    }
    return toks;
  }

  /* ── 语法：expr := (atom (sup|sub)*)* ; atom := {…} | cmd | word | ch | num ── */
  function Parser(toks) { this.t = toks; this.i = 0; }
  Parser.prototype.peek = function (k) { return this.t[this.i + (k || 0)] || null; };
  Parser.prototype.next = function () { return this.t[this.i++] || null; };

  Parser.prototype.readGroup = function () {
    /* 读到配对的 } 为止（不消费右括号，交给调用方） */
    var out = [];
    while (this.i < this.t.length) {
      var tk = this.peek();
      if (tk.t === 'ch' && tk.v === '}') return out;
      out.push(this.parseAtomWithScripts());
    }
    return out;
  };

  /* 把一段源码解析成 row 节点（分组花括号 / \text{} 都走这里） */
  function subRow(raw) {
    var p = new Parser(tokenize(raw));
    var row = { t: 'row', c: [] };
    while (p.i < p.t.length) {
      var a = p.parseAtomWithScripts();
      if (a) row.c.push(a);
    }
    return row;
  }

  Parser.prototype.parseAtomWithScripts = function () {
    var base = this.parseAtom();
    if (!base) return base;
    for (;;) {
      var tk = this.peek();
      if (!tk) break;
      if (tk.t === 'ch' && tk.v === '^') { this.next(); base = this.wrapScript(base, 'sup'); }
      else if (tk.t === 'ch' && tk.v === '_') { this.next(); base = this.wrapScript(base, 'sub'); }
      else break;
    }
    return base;
  };

  Parser.prototype.wrapScript = function (base, kind) {
    var arg = this.parseScriptArg();
    /* 键名必须是 t —— toMathML 是按 n.t 分派的。
       这里原先写成 { m: kind }，于是 msup / msub 全都掉进 default 返回空串：
       表面上「公式渲染出来了」，实际上下标、上下限被整段吞掉。 */
    return { t: kind, b: [base, arg] };
  };

  /* ^x / ^2 / ^{…} / ^-1 */
  Parser.prototype.parseScriptArg = function () {
    var tk = this.peek();
    if (!tk) return { t: 'mtext', v: '' };
    if (tk.t === 'grp') { this.next(); return subRow(tk.raw); }
    var a = this.parseAtom();
    if (!a) return { t: 'mtext', v: '' };
    /* 负号：x^{-1} 的 -1 应当整体做上标，不拆成两个节点 */
    if (a.t === 'mo' && a.v === '-' || (a.t === 'mtext' && a.v === '-')) {
      var rest = this.parseScriptArg();
      return { t: 'row', c: [a, rest] };
    }
    return a;
  };

  Parser.prototype.parseAtom = function () {
    var tk = this.next();
    if (!tk) return null;
    if (tk.t === 'sp') return null;
    if (tk.t === 'grp') return subRow(tk.raw);
    if (tk.t === 'num') return { t: 'mn', v: tk.v };
    if (tk.t === 'word') {
      if (FUNCS.indexOf(tk.v.toLowerCase()) >= 0) return { t: 'mtext', v: tk.v, fn: 1 };
      return { t: 'mi', v: tk.v };
    }
    if (tk.t === 'ch') {
      if ('+-*/=<>,;:!|()[]'.indexOf(tk.v) >= 0) return { t: 'mo', v: tk.v };
      return { t: 'mi', v: tk.v };
    }
    /* 命令 */
    var name = tk.v;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      var num = this.parseScriptArg(), den = this.parseScriptArg();
      return { t: 'mfrac', c: [num, den] };
    }
    if (name === 'sqrt') {
      /* n 次根：必须**先**看 [n]，再取被开方数。
         反过来的话 parseScriptArg() 会把 [ 当成 \sqrt 的参数吃掉，
         结果输出 <msqrt><mo>[</mo></msqrt>… 括号孤零零挂在那儿。 */
      var nth = null;
      if (this.peek() && this.peek().t === 'ch' && this.peek().v === '[') {
        this.next();
        var idx = [], guard = 0;
        while (this.i < this.t.length && guard++ < 400) {
          var t2 = this.peek();
          if (!t2) break;
          if (t2.t === 'ch' && t2.v === ']') { this.next(); break; }
          idx.push(this.parseAtomWithScripts());
        }
        nth = { t: 'row', c: idx };
      }
      var a2 = this.parseScriptArg();
      if (nth) return { t: 'mroot', c: [a2, nth] };
      return { t: 'msqrt', c: [a2] };
    }
    if (name === 'text' || name === 'mathrm' || name === 'mathbf' || name === 'mathit' ||
        name === 'textbf' || name === 'textit' || name === 'operatorname') {
      var variant = 'normal';
      if (name === 'mathbf') variant = 'bold';
      else if (name === 'mathit' || name === 'textit') variant = 'italic';
      else if (name === 'textbf') variant = 'bold-italic';
      /* \text{…} 要**原样保留空格**：中文说明文字常写成「当 x > 0」这种带空格的形式，
         走一遍公式解析会把空格当空白吃掉，字面量就变成了「当x>0」。 */
      var g = this.peek();
      if (g && g.t === 'grp') { this.next(); return { t: 'mtext', v: g.raw, variant: variant }; }
      var g2 = this.parseScriptArg();
      return { t: 'mtext', v: stripTags(g2), variant: variant };
    }
    if (name === 'hat' || name === 'bar' || name === 'vec' || name === 'tilde' || name === 'dot') {
      var b2 = this.parseScriptArg();
      return { t: 'accent', accent: name, c: [b2] };
    }
    if (name === 'overline' || name === 'underline') {
      var b3 = this.parseScriptArg();
      return { t: name === 'overline' ? 'mover' : 'munder', c: [b3, { t: 'mo', v: '‾' }] };
    }
    if (name === 'left' || name === 'right') return null;   /* 已在上游剥掉 */
    /* 函数名：\sin 和裸写的 sin 在数学上是一回事，都排成正体（upright）。
       注意 \sin 到这里是一个 cmd 而不是 word —— 上面那个 word 分支只管裸字母。 */
    if (FUNCS.indexOf(name.toLowerCase()) >= 0) return { t: 'mtext', v: name, fn: 1 };
    if (SYMBOLS[name]) {
      if (BIG_OPS[name]) return { t: 'bigop', v: SYMBOLS[name], name: name };
      return { t: 'mo', v: SYMBOLS[name] };
    }
    /* 未知命令：按原样输出，至少不丢人 */
    return { t: 'mtext', v: name };
  };

  function stripTags(n) {
    if (!n) return '';
    if (n.t === 'mtext' || n.t === 'mi' || n.t === 'mn') return n.v;
    if (n.t === 'row') return n.c.map(stripTags).join('');
    if (n.c) return n.c.map(stripTags).join('');
    return '';
  }

  /* 节点 → MathML 字符串。buildChildren=true 表示只输出参数部分（不带包裹标签） */
  function toMathML(n) {
    if (!n) return '';
    switch (n.t) {
      case 'row': return n.c.map(toMathML).join('');
      case 'mn': return '<mn>' + esc(n.v) + '</mn>';
      case 'mi': return '<mi>' + esc(n.v) + '</mi>';
      case 'mo': return '<mo>' + esc(n.v) + '</mo>';
      case 'mtext':
        if (n.fn) return '<mi mathvariant="normal">' + esc(n.v) + '</mi>';
        if (n.variant && n.variant !== 'normal') {
          return '<mi mathvariant="' + n.variant + '">' + esc(n.v) + '</mi>';
        }
        return '<mtext>' + esc(n.v) + '</mtext>';
      case 'mfrac': return '<mfrac>' + toMathML(n.c[0]) + toMathML(n.c[1]) + '</mfrac>';
      case 'msqrt': return '<msqrt>' + toMathML(n.c[0]) + '</msqrt>';
      case 'mroot': return '<mroot>' + toMathML(n.c[0]) + toMathML(n.c[1]) + '</mroot>';
      case 'sup': return '<msup>' + toMathML(n.b[0]) + toMathML(n.b[1]) + '</msup>';
      case 'sub': return '<msub>' + toMathML(n.b[0]) + toMathML(n.b[1]) + '</msub>';
      case 'accent': {
        var ch = { hat: '^', bar: '‾', vec: '→', tilde: '~', dot: '˙' }[n.accent] || '^';
        return '<mover>' + toMathML(n.c[0]) + '<mo>' + esc(ch) + '</mo></mover>';
      }
      case 'bigop': return '<mo largeop="true" movablelimits="true">' + esc(n.v) + '</mo>';
      default: return '';
    }
  }

  /* LaTeX 源码 → MathML 字符串。解析不了也返回可显示的东西，绝不抛异常。 */
  E.latexToMathML = function (src) {
    var s = String(src == null ? '' : src).trim();
    var wrap = function (inner) {
      return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' +
        '<mstyle displaystyle="true">' + inner + '</mstyle></math>';
    };
    if (!s) return wrap('');
    try {
      var p = new Parser(tokenize(s));
      var row = { t: 'row', c: [] };
      while (p.i < p.t.length) {
        var a = p.parseAtomWithScripts();
        if (a) row.c.push(a);
      }
      var body = toMathML(row);
      if (!body) return wrap(esc(s));
      return wrap(body);
    } catch (e) {
      /* 解析不了就把原文当字面量显示：宁可丑，也不要一片空白或者整个界面卡住。 */
      return '<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext>' + esc(s) + '</mtext></math>';
    }
  };

  /* LaTeX 源码里有没有任何可解析成分（用来判断要不要提示用户） */
  E.latexLooksReal = function (src) {
    return /\\[A-Za-z]+|[_^]|[=+\-]/.test(String(src || ''));
  };

  /* ══════════════════════════════════════════════════════════════════════
     5. 图表
     ──────────────────────────────────────────────────────────────────────
     画在 canvas 上再导出 PNG 当 <img> 插入，而不是塞 SVG：
       · 缩略图 / PPTX 导出 / 放映都只需要一张图，不用各自再实现一遍矢量导出；
       · canvas 在任何缩放下渲染都锐利，不会有 SVG 缩放锯齿。
     数据是内置示例，插入后可当普通图片一样改位置、改大小。
     ══════════════════════════════════════════════════════════════════════ */

  var CHART_PALETTE = ['#3b6fd4', '#f7a600', '#3fa37a', '#d9534f', '#8a63d2', '#4aa3c7'];
  var CHART_FONT = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

  /* 右栏「配色」那一排色板直接用这套颜色 —— 图上用的与实际可选的是同一份定义，
     不另抄一遍，避免以后改配色只改了一处。 */
  E.chartPalette = function () { return CHART_PALETTE.slice(); };

  /* 图表**背景色**：默认无（透明）。透明是有意选的默认值 ——
     课件底板常常是深色或带渐变，烤成白底会变成一张贴上去的白纸。 */
  var CHART_BG = ['#ffffff', '#f7f9fc', '#eef3fa', '#fff8e6', '#f0f7f2', '#fdecea', '#1e2a3a'];

  E.chartBackgrounds = function () { return CHART_BG.slice(); };

  /* 内置示例数据。每张图表插进画布时都**带着自己的数据副本**
     （存在 data-wd-chart 属性里），双击就能改 —— 否则它只是一张烤死的 PNG。 */
  E.defaultChartData = function (kind) {
    if (kind === 'pie') {
      return {
        kind: 'pie', title: '成绩构成', showLegend: true, showValues: true, bgColor: '',
        labels: ['优秀', '良好', '及格', '待提高'],
        series: [{ name: '占比', color: '#3b6fd4', fillColor: '#3b6fd4', data: [32, 38, 19, 11] }],
      };
    }
    return {
      kind: kind === 'chartline' ? 'chartline' : 'bar',
      title: kind === 'chartline' ? '月度趋势' : '各月对比',
      showLegend: true, showValues: false, bgColor: '',
      labels: ['一月', '二月', '三月', '四月', '五月', '六月'],
      series: [
        { name: '本班', color: '#3b6fd4', fillColor: '#3b6fd4', data: [62, 78, 71, 86, 93, 88] },
        { name: '年级均', color: '#f7a600', fillColor: '#f7a600', data: [55, 61, 64, 70, 74, 79] },
      ],
    };
  };

  /* 把用户填回来的数据收拾干净：分类与各系列对齐、数值转数字、颜色补齐。
     对话框是逗号分隔的自由输入，没有这一步画布上就是一堆 NaN。 */
  E.normalizeChartData = function (raw, kind) {
    var base = E.defaultChartData(kind);
    raw = raw || {};
    var labels = Array.isArray(raw.labels) ? raw.labels : base.labels;
    labels = labels.map(function (s) { return String(s == null ? '' : s); })
                   .filter(function (s) { return s !== ''; });
    if (!labels.length) labels = base.labels.slice();

    var src = Array.isArray(raw.series) && raw.series.length ? raw.series : base.series;
    if (kind === 'pie') src = src.slice(0, 1);

    var series = src.map(function (s, i) {
      s = s || {};
      var vals = (Array.isArray(s.data) ? s.data : []).map(function (v) {
        var n = parseFloat(v);
        return isFinite(n) ? n : 0;
      });
      /* 补齐 / 截断到分类数，避免柱子数与横轴标签数对不上 */
      while (vals.length < labels.length) vals.push(0);
      vals = vals.slice(0, labels.length);
      var c = s.color || CHART_PALETTE[i % CHART_PALETTE.length];
      return {
        name: String(s.name == null || s.name === '' ? base.series[i % base.series.length].name : s.name),
        color: c,
        /* fillColor：柱体填充 / 饼图扇区。默认等于 stroke 色 —— 新插入的图
           跟旧行为一致；想分开调就在右栏改。 */
        fillColor: /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\([\d\s.,%]+\))$/i.test(String(s.fillColor || ''))
          ? String(s.fillColor) : c,
        data: vals,
      };
    });
    if (!series.length) series = base.series.slice();

    /* 逐系列的画法（柱状 / 折线）。同一张图里可以混用：
       「总量用柱、趋势用线」是常见诉求，一个全局开关做不到。
       饼图忽略这个字段（只有一条数据）。 */
    var srcKind = Array.isArray(raw.seriesKind) ? raw.seriesKind : [];
    var seriesKind = series.map(function (s, i) {
      /* 老数据 / 默认数据里没有 seriesKind —— 那就按 kind 推：整张图是折线就是折线 */
      var k = srcKind[i];
      if (k === 'chartline' || k === 'bar') return k;
      return kind === 'chartline' ? 'chartline' : 'bar';
    });
    /* 整个图表的 kind：全是折线才算折线图，其余按柱/线混合画 */
    var allLine = seriesKind.length > 0 && seriesKind.every(function (k) { return k === 'chartline'; });
    var outKind = kind === 'pie' ? 'pie' : (allLine ? 'chartline' : 'bar');

    return {
      kind: outKind, title: String(raw.title == null ? base.title : raw.title),
      /* 背景色默认空串 = 透明。非空才画底色。
         只认 #rgb/#rrggbb 与 rgb()/rgba()，别的一律当透明 —— 这个值会直接进
         canvas.fillStyle，也让 data-wd-chart 更干净。 */
      bgColor: /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\([\d\s.,%]+\))$/i.test(String(raw.bgColor || ''))
        ? String(raw.bgColor) : '',
      showLegend: raw.showLegend !== false,
      showValues: !!raw.showValues,
      labels: labels, series: series, seriesKind: seriesKind,
    };
  };

  /* 数据里的最大值抬到一个好看的刻度（12 → 15，93 → 100） */
  function niceMax(v) {
    if (!(v > 0)) return 10;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * mag >= v) return steps[i] * mag;
    }
    return 10 * mag;
  }

  function nice(v) { return Math.round(v * 100) / 100; }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* 标题槽与图例槽是**固定**的：有标题就画字，没标题就留白，但绘图区的位置不动。
     否则「加个标题 / 关掉图例」会让整张图往下挪一截 —— 用户改个文字，图形却跳了半屏。 */
  var CHART_HEAD = 56;
  var CHART_LEGEND = 44;

  function drawTitle(ctx, title, w) {
    if (!title) return;
    ctx.font = '700 26px ' + CHART_FONT;
    ctx.fillStyle = '#16202e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, w / 2, CHART_HEAD / 2 + 1);
  }

  function drawLegend(ctx, items, x, y) {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    items.forEach(function (it) {
      ctx.fillStyle = it.color;
      roundRect(ctx, x, y - 6, 15, 15, 3);
      ctx.fill();
      ctx.fillStyle = '#4a5a70';
      ctx.font = '16px ' + CHART_FONT;
      ctx.fillText(it.name, x + 23, y + 2);
      x += 23 + ctx.measureText(it.name).width + 30;
    });
    return x;
  }

  function legendWidth(ctx, items) {
    var probe = ctx;
    probe.font = '16px ' + CHART_FONT;
    return items.reduce(function (acc, it) { return acc + 23 + probe.measureText(it.name).width + 30; }, 0);
  }

  function drawAxis(ctx, x, y, w, h, maxV) {
    ctx.save();
    ctx.strokeStyle = '#d8e0ea';
    ctx.fillStyle = '#7c8ba1';
    ctx.lineWidth = 1;
    ctx.font = '15px ' + CHART_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var v = maxV * i / steps;
      var yy = nice(y + h - (h * i / steps));
      ctx.beginPath();
      ctx.moveTo(x, yy + .5);
      ctx.lineTo(x + w, yy + .5);
      ctx.stroke();
      ctx.fillText(String(Math.round(v * 10) / 10), x - 9, yy);
    }
    ctx.restore();
  }

  E.drawChart = function (kind, canvas, data) {
    var d = E.normalizeChartData(data, kind);
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    /* 背景色：只在用户选了颜色时才铺底。
       默认透明 —— 导出的 PNG 带 alpha，贴在深色课件底板上不会出现一块白纸。 */
    if (d.bgColor) {
      ctx.fillStyle = d.bgColor;
      ctx.fillRect(0, 0, w, h);
    }

    var series = d.series;
    drawTitle(ctx, d.title, w);

    /* ── 饼图 ───────────────────────────────────────────── */
    if (kind === 'pie') {
      var vals = series[0].data.slice(0, d.labels.length);
      /* 扇区颜色：按用户给的首色（fillColor 优先，色板对齐失败时回退到 color）开始轮转。 */
      var pStart = series[0].fillColor || series[0].color;
      var pIdx = CHART_PALETTE.indexOf(pStart);
      if (pIdx < 0) pIdx = 0;
      var sliceColor = function (i) { return CHART_PALETTE[(pIdx + i) % CHART_PALETTE.length]; };
      var total = vals.reduce(function (a, b) { return a + b; }, 0) || 1;
      var areaTop = CHART_HEAD, areaH = h - CHART_HEAD - CHART_LEGEND;
      var cx = w * 0.34, cy = areaTop + areaH / 2;
      var r = Math.min(w * 0.26, areaH * 0.42);
      var a0 = -Math.PI / 2;
      ctx.font = '17px ' + CHART_FONT;
      vals.forEach(function (v, i) {
        var a1 = a0 + (v / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, a0, a1);
        ctx.closePath();
        ctx.fillStyle = sliceColor(i);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        a0 = a1;
      });
      /* 图例：名称 + 数值 + 百分比，这是「图表有文字」最直接的一处 */
      if (d.showLegend) {
        var items = d.labels.map(function (lb, i) {
          return {
            color: sliceColor(i),
            name: lb,
            right: '  ' + vals[i],
            tail: Math.round(vals[i] / total * 100) + '%',
          };
        });
        var lw = legendWidth(ctx, items) - 30;
        var lx = Math.min(cx + r + 44, w - lw - 16);
        var lh = items.length * 34;
        items.forEach(function (it, i) {
          var yy = cy - lh / 2 + i * 34 + 12;
          ctx.fillStyle = it.color;
          roundRect(ctx, lx, yy - 7, 15, 15, 3);
          ctx.fill();
          ctx.fillStyle = '#1e2a3a';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.font = '17px ' + CHART_FONT;
          ctx.fillText(it.name + it.right, lx + 23, yy);
          if (d.showValues) {
            ctx.fillStyle = '#6b7a90';
            ctx.font = '15px ' + CHART_FONT;
            ctx.fillText(it.tail, lx + 23 + ctx.measureText(it.name + it.right).width + 46, yy);
          }
        });
      }
      return;
    }

    /* ── 柱状图 / 折线图 ──
       逐系列判断画法：一个系列可以是柱、另一个是线。
       两种画法共用同一个格心 x（`pad.l + pw*(i+.5)/n`），所以混着画也严丝合缝；
       折线数据点落在格心而不是两端，与横轴标签永远对齐。 */
    var pad = { l: 60, r: 24, t: CHART_HEAD + 14, b: 46 + CHART_LEGEND };
    var pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    var maxV = niceMax(Math.max.apply(null, series.reduce(function (a, s) { return a.concat(s.data); }, [0])));

    drawAxis(ctx, pad.l, pad.t, pw, ph, maxV);

    var n = d.labels.length;
    ctx.font = '16px ' + CHART_FONT;
    ctx.fillStyle = '#5a6b83';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    d.labels.forEach(function (lb, i) {
      var cx = pad.l + pw * (i + .5) / n;
      ctx.fillText(lb, cx, pad.t + ph + 10);
    });

    var kindAt = function (si) {
      return (d.seriesKind && d.seriesKind[si]) === 'chartline' ? 'chartline' : 'bar';
    };
    /* 柱宽按**柱系列**的条数算：线系列不占横向位置。
       否则「一根柱 + 一根线」时柱只占半格，看着像没对齐。 */
    var barCount = 0;
    series.forEach(function (s, si) { if (kindAt(si) === 'bar') barCount++; });
    if (!barCount) barCount = 1;
    var slot = pw / n;
    var bw = Math.min(34, slot / (barCount + 1));
    var barSeen = 0;

    series.forEach(function (s, si) {
        /* ── 折线系列 ── */
        if (kindAt(si) === 'chartline') {
          var lstep = pw / n;
          var lx0 = pad.l + lstep * .5;
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 3;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          s.data.forEach(function (v, i) {
            var cx = lx0 + lstep * i, cy = pad.t + ph - ph * v / maxV;
            if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
          });
          ctx.stroke();
          s.data.forEach(function (v, i) {
            var cx = lx0 + lstep * i, cy = pad.t + ph - ph * v / maxV;
            ctx.beginPath();
            ctx.arc(cx, cy, 5, 0, Math.PI * 2);
            ctx.fillStyle = s.color;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
            if (d.showValues) {
              ctx.fillStyle = '#3c4a5e';
              ctx.font = '600 15px ' + CHART_FONT;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ctx.fillText(String(v), cx, cy - 9);
            }
          });
          return;
        }

        /* ── 柱状系列 ──
           横向位置由「第几根柱」决定，不看系列下标 —— 线系列不占横向位置。
           fillColor = 柱体填充，color = 描边（线/值标签）。分得开时能让
           「深色描边 + 浅色填充」这种配色。 */
        var off = (barSeen - (barCount - 1) / 2) * (bw + 5);
        barSeen++;
        s.data.forEach(function (v, i) {
          /* 每根柱都显式设色：值标签会把 fillStyle 改成深色，不在这里重置
             就会「第一根对、后面全变深色」——正是勾选「显示数值」后的现象。 */
          ctx.fillStyle = s.fillColor || s.color;
          var bh = Math.max(1, ph * v / maxV);
          var cx = pad.l + slot * (i + .5) + off - bw / 2;
          roundRect(ctx, cx, pad.t + ph - bh, bw, bh, Math.min(5, bw / 2));
          ctx.fill();
          if (d.showValues) {
            ctx.fillStyle = '#3c4a5e';
            ctx.font = '600 15px ' + CHART_FONT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(v), cx + bw / 2, pad.t + ph - bh - 5);
          }
        });
    });

    if (d.showLegend) {
      drawLegend(ctx, series.map(function (s) { return { color: s.color, name: s.name }; }),
                 Math.max(pad.l, (w - (legendWidth(ctx, series) - 30)) / 2), h - CHART_LEGEND / 2);
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
