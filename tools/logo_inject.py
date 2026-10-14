"""把 logo 以 data URI 注入 build/shell.html（保持单文件、无外部引用）。

幂等设计：用注释标记包裹注入区，重复运行先删旧区再写新区，不会叠加。

浅色 / 深色各一套：
  · 浅色主题用**透明** logo —— 应用底就是 #ffffff/#f5f7fa，与源图的浅色底板
    几乎同色，抠掉底板后接缝不可见。
  · 深色主题用**浅色底** logo —— 透明版在深色上会散架（图标里的白色卡片与
    柔光本来靠浅底衬托），换成浅色圆角底是常规做法。
两套都内嵌，靠 [data-theme] 切换，不依赖 prefers-color-scheme。
"""
import base64
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

SHELL = "build/shell.html"
CSS = "build/styles.css"


def uri(path):
    return "data:image/png;base64," + base64.b64encode(open(path, "rb").read()).decode("ascii")


assets = {
    "favicon": uri("brand/embed-favicon.png"),
    "topbar_light": uri("brand/embed-horizontal.png"),
    "topbar_dark": uri("brand/embed-horizontal-plate.png"),
    "empty_light": uri("brand/embed-lockup.png"),
    "empty_dark": uri("brand/embed-lockup-plate.png"),
}
for k, v in assets.items():
    print("  %-14s %7d B" % (k, len(v)))

html = open(SHELL, encoding="utf-8").read()

# ── 先移除上一次注入的内容（幂等） ─────────────────────────────────────
html = re.sub(r'<link rel="icon"[^>]*>\n?', '', html)
html = re.sub(r'<!-- WIZDECK-BRAND-START -->.*?<!-- WIZDECK-BRAND-END -->\n?', '', html, flags=re.S)

# ── favicon ───────────────────────────────────────────────────────────
html = html.replace(
    "<title>智演引擎 · WizDeck</title>",
    '<title>智演引擎 · WizDeck</title>\n'
    '<link rel="icon" type="image/png" href="' + assets["favicon"] + '">',
    1)

# ── 顶栏品牌 ──────────────────────────────────────────────────────────
brand = re.search(r'<div class="brand">.*?\n    </div>', html, re.S)
if not brand:
    print("!! 未找到 .brand")
    sys.exit(1)
new_brand = (
    '<div class="brand">\n'
    '      <!-- WIZDECK-BRAND-START -->\n'
    '      <img class="brand-logo logo-light" src="' + assets["topbar_light"] + '" alt="智演引擎 WizDeck">\n'
    '      <img class="brand-logo logo-dark" src="' + assets["topbar_dark"] + '" alt="" aria-hidden="true">\n'
    '      <!-- WIZDECK-BRAND-END -->\n'
    '    </div>')
html = html[:brand.start()] + new_brand + html[brand.end():]

# ── 空状态 logo ───────────────────────────────────────────────────────
if 'class="empty-logo' in html:
    html = re.sub(r'<img class="empty-logo[^>]*>\s*', '', html)
html = re.sub(r'<div class="empty-mark"[^>]*>.*?</div>\s*', '', html, flags=re.S)
empty_imgs = (
    '<img class="empty-logo logo-light" src="' + assets["empty_light"] + '" alt="WizDeck">\n'
    '        <img class="empty-logo logo-dark" src="' + assets["empty_dark"] + '" alt="" aria-hidden="true">\n        ')
# 插到 .stage-empty 的开头（紧跟其起始标签之后）
m = re.search(r'<div class="stage-empty" id="stage-empty">\s*', html)
if not m:
    print("!! 未找到 .stage-empty")
    sys.exit(1)
html = html[:m.end()] + empty_imgs + html[m.end():]

open(SHELL, "w", encoding="utf-8").write(html)
print("已更新", SHELL)

# ── 样式 ──────────────────────────────────────────────────────────────
css = open(CSS, encoding="utf-8").read()
# 清掉旧的 CSS 拼装 mark 与上一次注入的品牌块
css = re.sub(r'\.brand-mark(\s+[.\w]+)?\s*\{[^}]*\}\n?', '', css)
css = re.sub(r'/\* ══ 品牌 logo.*?(?=\n/\* ══|\Z)', '', css, flags=re.S)

css += """
/* ══ 品牌 logo（内嵌 data URI，保持单文件离线） ══ */
.brand { display: flex; align-items: center; gap: 9px; padding-right: 8px; user-select: none; }

.brand-logo { display: block; height: 26px; width: auto; }

/* 浅色主题用透明版；深色主题换成带浅色底的版本，
   否则图标里的白色卡片会在深底上碎成一片。 */
.brand-logo.logo-dark { display: none; }
[data-theme="dark"] .brand-logo.logo-light { display: none; }
[data-theme="dark"] .brand-logo.logo-dark { display: block; height: 30px; }

.empty-logo { display: block; width: 153px; height: auto; margin: 0 0 6px; }
.empty-logo.logo-dark { display: none; width: 157px; }
[data-theme="dark"] .empty-logo.logo-light { display: none; }
[data-theme="dark"] .empty-logo.logo-dark { display: block; }
"""
open(CSS, "w", encoding="utf-8").write(css)
print("已更新", CSS)
