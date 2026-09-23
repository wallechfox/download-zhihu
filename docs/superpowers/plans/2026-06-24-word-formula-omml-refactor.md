# Word 公式导出 OMML 直接注入重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Word 公式导出从「手写 OMML→docx Math 对象」改为「mml2omml 产出的 OMML 直接注入文档」,并对重音、`\boxed` 做后处理,修复公式恢复质量问题。

**Architecture:** 新建 DOM-free/可单测的 `latex-to-omml.ts` 模块,管线为 `LaTeX →(剥离 \boxed)→ temml(displayMode) → mml2omml → 修重音 → 包 borderBox → ImportedXmlComponent`。`html-to-docx.ts` 删除约 240 行手写转换器,两处调用点改为注入新组件。

**Tech Stack:** TypeScript、vite 8、`docx` ^9.6.1(`ImportedXmlComponent.fromXmlString`)、`temml` ^0.13.2、`mathml2omml`(vendored)、新测试栈 vitest + jsdom。

## Global Constraints

- 提交信息遵循 Conventional Commits(`feat:`/`refactor:`/`test:`/`docs:`),**禁止添加 `Co-Authored-By` 行**。
- 不新增运行时依赖;仅新增 devDependencies(`vitest`、`jsdom`)。
- `docx` 必须 ≥ 9.6.1(`ImportedXmlComponent` 可用);`temml` 必须 ≥ 0.13.2。
- 后处理代码使用浏览器全局 `DOMParser`/`XMLSerializer`(扩展运行时已有;测试用 jsdom 提供),命名空间常量统一为 `M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'`。
- `html-to-markdown.ts`、`zhihu-html-utils.ts` 不得改动。
- 重音字符集(实测,固定):`˙ ¨ ^ → ‾ ~ ˇ ˘ ´ `` `(分别对应 `\dot \ddot \hat \vec \bar \tilde \check \breve \acute \grave`)。

---

### Task 1: 搭建 vitest + jsdom 测试基础设施

**Files:**
- Modify: `package.json`(devDependencies + scripts)
- Create: `vitest.config.ts`
- Create: `src/shared/converters/__smoke__.test.ts`(临时冒烟,本任务末尾删除)

**Interfaces:**
- Produces: `npm test` 可运行 vitest;`@/` 别名在测试中可解析;测试默认 jsdom 环境(提供 `DOMParser`/`XMLSerializer`)。

- [ ] **Step 1: 安装 devDependencies**

Run:
```bash
npm i -D vitest jsdom
```
Expected: `package.json` 的 devDependencies 出现 `vitest` 与 `jsdom`。

- [ ] **Step 2: 创建 vitest 配置**

Create `vitest.config.ts`(独立于 `vite.config.ts`,不引入 crx 插件,避免污染测试环境):
```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: 添加 test 脚本**

修改 `package.json` 的 `scripts`,把原来的 `"test": "echo \"Error: no test specified\" && exit 1"` 替换为:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: 写冒烟测试验证 DOMParser 可用**

Create `src/shared/converters/__smoke__.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('test infra', () => {
  it('provides DOMParser/XMLSerializer via jsdom', () => {
    const doc = new DOMParser().parseFromString('<a><b/></a>', 'application/xml');
    expect(doc.documentElement.tagName).toBe('a');
    expect(new XMLSerializer().serializeToString(doc)).toContain('<b');
  });
});
```

- [ ] **Step 5: 运行冒烟测试**

Run: `npm test`
Expected: PASS(1 passed)。

- [ ] **Step 6: 删除冒烟测试并提交**

```bash
rm src/shared/converters/__smoke__.test.ts
git add package.json package-lock.json vitest.config.ts
git commit -m "test: 引入 vitest + jsdom 测试基础设施"
```

---

### Task 2: `unwrapBoxed` —— 剥离整体 `\boxed{}`

**Files:**
- Create: `src/shared/converters/latex-to-omml.ts`
- Test: `src/shared/converters/latex-to-omml.test.ts`

**Interfaces:**
- Produces: `export function unwrapBoxed(latex: string): { inner: string; boxed: boolean }`
  - 当 `latex.trim()` 整体为 `\boxed{X}`(第一个 `{` 的配对 `}` 落在末尾)时返回 `{ inner: X, boxed: true }`;否则 `{ inner: latex, boxed: false }`。

- [ ] **Step 1: 写失败测试**

Create `src/shared/converters/latex-to-omml.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { unwrapBoxed } from '@/shared/converters/latex-to-omml';

