# 智演引擎 · WizDeck

单文件离线演示编辑器：解析任意 HTML 课件 → 切分为 1920×1080 幻灯片 → 在工作台做幻灯片级与元素级编辑 → 浏览器内直接导出真实可编辑的 `.pptx`。

零依赖、零联网、不上传任何数据。双击 `WizDeck.html` 即可运行。

[English](README.en.md)

## 核心能力

| | |
|---|---|
| **输入** | 任意 HTML 文档，图片 / 字体 / CSS 自动内联为 data URI |
| **切分** | `section` / `.slide` / `data-wd-slide` / reveal.js 结构自动识别；无标记时整篇作单页兜底 |
| **编辑** | 幻灯片级 + 元素级；位置、尺寸、旋转、层级、对齐分布、填充、边框、圆角、透明度、自定义 CSS |
| **元素** | 文本框、四级标题、形状、表格、公式（LaTeX）、图表、图片、视频、贝塞尔曲线、多边形 |
| **画布** | 拖拽 / 缩放 / 旋转 / 方向键微调 / 框选多选 / Alt 拖拽复制 / 格式刷 / 查找替换 |
| **导出** | `.pptx`（真实 OOXML）、单文件放映页 HTML、工程文件 `.wd.html` |
| **放映** | 全屏演示、演讲备注、翻页 HUD、亮暗主题 |

## 快速开始

1. 用浏览器打开 `WizDeck.html`（Chrome / Edge 均可）。
2. 点顶栏「打开」（`Ctrl+O`），或把 HTML 课件文件直接拖进窗口。
3. 在左栏切页、拖动排序；画布上双击改字，拖角点缩放，拖 `⟳` 旋转。
4. 右栏改颜色、字号、圆角等属性，改完即时生效。
5. 点「保存与导出」→「导出为 Power Point」，浏览器直接下载 `.pptx`。

顶栏「帮助」按钮内含完整的三步上手说明、快捷键表和分页约定。

## 输入约定

写 HTML 课件时，分页标记是可选的 —— 引擎会自动识别常见写法。要 100% 确定，用下面任意一种：

```html
<section class="slide"> … </section>

<div data-wd-slide> … </div>

<div class="slides"><section>…</section></div>   <!-- reveal.js -->
```

还原度建议：

- 页面尺寸用 `1920 × 1080`（`samples/patterns/odd-size-1280x720.html` 演示了其他尺寸也可用）。
- 使用系统字体（PingFang SC / Microsoft YaHei 等）与绝对定位。
- 外部图片、字体、样式表会被自动抓取内联，解析后即完全自包含。

## 导出说明

### PowerPoint（`.pptx`）

导出器手写 ZIP 打包器（CRC32 + deflate-raw，无 `CompressionStream` 时退化为 store）与 PresentationML，在浏览器内生成真实 OOXML 包 —— 不依赖任何库、不联网。分三层写入，策略是**正确性优先，其次才是可编辑性**：

| 内容 | 导出结果 |
|---|---|
| 文字 | 真文本框，逐个视觉行一个，关闭自动换行，断行位置与浏览器一致 |
| 纯色块、边框、圆角矩形 | 真形状，可改填充与轮廓 |
| 图片 | 真图片对象 |
| 渐变、外阴影、滤镜、旋转、SVG、半透明 | 隔离渲染为 PNG 贴图，视觉 100% 一致，但不可再编辑文字 |

遮挡处理：若贴图元素盖住了矢量元素，才把被盖住的部分一并写进贴图，保证「所见即所得」；否则优先保留矢量的可编辑性。幻灯片底部的演讲备注会写进 PPTX 备注页。

### 其他格式

