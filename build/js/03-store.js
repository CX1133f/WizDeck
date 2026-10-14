/* ============================================================================
   智演引擎 / WizDeck — 文档模型与撤销历史
   ========================================================================== */
(function (global) {
  'use strict';

  var WD = global.WD = global.WD || {};
  var U = WD.util;

  function Store() {
    this.model = null;
    this.current = 0;
    this.history = [];
    this.hIndex = -1;
    this.dirty = false;
    this.listeners = Object.create(null);
    this.batchDepth = 0;
    this.pendingSnapshot = false;
    this.fileName = '';
    this.zoom = 0;           /* 0 = 自动适应 */
    this.theme = 'light';
  }

  /* ── 事件 ────────────────────────────────────────────────────────────── */

  Store.prototype.on = function (evt, fn) {
    (this.listeners[evt] || (this.listeners[evt] = [])).push(fn);
    return this;
  };

  Store.prototype.emit = function (evt, payload) {
    var list = this.listeners[evt];
    if (list) {
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload, this); } catch (e) { console.error('[wizdeck] listener error', evt, e); }
      }
    }
    var any = this.listeners['*'];
    if (any) {
      for (var j = 0; j < any.length; j++) {
        try { any[j](evt, payload, this); } catch (e2) { console.error('[wizdeck] listener error', e2); }
      }
    }
  };

  /* ── 快照 / 历史 ─────────────────────────────────────────────────────── */

  Store.prototype.snapshot = function () {
    if (!this.model) return null;
    return {
      title: this.model.title,
      style: this.model.style,
      current: this.current,
      slides: this.model.slides.map(function (s) {
        return {
          id: s.id, name: s.name, title: s.title, layout: s.layout,
          notes: s.notes || '', doc: s.doc
        };
      })
    };
  };

  Store.prototype.pushHistory = function (label) {
    if (!this.model) return;
    var snap = this.snapshot();
    /* 与上一帧完全一致就不重复入栈 */
    var prev = this.history[this.hIndex];
    if (prev && JSON.stringify(prev.slides) === JSON.stringify(snap.slides) &&
        prev.title === snap.title && prev.style === snap.style) {
      return;
    }
    this.history = this.history.slice(0, this.hIndex + 1);
    snap.label = label || '编辑';
    this.history.push(snap);
    if (this.history.length > U.HISTORY_LIMIT) this.history.shift();
    this.hIndex = this.history.length - 1;
    this.emit('history');
  };

  /* 提交一次可撤销的修改：先入栈“修改前”的状态 */
  Store.prototype.commit = function (label) {
    this.pushHistory(label);
    this.setDirty(true);
    this.emit('change', label);
  };

  Store.prototype.applySnapshot = function (snap) {
    if (!snap) return;
    this.model.title = snap.title;
    this.model.style = snap.style;
    this.model.slides = snap.slides.map(function (s) {
      return {
        id: s.id, name: s.name, title: s.title, layout: s.layout,
        notes: s.notes || '', doc: s.doc
      };
    });
    this.current = U.clamp(snap.current, 0, Math.max(0, this.model.slides.length - 1));
  };

  Store.prototype.undo = function () {
    if (this.hIndex <= 0) return false;
    /* 记录当前状态，便于 redo */
    this.hIndex--;
    this.applySnapshot(this.history[this.hIndex]);
    this.setDirty(true);
    this.emit('change', 'undo');
    this.emit('history');
    this.emit('slide', this.current);
    return true;
  };

  Store.prototype.redo = function () {
    if (this.hIndex >= this.history.length - 1) return false;
    this.hIndex++;
    this.applySnapshot(this.history[this.hIndex]);
    this.setDirty(true);
    this.emit('change', 'redo');
    this.emit('history');
    this.emit('slide', this.current);
    return true;
  };

  Store.prototype.canUndo = function () { return this.hIndex > 0; };
  Store.prototype.canRedo = function () { return this.hIndex < this.history.length - 1; };
  Store.prototype.undoLabel = function () {
    var s = this.history[this.hIndex];
    return s ? s.label : '';
  };

  Store.prototype.setDirty = function (v) {
    var changed = this.dirty !== !!v;
    this.dirty = !!v;
    if (changed) this.emit('dirty', this.dirty);
  };

  /* ── 文档生命周期 ────────────────────────────────────────────────────── */

  Store.prototype.load = function (model, fileName) {
    this.model = {
      title: model.title || '未命名演示',
      style: model.style || '',
      createdAt: model.createdAt || new Date().toISOString(),
      slides: (model.slides || []).map(function (s) {
        return {
          id: s.id || U.uid('slide'),
          name: s.name || '未命名页',
          title: s.title || s.name || '未命名页',
          layout: s.layout || 'blank',
          notes: s.notes || '',
          doc: s.doc
        };
      })
    };
    this.current = 0;
    this.history = [];
    this.hIndex = -1;
    this.fileName = fileName || '';
    this.setDirty(false);
    this.pushHistory('载入文档');
    this.emit('loaded');
    this.emit('change', 'load');
    this.emit('slide', 0);
    this.emit('history');
  };

  Store.prototype.slide = function () {
    if (!this.model || !this.model.slides.length) return null;
    return this.model.slides[this.current] || null;
  };

  Store.prototype.slideAt = function (i) {
    if (!this.model) return null;
    return this.model.slides[i] || null;
  };

  Store.prototype.count = function () { return this.model ? this.model.slides.length : 0; };

  Store.prototype.goto = function (i) {
    if (!this.model) return;
    var n = this.model.slides.length;
    if (!n) return;
    var next = U.clamp(i, 0, n - 1);
    if (next === this.current) return;
    this.current = next;
    this.emit('slide', next);
  };

  /* ── 页面操作 ────────────────────────────────────────────────────────── */

  Store.prototype.insertSlide = function (index, slide) {
    if (!this.model) return null;
    var n = this.model.slides.length;
    var at = U.clamp(index === undefined ? this.current + 1 : index, 0, n);
    this.model.slides.splice(at, 0, slide);
    this.current = at;
    this.renumber();
    this.commit('新建页');
    this.emit('slide', at);
    return slide;
  };

  Store.prototype.addBlankSlide = function (layout, index) {
    if (!this.model) return null;
    var slide = {
      id: U.uid('slide'),
      name: '新页面',
      title: '新页面',
      layout: layout || 'blank',
      notes: '',
      doc: WD.parse.blankSlideDoc(this.model.style, { layout: layout || 'blank' })
    };
    return this.insertSlide(index, slide);
  };

  Store.prototype.duplicateSlide = function (index) {
    if (!this.model) return null;
    var i = index === undefined ? this.current : index;
    var src = this.model.slides[i];
    if (!src) return null;
    var copy = {
      id: U.uid('slide'),
      name: src.name + ' 副本',
      title: src.title,
      layout: src.layout,
      notes: src.notes,
      doc: src.doc
    };
    return this.insertSlide(i + 1, copy);
  };

  Store.prototype.deleteSlide = function (index) {
    if (!this.model) return false;
    if (this.model.slides.length <= 1) return false;
    var i = index === undefined ? this.current : index;
    if (i < 0 || i >= this.model.slides.length) return false;
    this.model.slides.splice(i, 1);
    this.current = U.clamp(this.current, 0, this.model.slides.length - 1);
    this.renumber();
    this.commit('删除页');
    this.emit('slide', this.current);
    return true;
  };

  Store.prototype.moveSlide = function (from, to) {
    if (!this.model) return false;
    var n = this.model.slides.length;
    if (from < 0 || from >= n) return false;
    var target = U.clamp(to, 0, n - 1);
    if (target === from) return false;
    var item = this.model.slides.splice(from, 1)[0];
    this.model.slides.splice(target, 0, item);
    this.current = target;
    this.renumber();
    this.commit('调整页序');
    this.emit('slide', target);
    return true;
  };

  Store.prototype.renumber = function () {
    if (!this.model) return;
    this.model.slides.forEach(function (s, i) {
      s.name = '第 ' + (i + 1) + ' 页';
    });
  };

  Store.prototype.setSlideDoc = function (doc, label) {
    var s = this.slide();
    if (!s) return;
    s.doc = doc;
    this.commit(label || '编辑页面');
  };

  Store.prototype.setNotes = function (text) {
    var s = this.slide();
    if (!s || s.notes === text) return;
    s.notes = text;
    this.commit('修改备注');
  };

  /* ── 批量事务 ────────────────────────────────────────────────────────── */

  Store.prototype.batch = function (fn, label) {
    this.batchDepth++;
    var before = this.hIndex;
    try { fn(); } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) {
        this.pushHistory(label || '批量编辑');
        this.setDirty(true);
        this.emit('change', label || 'batch');
      }
    }
    return this.hIndex !== before;
  };

  WD.Store = Store;
  WD.store = new Store();

})(typeof window !== 'undefined' ? window : globalThis);
