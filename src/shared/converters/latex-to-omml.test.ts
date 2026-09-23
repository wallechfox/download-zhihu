import { describe, it, expect } from 'vitest';
import { unwrapBoxed, fixAccents, fixNaryEmptyOperand, wrapWithBorderBox, latexToOmmlString, convertLatexToOmml } from '@/shared/converters/latex-to-omml';

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

  it('\\sum 不残留空 <m:e/>(消除 Word 空白方框)', () => {
    const out = latexToOmmlString('\\sum_n c_n', { display: true })!;
    expect(out).toContain('<m:nary');
    expect(out).not.toMatch(/<m:e\s*\/>/); // 无空操作数
    expect(out).not.toContain('<m:e></m:e>');
  });
});

describe('fixNaryEmptyOperand', () => {
  const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const naryWithEmptyE =
    `<m:oMath xmlns:m="${M_NS}">` +
    '<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr>' +
    '<m:sub><m:r><m:t>n</m:t></m:r></m:sub><m:sup/><m:e/></m:nary>' +
    '<m:sSub><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sub><m:r><m:t>n</m:t></m:r></m:sub></m:sSub>' +
    '</m:oMath>';

  it('把 nary 后的兄弟移入空的 <m:e>', () => {
    const out = fixNaryEmptyOperand(naryWithEmptyE);
    expect(out).not.toMatch(/<m:e\s*\/>/);
    expect(out).not.toContain('<m:e></m:e>');
    // 被作用项 sSub 现在位于 nary 的 <m:e> 内
    expect(out).toMatch(/<m:e><m:sSub/);
  });

  it('nary 的 <m:e> 已有内容时不动它', () => {
    const filled =
      `<m:oMath xmlns:m="${M_NS}">` +
      '<m:nary><m:naryPr><m:chr m:val="∫"/></m:naryPr><m:sub/><m:sup/>' +
      '<m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary></m:oMath>';
    const out = fixNaryEmptyOperand(filled);
    expect(out).toContain('<m:t>x</m:t>');
  });
});

describe('convertLatexToOmml', () => {
  it('成功公式返回非空组件', () => {
    expect(convertLatexToOmml('x=1', { display: false })).not.toBeNull();
  });
  it('返回的组件根元素是 m:oMath(非 fromXmlString 的无名包裹)', () => {
    const comp = convertLatexToOmml('x=1', { display: false }) as unknown as { rootKey?: string };
    expect(comp.rootKey).toBe('m:oMath');
  });
  it('inline 模式多行环境返回 null', () => {
    const tex = '\\begin{equation}\\begin{split} a &= b \\end{split}\\end{equation}';
    expect(convertLatexToOmml(tex, { display: false })).toBeNull();
  });
});
