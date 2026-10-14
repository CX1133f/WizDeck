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
       free   宽高各自独立变（矩形、三角形、表格…）
       ratio  锁定宽高比，圆形 ratio = 1，任何拖法都还是圆
       lock-h 高度锁死，只能改长度（直线 / 箭头 / 双箭头）        */
  var CONSTRAINTS = {
    circle:   { mode: 'ratio' },
    line:     { mode: 'lock-h', lock: 'h' },
    arrow:    { mode: 'lock-h', lock: 'h' },
    dblarrow: { mode: 'lock-h', lock: 'h' },
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

    if (c.mode === 'lock-h') {
      /* 高度锁死：n/s 手柄在这个元素上完全无效，也不产生位移 */
      next.h = start.h;
      if (handle.indexOf('n') >= 0) next.y = start.y;
      if (handle.indexOf('s') >= 0) next.y = start.y;
      return;
    }
  };

  /* 一维元素上，有哪些手柄是**没有意义**的（点了不会有反应）。
     覆盖层据此隐藏它们 —— 让用户看不到死按钮，比点了没反应好。 */
  E.deadHandles = function (node) {
    var c = E.constraintOf(node);
    if (!c) return null;
    if (c.mode === 'lock-h') return ['n', 's', 'nw', 'ne', 'sw', 'se'];
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

  function pathFor(kind, w, h) {
    var cy = h / 2;
    var t = Math.min(SHAFT_T, Math.max(1, h / 3));
    var hh = Math.min(HEAD_H, Math.max(2, h / 2 - 1));
    var hw = Math.min(HEAD_W, Math.max(4, w / 2.5));
    var n = function (v) { return Math.round(v * 100) / 100; };
    var d;
    if (kind === 'arrow') {
      d = 'M0,' + n(cy - t / 2) +
        'L' + n(w - hw) + ',' + n(cy - t / 2) +
        'L' + n(w - hw) + ',' + n(cy - hh) +
        'L' + n(w) + ',' + n(cy) +
        'L' + n(w - hw) + ',' + n(cy + hh) +
        'L' + n(w - hw) + ',' + n(cy + t / 2) +
        'L0,' + n(cy + t / 2) + 'Z';
    } else if (kind === 'dblarrow') {
      d = 'M' + n(hw) + ',' + n(cy - t / 2) +
        'L' + n(w - hw) + ',' + n(cy - t / 2) +
        'L' + n(w - hw) + ',' + n(cy - hh) +
        'L' + n(w) + ',' + n(cy) +
        'L' + n(w - hw) + ',' + n(cy + hh) +
        'L' + n(w - hw) + ',' + n(cy + t / 2) +
        'L' + n(hw) + ',' + n(cy + t / 2) +
        'L' + n(hw) + ',' + n(cy + hh) +
        'L0,' + n(cy) +
        'L' + n(hw) + ',' + n(cy - hh) + 'Z';
    } else {
      /* 直线：一条横杆 */
      d = 'M0,' + n(cy - t / 2) + 'L' + n(w) + ',' + n(cy - t / 2) +
        'L' + n(w) + ',' + n(cy + t / 2) + 'L0,' + n(cy + t / 2) + 'Z';
    }
    return d;
  }

  /* 按当前尺寸和颜色重画这个线条元素。返回 true 表示确实重画了。 */
  E.syncLine = function (node) {
    var kind = kindOf(node);
    if (kind !== 'line' && kind !== 'arrow' && kind !== 'dblarrow') return false;
    var sz = sizeOf(node);
    var fill = fillOf(node);
    var doc = node.ownerDocument;
    var d = pathFor(kind, sz.w, sz.h);
    var svg = node.querySelector(':scope > svg');
    if (!svg) {
      /* 直线不需要 svg：自身背景就是杆。但箭头 / 双箭头需要 */
      if (kind === 'line') {
        node.style.background = fill;
        return true;
      }
      svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'wd-line-svg');
      var p = doc.createElementNS(NS, 'path');
      svg.appendChild(p);
      node.appendChild(svg);
    }
    var path = svg.firstChild;
    svg.setAttribute('viewBox', '0 0 ' + sz.w + ' ' + sz.h);
    svg.setAttribute('width', sz.w);
    svg.setAttribute('height', sz.h);
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    node.style.background = 'transparent';
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

  /* 内置示例数据。每张图表插进画布时都**带着自己的数据副本**
     （存在 data-wd-chart 属性里），双击就能改 —— 否则它只是一张烤死的 PNG。 */
  E.defaultChartData = function (kind) {
    if (kind === 'pie') {
      return {
        kind: 'pie', title: '成绩构成', showLegend: true, showValues: true,
        labels: ['优秀', '良好', '及格', '待提高'],
        series: [{ name: '占比', color: '#3b6fd4', data: [32, 38, 19, 11] }],
      };
    }
    return {
      kind: kind === 'chartline' ? 'chartline' : 'bar',
      title: kind === 'chartline' ? '月度趋势' : '各月对比',
      showLegend: true, showValues: false,
      labels: ['一月', '二月', '三月', '四月', '五月', '六月'],
      series: [
        { name: '本班', color: '#3b6fd4', data: [62, 78, 71, 86, 93, 88] },
        { name: '年级均', color: '#f7a600', data: [55, 61, 64, 70, 74, 79] },
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
      return {
        name: String(s.name == null || s.name === '' ? base.series[i % base.series.length].name : s.name),
        color: s.color || CHART_PALETTE[i % CHART_PALETTE.length],
        data: vals,
      };
    });
    if (!series.length) series = base.series.slice();

    return {
      kind: kind, title: String(raw.title == null ? base.title : raw.title),
      showLegend: raw.showLegend !== false,
      showValues: !!raw.showValues,
      labels: labels, series: series,
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
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var series = d.series;
    drawTitle(ctx, d.title, w);

    /* ── 饼图 ───────────────────────────────────────────── */
    if (kind === 'pie') {
      var vals = series[0].data.slice(0, d.labels.length);
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
        ctx.fillStyle = CHART_PALETTE[i % CHART_PALETTE.length];
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
            color: CHART_PALETTE[i % CHART_PALETTE.length],
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

    /* ── 柱状图 / 折线图 ──────────────────────────────────── */
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

    if (kind === 'bar') {
      var slot = pw / n;
      var bw = Math.min(34, slot / (series.length + 1));
      series.forEach(function (s, si) {
        ctx.fillStyle = s.color;
        s.data.forEach(function (v, i) {
          var bh = Math.max(1, ph * v / maxV);
          var cx = pad.l + slot * (i + .5) + (si - (series.length - 1) / 2) * (bw + 5) - bw / 2;
          roundRect(ctx, cx, pad.t + ph - bh, bw, bh, Math.min(5, bw / 2));
          ctx.fill();
          if (d.showValues) {
            ctx.fillStyle = '#3c4a5e';
            ctx.font = '600 15px ' + CHART_FONT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(v), cx + bw / 2, pad.t + ph - bh - 5);
            ctx.fillStyle = s.color;
          }
        });
      });
    } else {
      var step = n > 1 ? pw / (n - 1) : 0;
      series.forEach(function (s) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        s.data.forEach(function (v, i) {
          var cx = pad.l + step * i, cy = pad.t + ph - ph * v / maxV;
          if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        });
        ctx.stroke();
        s.data.forEach(function (v, i) {
          var cx = pad.l + step * i, cy = pad.t + ph - ph * v / maxV;
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
      });
    }

    if (d.showLegend) {
      drawLegend(ctx, series.map(function (s) { return { color: s.color, name: s.name }; }),
                 Math.max(pad.l, (w - (legendWidth(ctx, series) - 30)) / 2), h - CHART_LEGEND / 2);
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
