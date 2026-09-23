# Word 公式导出重构:OMML 直接注入

- **日期**:2026-06-24
- **状态**:已批准设计,待实现计划
- **关联文件**:`src/shared/converters/html-to-docx.ts`、`src/shared/converters/zhihu-html-utils.ts`、`src/vendor/mathml2omml.min.js`
- **测试夹具**:`docs/superpowers/specs/2026-06-24-word-formula-omml-fixtures.json`(96 条真实公式,来自一篇 Berry 相位文章)

## 背景与问题

知乎文章导出为 Word(.docx)时,公式恢复质量差。当前管线:

```
LaTeX(data-tex) → temml(LaTeX→MathML) → mml2omml(MathML→OMML)
  → 手写 parseOmmlToDocxMath(OMML→docx Math 对象) → docx 渲染
```

用 96 条真实公式实测,定位到分布在三个环节的缺陷(括号内为本文受影响条数):

| # | 严重度 | 问题 | 影响 | 出错环节 |
|---|---|---|---|---|
| 1 | 严重 | temml 调用未传 `displayMode` → `\begin{equation}/\begin{split}` 多行推导在行内模式下报 ParseError,temml 返回 error span,mml2omml 得到空 OMML → Word 中**整条公式空白消失** | 2 条关键多行推导(公式 90/91) | temml 调用 `html-to-docx.ts:135` |
| 2 | 严重 | `convertOmmlNary` 只把 ∫∬∭ 当积分,其余一律当 Σ → `\oint`(环路积分)、`\prod`(连乘)**错误渲染为 Σ 求和号** | 5 条 | 手写转换器 |
| 3 | 中 | 转换器跳过 `rPr` 下 `nor`/`sty` → `\mathbf`/`\mathcal`/`\text`/`\operatorname` 退化为默认斜体 | 19 条 | 手写转换器 |
| 4 | 中 | `\dot \vec \hat \bar` 等经 mml2omml 变成 `m:limUpp`(上极限)而非 `m:acc`(重音)→ 重音符以极限小字浮在上方,位置/大小都不对 | 全文海量 | mml2omml |
| 5 | 中 | 多行公式即使修了 #1,产物是 `m:m`(矩阵)/`m:mr`,手写 switch 不支持 → 落 default 分支按纯文本拼接 → 乱 | 多行推导 | 手写转换器 |
| 6 | 低 | `\boxed{}` 方框丢失(mml2omml 不支持 menclose,只保留内容);框信息在 mml2omml 阶段丢失,OMML 阶段无法恢复 | 6 条加框的关键结论公式 | mml2omml |
| 7 | 低 | `groupChr`、`argPr` 未处理,落 default 分支 | 个别 | 手写转换器 |

### 核心根因

手写的 stage-3(OMML→docx `Math` 对象)**既冗余又有损**:mml2omml 已产出合法 OMML,而 docx 的 `Math*` 对象最终也只是再序列化回 OMML(OMML→拆对象→再拼回 OMML);手写 switch 只覆盖约 12 种元素,其余一律降级为纯文本——这是 #2/#3/#5/#7 的共同来源。

## 方案

用 `docx` 库的 `ImportedXmlComponent.fromXmlString()`(已在 `node_modules/docx/dist/index.d.ts:1422` 确认)把 mml2omml 产出的 OMML **原样注入**文档,绕过整个手写转换器。原型已验证:注入 `\oint_C \mathbf{A}\cdot d\mathbf{r}` 后,生成的 `word/document.xml` 中 `chr m:val="∮"` 原样保留,`\mathbf` 的粗体由 Unicode 数学粗体码位(𝐀)承载并带过去。

剩余的 #4/#6 是 mml2omml 库局限,注入解决不了,需额外后处理(本次范围包含)。

### 1. 架构变更

- **删除**手写的 `parseOmmlToDocxMath` 及约 15 个 `convertOmml*` 辅助函数(`html-to-docx.ts:144–380`,约 240 行),以及随之不再需要的 `Math*` import(`MathFraction`、`MathSum`、`MathIntegral` 等)。
- **新建**聚焦模块 `src/shared/converters/latex-to-omml.ts`,单一职责:LaTeX → 可注入的 OMML 组件;`html-to-docx.ts` 其余逻辑不变。
- 新签名:

```ts
export function convertLatexToOmml(
  latex: string,
  opts: { display: boolean },
): ImportedXmlComponent | null;
```

### 2. 新管线