- **单文件放映页 HTML** —— 每页仍是完整 HTML 文档，自包含，可直接分享。
- **工程文件 `.wd.html`** —— 带 `wizdeck-doc` 工程区块，可用本工具重新打开继续编辑（`Ctrl+S`）。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+O` | 打开 HTML（也可直接拖文件进窗口） |
| `Ctrl+S` | 保存工程 · `Ctrl+E` 导出 PPTX |
| `Ctrl+F` | 查找文字（`Enter` 下一个 / `Shift+Enter` 上一个） |
| `Ctrl+C` / `V` / `D` | 复制 / 粘贴 / 就地复制元素 |
| `Ctrl+B` / `I` / `U` | 加粗 / 斜体 / 下划线 |
| `Ctrl+]` / `Ctrl+[` | 上移 / 下移一层 |
| 方向键 | 微调 1px，`Shift` + 方向键 10px |
| `Alt` + 拖动 | 复制元素 |
| `Shift` + 点击 | 多选 |
| `Delete` | 删除元素 |
| `F5` | 放映（放映中：`←` `→` 翻页，`N` 备注，`F` 全屏，`Esc` 退出） |
| `Ctrl+0` | 适合窗口 |
| `Ctrl+` / `Ctrl+-` | 缩放 |
| `Ctrl+\` | 一键显示 / 隐藏两侧面板 |

## 界面结构

- **顶栏** —— 撤销重做、新建页、插入（文本框 / 标题 / 形状 / 表格 / 公式 / 图表 / 图片 / 视频）、格式刷、查找、打开、保存与导出、主题、帮助。
- **左栏** —— 幻灯片列表，切换与拖拽排序。
- **画布** —— 幻灯片画布、选择框与控制手柄（角点缩放、`⟳` 旋转、贝塞尔起点/终点/拐点/两端切线）。
- **右栏** —— 上下文属性面板：幻灯片属性，或选中元素的尺寸、位置、填充、边框、圆角、透明度、层级、对齐分布、自定义 CSS 声明、LaTeX 源。
- **底栏** —— 选中元素信息、缩放控制、放映入口。

## 项目结构

```
WizDeck.html          ← 构建产物：单文件、自包含，直接分发
build.mjs             ← 构建脚本
build/
  shell.html          ← 页面骨架 + SVG 图标雪碧图
  styles.css
  js/01-core.js       ← 工具与常量（画布 1920×1080、EMU 换算）
  js/02-parse.js      ← HTML 解析、素材内联、幻灯片切分
  js/03-store.js      ← 文档模型、撤销 / 重做
  js/04-render.js     ← 渲染
  js/05-pptx.js       ← PPTX 导出器（ZIP + OOXML）
  js/06-ui.js         ← 顶栏、面板、检查器、快捷键、帮助
  js/07-elements.js   ← 元素类型
  js/08-draw.js       ← 手绘：贝塞尔曲线、多边形顶点编辑与填充
samples/              ← 示例课件与切分模式样例
tools/                ← 回归测试、探针脚本、校验工具
```

## 构建

```bash
node build.mjs
```

把 `build/` 下的 `shell.html` + `styles.css` + `js/*.js`（按数字前缀排序）组装成单文件 `WizDeck.html`，并做自包含检查 —— 检测任何外部脚本 / 样式 / 字体引用并告警。

## 测试

回归测试通过 CDP 驱动本机无头 Chrome，每个套件用全新浏览器实例（串联多个套件复用同一实例会导致后续套件假失败）。无需 npm 依赖，直接用 node 运行。

```powershell
# Windows
powershell -File tools\run-regressions.ps1

# 只跑指定套件
powershell -File tools\run-regressions.ps1 -Only edit-test.mjs,pattern-test.mjs
```

`tools/run-suites.sh` 提供等价的 bash 版本。日志写入 `tmp/regressions/`。

12 个回归套件覆盖：

| 套件 | 覆盖内容 |
|---|---|
| `edit-test.mjs` / `edit-test2.mjs` | 编辑核心 / 对齐、层级、框选 |
| `cursor-test.mjs` | 光标、旋转、拖拽命中点 |
| `textpos-test.mjs` | 文字定位精度 |
| `panel-test.mjs` | 面板收起 / 展开 |
| `topbar-test.mjs` | 顶栏按钮与图标 |
| `overlay-test.mjs` | 选择浮层零遮挡与快捷键一致性 |
| `elements-test.mjs` | 形状 / 标题 / 文本 / 表格 / 公式 / 图表 |
| `latex-test.mjs` | LaTeX → MathML 解析（纯 node，无需浏览器） |
| `video-test.mjs` | 插入视频与封面回退 |
| `ui-smoke.mjs` | 工作台外壳冒烟 |
| `pattern-test.mjs` | 幻灯片切分识别 |

`tools/` 下另有若干一次性探针脚本（命中测试、拖拽、折线、样式等）和 Python 校验工具（`validate_pptx.py`、`audit_bounds.py`、`fidelity.py`）。

## 已知限制

- 跨域图片 / 跨域字体读不到内容会被跳过（本地文件与 data URI 不受影响）。
- 文字依赖演示电脑上已安装的字体；导出时已为中文单独声明 `eastAsia` 字体以降低回退风险。
- 自定义 `@font-face` 不会嵌入 PPTX —— 需保真请改用系统字体，或把该处做成图片。

## 数据存储

全部状态保存在浏览器 `localStorage`，不上传：

| 键 | 用途 |
|---|---|
| `wizdeck.model` | `Ctrl+S` 保存当前文档到浏览器 |
| `wizdeck.theme` | 亮 / 暗主题 |
| `wizdeck.debug` | 开启调试日志 |
| `wizdeck.autosample` | 首次打开时载入示例 |