describe('unwrapBoxed', () => {
  it('剥离整体 boxed', () => {
    expect(unwrapBoxed('\\boxed{x=1}')).toEqual({ inner: 'x=1', boxed: true });
  });
  it('容忍空格与嵌套花括号', () => {
    expect(unwrapBoxed('  \\boxed{ \\frac{a}{b} }  ')).toEqual({ inner: ' \\frac{a}{b} ', boxed: true });
  });
  it('非整体 boxed 不剥离', () => {
    expect(unwrapBoxed('\\boxed{a}+\\boxed{b}')).toEqual({ inner: '\\boxed{a}+\\boxed{b}', boxed: false });
  });
  it('无 boxed 原样返回', () => {
    expect(unwrapBoxed('x=1')).toEqual({ inner: 'x=1', boxed: false });
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: FAIL("does not provide an export named 'unwrapBoxed'" 或模块不存在)。

- [ ] **Step 3: 实现 `unwrapBoxed`**

Create `src/shared/converters/latex-to-omml.ts`:
```ts
// src/shared/converters/latex-to-omml.ts
// LaTeX → 可注入文档的 OMML 组件
// 依赖: temml, mathml2omml(vendored), docx

/**
 * 若 LaTeX 整体被 \boxed{} 包裹,剥离并标记;否则原样返回。
 * "整体"指第一个 { 的配对 } 恰好是字符串末尾。
 */
export function unwrapBoxed(latex: string): { inner: string; boxed: boolean } {
  const trimmed = latex.trim();
  const prefix = '\\boxed{';
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('}')) {
    return { inner: latex, boxed: false };
  }
  let depth = 0;
  const start = prefix.length - 1; // 指向第一个 '{'
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // 配对的 '}' 必须是末尾字符才算整体 boxed
        if (i === trimmed.length - 1) {
          return { inner: trimmed.slice(start + 1, i), boxed: true };
        }
        return { inner: latex, boxed: false };
      }
    }
  }
  return { inner: latex, boxed: false };
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: PASS(4 passed)。

- [ ] **Step 5: 提交**

```bash
git add src/shared/converters/latex-to-omml.ts src/shared/converters/latex-to-omml.test.ts
git commit -m "feat: 新增 unwrapBoxed 剥离整体 \\boxed 公式"
```

---

### Task 3: `fixAccents` —— `m:limUpp` 重音改写为 `m:acc`

**Files:**
- Modify: `src/shared/converters/latex-to-omml.ts`
- Test: `src/shared/converters/latex-to-omml.test.ts`

**Interfaces:**
- Consumes: 无(纯字符串入出)
- Produces: `export function fixAccents(omml: string): string`
  - 把 `<m:lim>` 文本恰为重音字符集之一的 `<m:limUpp>` 重写为 `<m:acc><m:accPr><m:chr m:val="<字符>"/></m:accPr><m:e>…原 e…</m:e></m:acc>`,支持嵌套。
- 模块级常量 `const M_NS`(供 Task 4 复用)。

- [ ] **Step 1: 写失败测试**

追加到 `src/shared/converters/latex-to-omml.test.ts`:
```ts
import { fixAccents } from '@/shared/converters/latex-to-omml';

describe('fixAccents', () => {
  const dotOmml =
    '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
    '<m:limUpp><m:e><m:r><m:t>c</m:t></m:r></m:e>' +
    '<m:lim><m:r><m:t>˙</m:t></m:r></m:lim></m:limUpp></m:oMath>';

  it('把重音 limUpp 改写成 acc', () => {
    const out = fixAccents(dotOmml);
    expect(out).toContain('<m:acc');
    expect(out).toMatch(/<m:chr m:val="˙"\s*\/?>/);
    expect(out).not.toContain('<m:limUpp');
    expect(out).toContain('<m:t>c</m:t>'); // 基底保留
  });

  it('非重音 limUpp(真实上极限)不动', () => {
    const lim =
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
      '<m:limUpp><m:e><m:r><m:t>x</m:t></m:r></m:e>' +
      '<m:lim><m:r><m:t>n</m:t></m:r></m:lim></m:limUpp></m:oMath>';
    expect(fixAccents(lim)).toContain('<m:limUpp');
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: FAIL("does not provide an export named 'fixAccents'")。

- [ ] **Step 3: 实现 `fixAccents` + 常量**

在 `latex-to-omml.ts` 顶部(`unwrapBoxed` 之前)加入常量与辅助,并新增 `fixAccents`:
```ts
export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** 实测:10 种 LaTeX 重音经 mml2omml 落为 limUpp,lim 文本为下列单字符 */
const ACCENT_CHARS = new Set([
  '˙', // ˙ \dot
  '¨', // ¨ \ddot
  '^',      //   \hat
  '→', // → \vec
  '‾', // ‾ \bar
  '~',      //   \tilde
  'ˇ', // ˇ \check
  '˘', // ˘ \breve
  '´', // ´ \acute
  '`',      //   \grave
]);

function childByTag(parent: Element, qname: string): Element | null {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 1 && (node as Element).nodeName === qname) return node as Element;
  }
  return null;
}

/** 把 lim 为重音字符的 limUpp 改写为 acc(循环处理以覆盖嵌套) */
export function fixAccents(omml: string): string {
  const doc = new DOMParser().parseFromString(omml, 'application/xml');
  for (;;) {
    const limUpps = Array.from(doc.getElementsByTagName('m:limUpp'));
    let changed = false;
    for (const limUpp of limUpps) {
      const e = childByTag(limUpp, 'm:e');
      const lim = childByTag(limUpp, 'm:lim');
      if (!e || !lim) continue;
      const ch = (lim.textContent ?? '').trim();
      if (!ACCENT_CHARS.has(ch)) continue;

      const acc = doc.createElementNS(M_NS, 'm:acc');
      const accPr = doc.createElementNS(M_NS, 'm:accPr');
      const chr = doc.createElementNS(M_NS, 'm:chr');
      chr.setAttribute('m:val', ch);
      accPr.appendChild(chr);
      acc.appendChild(accPr);
      acc.appendChild(e); // 把基底 e 迁入 acc(自动从 limUpp 脱离)
      limUpp.parentNode?.replaceChild(acc, limUpp);
      changed = true;
      break; // 结构已变,重新查询
    }
    if (!changed) break;
  }
  return new XMLSerializer().serializeToString(doc);
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/converters/latex-to-omml.ts src/shared/converters/latex-to-omml.test.ts
git commit -m "feat: 新增 fixAccents 将重音 limUpp 改写为 m:acc"
```

---

### Task 4: `wrapWithBorderBox` —— 给 oMath 内容包方框

**Files:**
- Modify: `src/shared/converters/latex-to-omml.ts`
- Test: `src/shared/converters/latex-to-omml.test.ts`

**Interfaces:**
- Consumes: `M_NS`(Task 3)
- Produces: `export function wrapWithBorderBox(omml: string): string`
  - 把 `<m:oMath>` 的全部子节点搬入 `<m:borderBox><m:e>…</m:e></m:borderBox>` 并作为 oMath 唯一子节点。

- [ ] **Step 1: 写失败测试**

追加到测试文件:
```ts
import { wrapWithBorderBox } from '@/shared/converters/latex-to-omml';

describe('wrapWithBorderBox', () => {
  it('用 borderBox 包裹 oMath 内容', () => {
    const omml =
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
      '<m:r><m:t>x=1</m:t></m:r></m:oMath>';
    const out = wrapWithBorderBox(omml);
    expect(out).toContain('<m:borderBox');
    expect(out).toContain('<m:e>');
    expect(out).toContain('<m:t>x=1</m:t>');
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: FAIL("does not provide an export named 'wrapWithBorderBox'")。

- [ ] **Step 3: 实现 `wrapWithBorderBox`**

在 `latex-to-omml.ts` 追加:
```ts
/** 把 oMath 的内容整体包进 borderBox(用于整体 \boxed) */
export function wrapWithBorderBox(omml: string): string {
  const doc = new DOMParser().parseFromString(omml, 'application/xml');
  const oMath = doc.getElementsByTagName('m:oMath')[0] ?? doc.documentElement;
  const borderBox = doc.createElementNS(M_NS, 'm:borderBox');
  const e = doc.createElementNS(M_NS, 'm:e');
  while (oMath.firstChild) e.appendChild(oMath.firstChild);
  borderBox.appendChild(e);
  oMath.appendChild(borderBox);
  return new XMLSerializer().serializeToString(doc);
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/converters/latex-to-omml.ts src/shared/converters/latex-to-omml.test.ts
git commit -m "feat: 新增 wrapWithBorderBox 还原 \\boxed 方框"
```

---

### Task 5: `latexToOmmlString` —— 串联完整管线

**Files:**
- Modify: `src/shared/converters/latex-to-omml.ts`
- Test: `src/shared/converters/latex-to-omml.test.ts`

**Interfaces:**
- Consumes: `unwrapBoxed`、`fixAccents`、`wrapWithBorderBox`;`temml` 默认导出;`mml2omml`(来自 `@/vendor/mathml2omml.min.js`)。
- Produces: `export function latexToOmmlString(latex: string, opts: { display: boolean }): string | null`
  - 成功返回最终 OMML 字符串;temml 报错或产出无渲染结构(无 `<m:r`)时返回 `null`。

- [ ] **Step 1: 写失败测试**

追加到测试文件:
```ts
import { latexToOmmlString } from '@/shared/converters/latex-to-omml';

describe('latexToOmmlString', () => {
  it('保留 \\oint 的运算符(不坍缩为 Σ)', () => {
    const out = latexToOmmlString('\\oint_C \\mathbf{A} \\cdot d \\mathbf{r}', { display: true });
    expect(out).not.toBeNull();
    expect(out!).toContain('m:val="∮"'); // ∮
  });

  it('保留 \\prod 的运算符', () => {
    const out = latexToOmmlString('\\prod_{j=0}^{M-1} x_j', { display: true });
    expect(out!).toContain('m:val="∏"'); // ∏
  });

  it('display 模式下多行 \\begin{split} 渲染为矩阵且非空', () => {
    const tex = '\\begin{equation}\\begin{split} a &= b \\\\ &= c \\end{split}\\end{equation}';
    const out = latexToOmmlString(tex, { display: true });
    expect(out).not.toBeNull();
    expect(out!).toMatch(/<m:m[ >]/); // 矩阵
  });

  it('inline 模式下多行环境产出 null(交由调用方回退)', () => {
    const tex = '\\begin{equation}\\begin{split} a &= b \\end{split}\\end{equation}';
    expect(latexToOmmlString(tex, { display: false })).toBeNull();
  });

  it('\\dot 产出 m:acc', () => {
    expect(latexToOmmlString('\\dot{c}', { display: false })!).toContain('<m:acc');
  });

  it('整体 \\boxed 产出 borderBox', () => {
    expect(latexToOmmlString('\\boxed{x=1}', { display: true })!).toContain('<m:borderBox');
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: FAIL("does not provide an export named 'latexToOmmlString'")。

- [ ] **Step 3: 实现 `latexToOmmlString` + 导入**

在 `latex-to-omml.ts` 顶部加导入:
```ts
import temml from 'temml';
import { mml2omml } from '@/vendor/mathml2omml.min.js';
```
追加实现:
```ts
/** LaTeX → 最终 OMML 字符串;失败返回 null(由调用方决定回退) */
export function latexToOmmlString(latex: string, opts: { display: boolean }): string | null {
  const { inner, boxed } = unwrapBoxed(latex);
  const mathml = temml.renderToString(inner, { displayMode: opts.display, throwOnError: false });
  if (mathml.includes('temml-error')) return null;

  let omml = mml2omml(mathml);
  // 无任何渲染叶子(空 oMath)视为失败
  if (!/<m:r[ >/]/.test(omml)) return null;

  omml = fixAccents(omml);
  if (boxed) omml = wrapWithBorderBox(omml);
  return omml;
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/converters/latex-to-omml.ts src/shared/converters/latex-to-omml.test.ts
git commit -m "feat: 新增 latexToOmmlString 串联 temml→mml2omml→后处理管线"
```

---

### Task 6: `convertLatexToOmml` —— 包装为可注入组件

**Files:**
- Modify: `src/shared/converters/latex-to-omml.ts`
- Test: `src/shared/converters/latex-to-omml.test.ts`

**Interfaces:**
- Consumes: `latexToOmmlString`;`ImportedXmlComponent`(来自 `docx`)。
- Produces: `export function convertLatexToOmml(latex: string, opts: { display: boolean }): ImportedXmlComponent | null`
  - 这是 `html-to-docx.ts` 唯一调用的入口。

- [ ] **Step 1: 写失败测试**

追加到测试文件:
```ts
import { convertLatexToOmml } from '@/shared/converters/latex-to-omml';

describe('convertLatexToOmml', () => {
  it('成功公式返回非空组件', () => {
    expect(convertLatexToOmml('x=1', { display: false })).not.toBeNull();
  });
  it('inline 模式多行环境返回 null', () => {
    const tex = '\\begin{equation}\\begin{split} a &= b \\end{split}\\end{equation}';
    expect(convertLatexToOmml(tex, { display: false })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: FAIL("does not provide an export named 'convertLatexToOmml'")。

- [ ] **Step 3: 实现 `convertLatexToOmml`**

在 `latex-to-omml.ts` 顶部导入处追加:
```ts
import { ImportedXmlComponent } from 'docx';
```
追加实现:
```ts
/** LaTeX → 可注入 Paragraph/inline 的 OMML 组件;失败返回 null */
export function convertLatexToOmml(
  latex: string,
  opts: { display: boolean },
): ImportedXmlComponent | null {
  const omml = latexToOmmlString(latex, opts);
  if (!omml) return null;
  try {
    return ImportedXmlComponent.fromXmlString(omml);
  } catch (e) {
    console.warn('OMML 注入失败:', latex, e);
    return null;
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/shared/converters/latex-to-omml.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/converters/latex-to-omml.ts src/shared/converters/latex-to-omml.test.ts
git commit -m "feat: 新增 convertLatexToOmml 入口(ImportedXmlComponent 注入)"
```

---

### Task 7: 真实公式回归测试(96 条夹具)

**Files:**
- Create: `src/shared/converters/latex-to-omml.fixtures.test.ts`
- 使用夹具: `docs/superpowers/specs/2026-06-24-word-formula-omml-fixtures.json`

**Interfaces:**
- Consumes: `latexToOmmlString`(Task 5)。

- [ ] **Step 1: 写回归测试**

Create `src/shared/converters/latex-to-omml.fixtures.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { latexToOmmlString } from '@/shared/converters/latex-to-omml';
import fixtures from '../../../docs/superpowers/specs/2026-06-24-word-formula-omml-fixtures.json';

const formulas = fixtures as string[];

describe('真实公式回归(96 条)', () => {
  it('display 模式下每条都产出非空 OMML(无静默丢失)', () => {
    const blanks = formulas.filter((f) => latexToOmmlString(f, { display: true }) === null);
    expect(blanks).toEqual([]);
  });

  it('含 \\oint 的公式保留 ∮(不坍缩为 Σ)', () => {
    const oint = formulas.filter((f) => f.includes('\\oint'));
    expect(oint.length).toBeGreaterThan(0);
    for (const f of oint) {
      expect(latexToOmmlString(f, { display: true })!).toContain('m:val="∮"');
    }
  });

  it('含 \\prod 的公式保留 ∏', () => {
    const prod = formulas.filter((f) => f.includes('\\prod'));
    expect(prod.length).toBeGreaterThan(0);
    for (const f of prod) {
      expect(latexToOmmlString(f, { display: true })!).toContain('m:val="∏"');
    }
  });

  it('含 \\dot 的公式产出 m:acc', () => {
    const dot = formulas.filter((f) => f.includes('\\dot{'));
    expect(dot.length).toBeGreaterThan(0);
    for (const f of dot) {
      expect(latexToOmmlString(f, { display: true })!).toContain('<m:acc');
    }
  });

  it('整体 \\boxed 公式产出 borderBox', () => {
    const boxed = formulas.filter((f) => f.trim().startsWith('\\boxed{'));
    expect(boxed.length).toBeGreaterThan(0);
    for (const f of boxed) {
      expect(latexToOmmlString(f, { display: true })!).toContain('<m:borderBox');
    }
  });
});
```

- [ ] **Step 2: 运行回归测试**

Run: `npx vitest run src/shared/converters/latex-to-omml.fixtures.test.ts`
Expected: PASS(5 passed)。若某条仍产 null,记录该 LaTeX 并核对是否为夹具外的新语法,不要削弱断言。

- [ ] **Step 3: 提交**

```bash
git add src/shared/converters/latex-to-omml.fixtures.test.ts
git commit -m "test: 新增 96 条真实公式回归(空白/∮/∏/重音/boxed)"
```

---

### Task 8: 接入 `html-to-docx.ts` 并删除旧转换器

**Files:**
- Modify: `src/shared/converters/html-to-docx.ts`(删除 126–380 行手写转换器;改 import;改两处调用点)

**Interfaces:**
- Consumes: `convertLatexToOmml`(Task 6)。

- [ ] **Step 1: 确认旧转换器无外部引用**

Run:
```bash
grep -rn "convertLatexToDocxMath\|parseOmmlToDocxMath\|convertOmml\|MathFraction\|MathSum\|MathIntegral" src --include=*.ts | grep -v "latex-to-omml"
```
Expected: 仅 `html-to-docx.ts` 内部出现(确认无其它文件依赖)。

- [ ] **Step 2: 替换 import 块**

在 `html-to-docx.ts` 中:
1. 删除这些 docx 数学相关 import 项:`Math as DocxMath, MathRun as DocxMathRun, MathFraction, MathSuperScript, MathSubScript, MathSubSuperScript, MathRadical, MathRoundBrackets, MathSquareBrackets, MathCurlyBrackets, MathSum, MathIntegral, MathLimitLower, MathLimitUpper, MathFunction,`。
2. 删除 `import temml from 'temml';` 与 `import { mml2omml } from '@/vendor/mathml2omml.min.js';`。
3. 在 `zhihu-html-utils` 的 import 之后新增:
```ts
import { convertLatexToOmml } from '@/shared/converters/latex-to-omml';
```
保留 `docx` 其余 import(`Document, Packer, Paragraph, TextRun, ...` 等)不变。

- [ ] **Step 3: 删除手写转换器整段**

删除从 `// ============================================================`(第 126 行 `// LaTeX → docx Math 转换` 上方的分隔注释起)到 `findChild` 函数结束(第 380 行)之间的全部内容,包括:`type MathComponent`、`convertLatexToDocxMath`、`parseOmmlToDocxMath`、`localName`、`convertOmmlChildren`、`convertOmmlElement`、`convertOmmlRun`、`ommlChildrenOf`、`convertOmmlFraction`、`convertOmmlSup/Sub/SubSup`、`convertOmmlRadical`、`convertOmmlDelimiter`、`convertOmmlNary`、`convertOmmlAccent`、`convertOmmlLimLow/LimUpp`、`convertOmmlFunc`、`findChild`。保留其后的 `// 行内元素收集` 段。

- [ ] **Step 4: 改 inline 调用点(原 478–489 行)**

把:
```ts
  if (isMath(el)) {
    const latex = getLatex(el);
    if (latex) {
      const mathRuns = convertLatexToDocxMath(latex);
      if (mathRuns) {
        runs.push(new DocxMath({ children: mathRuns }));
      } else {
        runs.push(new TextRun({ text: `$${latex}$`, font: { name: 'Consolas' } }));
      }
      return runs;
    }
  }
```
改为:
```ts
  if (isMath(el)) {
    const latex = getLatex(el);
    if (latex) {
      const omml = convertLatexToOmml(latex, { display: false });
      if (omml) {
        runs.push(omml);
      } else {
        runs.push(new TextRun({ text: `$${latex}$`, font: { name: 'Consolas' } }));
      }
      return runs;
    }
  }
```

- [ ] **Step 5: 改 block 调用点(原 581–592 行)**

把:
```ts
  if (isMath(element)) {
    const latex = getLatex(element);
    if (latex) {
      const mathRuns = convertLatexToDocxMath(latex);
      if (mathRuns) {
        blocks.push(new Paragraph({ children: [new DocxMath({ children: mathRuns })], alignment: AlignmentType.CENTER }));
      } else {
        blocks.push(new Paragraph({ children: [new TextRun({ text: `$$${latex}$$`, font: { name: 'Consolas' } })], alignment: AlignmentType.CENTER }));
      }
      return blocks;
    }
  }
```
改为:
```ts
  if (isMath(element)) {
    const latex = getLatex(element);
    if (latex) {
      const omml = convertLatexToOmml(latex, { display: true });
      if (omml) {
        blocks.push(new Paragraph({ children: [omml], alignment: AlignmentType.CENTER }));
      } else {
        blocks.push(new Paragraph({ children: [new TextRun({ text: `$$${latex}$$`, font: { name: 'Consolas' } })], alignment: AlignmentType.CENTER }));
      }
      return blocks;
    }
  }
```

- [ ] **Step 6: 类型检查 + 全量测试 + 构建**

Run:
```bash
npx tsc --noEmit && npm test && npm run build
```
Expected: tsc 无错误;vitest 全绿;`vite build` 成功产出 `dist/`。

- [ ] **Step 7: 提交**

```bash
git add src/shared/converters/html-to-docx.ts
git commit -m "refactor: 公式导出改用 OMML 直接注入,删除手写 OMML→docx 转换器"
```

---

### Task 9: 真实 docx 端到端冒烟验证

**Files:**
- Create(临时): `scripts/smoke-formula-docx.mjs`(验证后删除或保留为工具,默认删除)

**Interfaces:**
- Consumes: 已构建的管线逻辑(此脚本独立复刻 import,用于生成真实 .docx 供人工在 Word 打开)。

- [ ] **Step 1: 写冒烟脚本**

Create `scripts/smoke-formula-docx.mjs`:
```js
import temml from 'temml';
import { mml2omml } from '../src/vendor/mathml2omml.min.js';
import { Document, Packer, Paragraph, ImportedXmlComponent } from 'docx';
import fs from 'node:fs';

const fixtures = JSON.parse(
  fs.readFileSync(new URL('../docs/superpowers/specs/2026-06-24-word-formula-omml-fixtures.json', import.meta.url)),
);

// 注:此脚本仅做端到端冒烟(displayMode + 注入),不复刻重音/boxed 后处理。
const paras = [];
for (const tex of fixtures) {
  const mathml = temml.renderToString(tex, { displayMode: true, throwOnError: false });
  if (mathml.includes('temml-error')) { console.warn('SKIP(temml-error):', tex.slice(0, 50)); continue; }
  const omml = mml2omml(mathml);
  if (!/<m:r[ >/]/.test(omml)) { console.warn('SKIP(empty):', tex.slice(0, 50)); continue; }
  paras.push(new Paragraph({ children: [ImportedXmlComponent.fromXmlString(omml)] }));
}
const doc = new Document({ sections: [{ children: paras }] });
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(new URL('../formula-smoke.docx', import.meta.url), buf);
console.log('wrote formula-smoke.docx,', paras.length, 'formulas');
```

- [ ] **Step 2: 运行脚本**

Run: `node scripts/smoke-formula-docx.mjs`
Expected: 打印 `wrote formula-smoke.docx, <N> formulas`,且无 `SKIP(empty)`(displayMode 下应为 0 空);项目根目录出现 `formula-smoke.docx`。

- [ ] **Step 3: 人工核对**

打开 `formula-smoke.docx`,抽检:多行 `\begin{split}` 推导渲染为多行公式(而非乱码或原始 `$$`)、含 ∮/∏ 的式子运算符正确、`\dot`/`\vec` 的重音位置正常、`\boxed` 结论有方框。记录任何异常。

- [ ] **Step 4: 清理临时产物并提交**

```bash
rm scripts/smoke-formula-docx.mjs formula-smoke.docx
git status   # 确认无残留临时文件
```
(若 `scripts/` 目录此前不存在且现已为空,一并删除。本任务无源码变更,无需提交;若人工核对发现问题,回到对应 Task 修复。)

---

## Self-Review

**Spec coverage:**
- #1 displayMode/空白 → Task 5(`display` 传参 + temml-error/空检测)、Task 7(0 空断言)、Task 8(block 传 `display:true`)。✓
- #2 ∮/∏ 坍缩 → 由「直接注入」消除;Task 5/7 断言 chr 保留。✓
- #3 样式丢失 → 由「直接注入」消除(粗体由 Unicode 码位承载);Task 8 接入。✓
- #4 重音 → Task 3 `fixAccents`、Task 5/7 断言 `m:acc`。✓
- #5 矩阵/多行 → 由「直接注入」+ displayMode 消除;Task 5/7 断言 `<m:m`。✓
- #6 `\boxed` → Task 2 `unwrapBoxed` + Task 4 `wrapWithBorderBox` + Task 5/7 断言 `borderBox`。✓
- #7 groupChr/argPr → 由「直接注入」消除(不再有手写 switch 的 default 分支)。✓
- 失败回退 → Task 8 两处调用点保留 `$...$`/`$$...$$` 回退。✓
- 删除手写转换器、不改 markdown/utils → Task 8。✓
- 测试基础设施 → Task 1。✓

**Placeholder scan:** 无 TBD/TODO;每个代码步骤均给出完整代码与确切命令。✓

**Type consistency:** `convertLatexToOmml(latex, { display })`、`latexToOmmlString(latex, { display })`、`unwrapBoxed→{inner,boxed}`、`fixAccents/wrapWithBorderBox: string→string`、`M_NS` 常量在 Task 3 定义后被 Task 4 复用——签名跨任务一致。✓
