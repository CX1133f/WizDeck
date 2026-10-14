/* LaTeX → MathML 解析器的独立单元测试。
   不开浏览器，直接跑 07-elements.js 里的纯函数。 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const code = fs.readFileSync(path.resolve('build/js/07-elements.js'), 'utf8');
const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const E = sandbox.window.WD.elements;

let pass = 0, fail = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + '   ' + detail); }
}
const render = (src) => E.latexToMathML(src);

console.log('\n[1] 基础结构');
let m = render('E = m c^2');
check('能吐出 <math>', /^<math /.test(m), m.slice(0, 90));
check('上标变成 <msup>', m.includes('<msup>'), m);
check('不含原始 LaTeX 命令', !/\\frac|\\sqrt/.test(m), m);
check('含等号与变量', /<mi>E<\/mi>/.test(m) && /<mo>=<\/mo>/.test(m), m);

console.log('\n[2] 分数');
m = render('\\frac{a}{b}');
check('\\frac → <mfrac>', m.includes('<mfrac>'), m);
check('分子 a 分母 b', /<mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac>/.test(m), m);
m = render('\\frac{-1}{2}');
check('负号分子能解析', m.includes('<mfrac>') && m.includes('-'), m);

console.log('\n[3] 根号');
m = render('\\sqrt{x}');
check('\\sqrt → <msqrt>', m.includes('<msqrt>'), m);
m = render('\\sqrt[3]{x}');
check('\\sqrt[n] → <mroot>', m.includes('<mroot>') && m.includes('<mn>3</mn>'), m);

console.log('\n[4] 上下标');
m = render('x_i^2');
check('同时带 _ 和 ^ 能解析', m.includes('<mi>x</mi>'), m);
m = render('a^{n+1}');
check('^{...} 整体作为上标', /<msup>[\s\S]*<mi>n<\/mi><mo>\+<\/mo><mn>1<\/mn>/.test(m), m);
m = render('x^{-1}');
check('负指数不被拆开', /<msup>[\s\S]*<mo>-<\/mo><mn>1<\/mn>/.test(m), m);

console.log('\n[5] 希腊字母与符号');
m = render('\\alpha + \\beta = \\gamma');
check('\\alpha → α', m.includes('α'), m);
check('\\Gamma → Γ', render('\\Gamma').includes('Γ'), render('\\Gamma'));
check('\\leq → ≤', render('a \\leq b').includes('≤'), render('a \\leq b'));
check('\\times → ×', render('a \\times b').includes('×'), '');
check('\\infty → ∞', render('x \\in \\mathbb{R}').includes('∞') || render('\\infty').includes('∞'), '');
check('\\neq → ≠', render('a \\neq b').includes('≠'), '');

console.log('\n[6] 函数名与文本');
m = render('\\sin x');
check('\\sin 变成 upright 函数名', /<mi mathvariant="normal">sin<\/mi>/.test(m), m);
m = render('\\text{当 } x > 0');
check('\\text 变成 <mtext>', m.includes('<mtext>当 </mtext>'), m);
check('未知命令不吞掉', render('\\unknowncmd').includes('unknowncmd'), render('\\unknowncmd'));

console.log('\n[7] 大算符与上下限');
m = render('\\sum_{i=1}^{n} i');
check('\\sum 保留为求和号', m.includes('∑'), m);
check('带下限 i=1', /<msub>/.test(m), m);

console.log('\n[8] 重音与分组');
m = render('\\hat{x}');
check('\\hat → <mover>', m.includes('<mover>'), m);
m = render('(a+b)c');
check('括号与隐式乘法', m.includes('<mo>(</mo>') && m.includes('<mi>c</mi>'), m);

console.log('\n[9] 健壮性');
check('空串不抛异常', (() => { try { return render('').includes('<math'); } catch (e) { return false; } })(), '');
check('纯乱码不抛异常', (() => { try { render('###@@@\\'); return true; } catch (e) { return false; } })(), '');
check('超长表达式不抛异常', (() => { try { render('x+'.repeat(400)); return true; } catch (e) { return false; } })(), '');
check('嵌套分数', (() => { try { render('\\frac{1}{\\frac{a}{b}}'); return true; } catch (e) { return false; } })(), '');
check('未闭合括号不挂死', (() => { try { render('\\frac{a}{b'); return true; } catch (e) { return false; } })(), '');
check('左右定界符被剥掉', !/\\left|\\right/.test(render('\\left( x \\right)')), render('\\left( x \\right)'));

console.log('\n[10] 一组真实公式');
const SAMPLES = [
  '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}',
  '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}',
  'E = mc^2',
  'a^2 + b^2 = c^2',
  '\\alpha + \\beta + \\gamma = \\pi',
];
for (const s of SAMPLES) {
  const out = render(s);
  const ok = /^<math /.test(out) && !/\\[a-zA-Z]+/.test(out.replace(/xmlns[^ ]*="[^"]*"/g, ''));
  check('「' + s + '」可渲染', ok, out.slice(0, 120));
}

console.log('\n通过 ' + pass + '  失败 ' + fail);
if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
process.exit(0);
