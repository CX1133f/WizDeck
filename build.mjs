/* ============================================================================
   智演引擎 / WizDeck — 构建脚本
     把 build/ 下的 shell.html + styles.css + js/*.js 组装成单文件 WizDeck.html
     用法：node build.mjs
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, 'build');
const jsDir = path.join(buildDir, 'js');
const outFile = path.join(here, 'WizDeck.html');

const shell = fs.readFileSync(path.join(buildDir, 'shell.html'), 'utf8');
const styles = fs.readFileSync(path.join(buildDir, 'styles.css'), 'utf8');

const jsFiles = fs.readdirSync(jsDir)
  .filter((f) => /^\d+.*\.js$/.test(f))
  .sort();

if (!jsFiles.length) {
  console.error('build/js 下没有找到源文件');
  process.exit(1);
}

const banner = (name) =>
  `\n/* ${'─'.repeat(74)}\n   ${name}\n   ${'─'.repeat(74)} */\n`;

const script = jsFiles.map((f) => {
  const code = fs.readFileSync(path.join(jsDir, f), 'utf8');
  return banner(f) + code.trimEnd() + '\n';
}).join('\n');

/* 占位替换 */
if (!shell.includes('/* ==== STYLES ==== */')) throw new Error('shell.html 缺少 STYLES 占位');
if (!shell.includes('/* ==== SCRIPT ==== */')) throw new Error('shell.html 缺少 SCRIPT 占位');

let html = shell
  .replace('/* ==== STYLES ==== */', () => styles.trim())
  .replace('/* ==== SCRIPT ==== */', () => script.trim());

/* 安全检查：单文件必须完全自包含 */
const violations = [];
const externals = html.match(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi) || [];
externals.forEach((m) => violations.push('外部引用: ' + m));
if (/<link[^>]+rel=["']stylesheet["']/i.test(html)) violations.push('存在外部样式表链接');

const size = Buffer.byteLength(html, 'utf8');
fs.writeFileSync(outFile, html, 'utf8');

console.log('✓ 已生成', path.relative(here, outFile));
console.log('  源文件:', jsFiles.join(', '));
console.log('  体积  :', (size / 1024).toFixed(1), 'KB');
if (violations.length) {
  console.log('  ⚠ 自包含检查:');
  violations.forEach((v) => console.log('    - ' + v));
} else {
  console.log('  自包含: 通过（无外部脚本 / 样式 / 字体引用）');
}