```
LaTeX
 → 预处理 unwrapBoxed:检测 latex 整体是否为 \boxed{X}            (#6)
 → temml.renderToString(inner, { displayMode: opts.display, throwOnError: false })   (#1)
 → 若结果含 temml-error span 或后续 OMML 为空 → 返回 null,由调用方走失败回退(第 4 节)
 → mml2omml(mathml)
 → 后处理 fixAccents:把 lim 文本 ∈ 重音集的 <m:limUpp> 改写为 <m:acc>   (#4)
 → 后处理:若 boxed,把 <m:oMath> 的 body 包进 <m:borderBox><m:e>…</m:e></m:borderBox>   (#6)
 → ImportedXmlComponent.fromXmlString(omml)         (#2/#3/#5/#7 自动解决)
```

- **行内公式**(`collectInlineElements` 路径,`html-to-docx.ts:478` 附近)传 `display:false`。
- **块级公式**(block 路径,`html-to-docx.ts:581` 附近)传 `display:true`。

#### #4 重音集(已实测)

10 种重音全部以 `m:limUpp` + 单字符 `m:lim` 出现,字符映射:

| LaTeX | lim 字符 |
|---|---|
| `\dot` | `˙` |
| `\ddot` | `¨` |
| `\hat` | `^` |
| `\vec` | `→` |
| `\bar` | `‾` |
| `\tilde` | `~` |
| `\check` | `ˇ` |
| `\breve` | `˘` |
| `\acute` | `´` |
| `\grave` | `` ` `` |

`fixAccents` 规则:`<m:limUpp>` 的 `<m:lim>` 恰为单个 `<m:r><m:t>` 且文本 ∈ 上述字符集 → 重写为 `<m:acc><m:accPr><m:chr m:val="<字符>"/></m:accPr><m:e>…原 e…</m:e></m:acc>`。误判风险极低(这些字符不会作为真实上极限出现)。

#### #6 boxed

temml 把 `\boxed{X}` 渲染为带 `style="…border:1px solid;"` 的 `<mrow>`,mml2omml 丢样式 → 框丢失。由于框信息在 mml2omml 阶段不可逆地丢失,采用 **LaTeX 层**处理:

- `unwrapBoxed(latex)`:若 `latex.trim()` 整体匹配 `^\\boxed\s*\{ … \}$`(花括号配对),剥掉 `\boxed{}`,记录 `boxed=true`。
- mml2omml 产出后,若 `boxed`,把 `<m:oMath>` 的直接子节点包进 `<m:borderBox><m:e>…</m:e></m:borderBox>`。
- 非整体 boxed(嵌在更大公式中的 `\boxed`,本文未出现)暂不处理,退化为无框(等同现状),不报错。

### 3. 注入与命名空间

- `ImportedXmlComponent.fromXmlString` 原样保留 `oMath` 上的 `xmlns:m`/`xmlns:w` 冗余声明,Word 正常解析(已验证)。
- 包裹位置不变:inline 时注入组件作为 paragraph `children` 的一员混在 `TextRun` 之间;block 时居中独立段落。仅把原来的 `new DocxMath({ children: mathRuns })` 替换为注入组件。

### 4. 失败回退(新增,消除"静默消失")

当 temml 返回 error span 或 OMML 为空时,`convertLatexToOmml` 返回 `null`;调用方**不再静默丢弃**,改为输出可见回退:

- 行内:`$<原始 LaTeX>$`,等宽字体 + 灰底(复用现有 code run 的 `Consolas` + `E8E8E8` shading)。
- 块级:独立段落,同样等宽 + 灰底。

保证内容不丢失、便于人工核对。

### 5. 影响面

- `html-to-markdown.ts`:**不动**(Markdown 保留原始 LaTeX,本就正确)。
- `zhihu-html-utils.ts` 的 `getLatex`/`isMath`/`isInlineMath`:**不动**。
- `html-to-docx.ts`:删手写转换器、改两处调用点、调整 import、加失败回退。
- `src/vendor/mathml2omml.min.js`、`lib/` 同名构建产物:按现有 build 流程同步,不手改。

## 验证

- **回归脚本**(置于 scratchpad 或 `test/`):载入 96 条夹具 + 针对性 case(`\oint`、`\prod`、`\dot`、`\boxed{…}`、`\begin{equation}\begin{split}`),对每条断言:
  - 0 条产生空 OMML(#1)。
  - `\oint`/`\prod` 的 `chr` 值在最终 OMML 中保留(#2)。
  - `\dot` 等产出 `<m:acc>` 而非 `<m:limUpp>`(#4)。
  - `\boxed{…}` 产出 `<m:borderBox>`(#6)。
- **人工**:生成 .docx 在 Word 打开,抽检关键公式(多行推导、boxed 结论、含 ∮/∏ 的式子、含 `\dot`/`\mathbf` 的式子)。

## 范围外(后续)

- 嵌在更大公式中间的局部 `\boxed`。
- mml2omml 其它 menclose 记号(`\cancel`、`\overline` 横线框等)。
- Markdown 导出侧的公式表现(当前保留原始 LaTeX,无需改)。
