// src/shared/converters/latex-to-omml.e2e.test.ts
// 端到端测试:将全部 fixture 公式注入真实 docx,校验 word/document.xml 包含正确 OMML 标记
import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import { convertLatexToOmml } from '@/shared/converters/latex-to-omml';
import rawFixtures from '../../../docs/superpowers/specs/2026-06-24-word-formula-omml-fixtures.json';

const fixtures = rawFixtures as string[];

let documentXml = '';
let docBuf: Buffer;

beforeAll(async () => {
  // Step 1: 将所有公式转换为 OMML 组件
  const results = fixtures.map((f) => ({ latex: f, omml: convertLatexToOmml(f, { display: true }) }));

  // Step 2: 断言无任何公式返回 null
  const nullFormulas = results.filter((r) => r.omml === null).map((r) => r.latex);
  expect(nullFormulas).toEqual([]);

  // Step 3: 构建文档
  const paragraphs = results
    .filter((r) => r.omml !== null)
    .map((r) => new Paragraph({ children: [r.omml!] }));

  const doc = new Document({ sections: [{ children: paragraphs }] });
  docBuf = await Packer.toBuffer(doc);

  // Part B: 写磁盘文件供人工核对(不加入 git)
  const outPath = resolve(__dirname, '../../../formula-smoke.docx');
  writeFileSync(outPath, docBuf);

  // Step 4: 解压并读取 word/document.xml
  const zip = await JSZip.loadAsync(docBuf);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('word/document.xml not found in generated docx');
  documentXml = await xmlFile.async('string');
}, 60_000);

describe('端到端 docx 公式注入验证', () => {
  it('全部公式注入文档,无 null,且 document.xml 含正确 OMML', () => {
    // 轮廓积分字符 ∮ 存在(Bug #2: ∮/∏ 不坍缩)
    expect(documentXml).toContain('∮');

    // 乘积符号 ∏ 存在(Bug #2)
    expect(documentXml).toContain('∏');

    // borderBox 存在(Bug #6: \boxed 保留方框)
    expect(documentXml).toContain('<m:borderBox');

    // 矩阵/多行 split 渲染为矩阵元素 m:m(Bug #1/#5)
    expect(documentXml).toMatch(/<m:m[ >]/);

    // 重音正确渲染为 acc 或 groupChr(Bug #4)
    const hasAccent = documentXml.includes('<m:acc') || documentXml.includes('<m:groupChr');
    expect(hasAccent).toBe(true);
  });

  it('document.xml 结构对 Word 有效:无 <undefined> 包裹,oMath 直接挂在段落下', () => {
    // 回归守卫:ImportedXmlComponent.fromXmlString 返回的无名包裹组件若被直接
    // 注入,会序列化出 <undefined> 元素,Word 无法识别 → 公式整体空白。
    expect(documentXml).not.toContain('<undefined');
    expect(documentXml).not.toContain('</undefined>');
    // 本测试用无对齐的 Paragraph 构建,oMath 应直接作为 <w:p> 的子节点
    expect(documentXml).toMatch(/<w:p><m:oMath/);
  });

  it('n-ary 算符(∑/∏/∫)无空操作数,避免 Word 空白方框', () => {
    // 回归守卫:mml2omml 把被作用项留在 nary 外面会产生空 <m:e/>,
    // Word 渲染成空白方框;fixNaryEmptyOperand 应已把它填上。
    expect(documentXml).not.toContain('<m:e/></m:nary>');
    expect(documentXml).not.toContain('<m:e></m:e></m:nary>');
  });
});
