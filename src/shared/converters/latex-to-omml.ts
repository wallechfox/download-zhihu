// src/shared/converters/latex-to-omml.ts
// LaTeX → 可注入文档的 OMML 组件
// 依赖: temml, mathml2omml(vendored), docx
import temml from 'temml';
import { mml2omml } from '@/vendor/mathml2omml.min.js';
import { ImportedXmlComponent } from 'docx';

export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** 实测:10 种 LaTeX 重音经 mml2omml 落为 limUpp,lim 文本为下列单字符 */
const ACCENT_CHARS = new Set([
  '˙', // ˙ \dot
  '¨', // ¨ \ddot
  '^', //   \hat
  '→', // → \vec
  '‾', // ‾ \bar
  '~', //   \tilde
  'ˇ', // ˇ \check
  '˘', // ˘ \breve
  '´', // ´ \acute
  '`', //   \grave
]);

function childByTag(parent: Element, qname: string): Element | null {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 1 && (node as Element).nodeName === qname) return node as Element;
  }
  return null;
}

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

/**
 * 修复 n-ary 算符(∑ ∏ ∫ 等)的空操作数方框。
 * mml2omml 把 ∑ 的被作用项留在 nary 外面(<m:e/> 为空,被作用项作为后续兄弟节点),
 * Word 会把空的 <m:e> 渲染成一个空白方框。把 nary 紧邻的下一个元素兄弟移入空的
 * <m:e>,消除空白方框 —— nary 的操作数本就渲染在算符右侧,视觉位置不变。
 */
export function fixNaryEmptyOperand(omml: string): string {
  const doc = new DOMParser().parseFromString(omml, 'application/xml');
  // 每次移动都会改变结构,循环直到没有可填充的空 nary;以元素总数为上界防止死循环。
  const limit = doc.getElementsByTagName('*').length + 1;
  for (let guard = 0; guard < limit; guard++) {
    const naries = Array.from(doc.getElementsByTagName('m:nary'));
    let changed = false;
    for (const nary of naries) {
      const e = childByTag(nary, 'm:e');
      if (!e) continue;
      const hasContent = Array.from(e.childNodes).some((n) => n.nodeType === 1);
      if (hasContent) continue;
      // 找紧邻的下一个元素兄弟(跳过空白文本节点)
      let sib = nary.nextSibling;
      while (sib && sib.nodeType !== 1) sib = sib.nextSibling;
      if (!sib) continue;
      e.appendChild(sib); // 移动该兄弟进入 e(自动从原位置脱离)
      changed = true;
      break; // 结构已变,重新查询
    }
    if (!changed) break;
  }
  return new XMLSerializer().serializeToString(doc);
}

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

/** LaTeX → 最终 OMML 字符串;失败返回 null(由调用方决定回退) */
export function latexToOmmlString(latex: string, opts: { display: boolean }): string | null {
  const { inner, boxed } = unwrapBoxed(latex);
  const mathml = temml.renderToString(inner, { displayMode: opts.display, throwOnError: false });
  if (mathml.includes('temml-error')) return null;

  let omml = mml2omml(mathml);
  // 无任何渲染叶子(空 oMath)视为失败
  if (!/<m:r[ >/]/.test(omml)) return null;

  omml = fixAccents(omml);
  omml = fixNaryEmptyOperand(omml);
  if (boxed) omml = wrapWithBorderBox(omml);
  return omml;
}

/** LaTeX → 可注入 Paragraph/inline 的 OMML 组件;失败返回 null */
export function convertLatexToOmml(
  latex: string,
  opts: { display: boolean },
): ImportedXmlComponent | null {
  const omml = latexToOmmlString(latex, opts);
  if (!omml) return null;
  try {
    // fromXmlString 返回一个无名的文档包裹组件(rootKey 为 undefined),
    // 真正的 <m:oMath> 是它的第一个子节点。直接返回包裹组件会序列化出一个
    // Word 无法识别的 <undefined> 元素,导致公式整体不渲染(空白)。
    const wrapper = ImportedXmlComponent.fromXmlString(omml) as unknown as {
      readonly root: readonly ImportedXmlComponent[];
    };
    return wrapper.root[0] ?? null;
  } catch (e) {
    console.warn('OMML 注入失败:', latex, e);
    return null;
  }
}
