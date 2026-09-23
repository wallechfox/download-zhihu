# 发版内容自动化设计

> 日期:2026-06-25
> 状态:已确认,待实现

## 背景与问题

当前 `.github/workflows/release.yml` 在推送 `v*` tag 时会自动:打包扩展 → 发 GitHub Release → 通过官方 API 将 ZIP 安装包推送并发布到 Chrome Web Store 与 Edge Add-ons。

**安装包**已经全自动,但每次发版仍需手动维护两类"内容":

1. **版本号**:`src/manifest.ts` 与 `package.json` 各写一遍版本号(双源),发版前需手动改两处并保证与 tag 一致。
2. **GitHub Release 正文**:目前在 workflow 里写死为固定的安装说明,不包含本次版本的更新日志。更新日志实际手写在 `README.md` 的 `## 更新日志` → `### vX.Y.Z` 小节,但没有任何地方复用它。

## 范围边界(重要)

经核实,**两大商店的官方 API 仅支持上传安装包,不支持修改 listing 文案/截图/更新说明**:

- Chrome Web Store API v2:仅支持上传新包、发布、灰度比例控制;listing 描述、截图、隐私信息必须在 Developer Dashboard 手动维护。
  - 来源:<https://developer.chrome.com/docs/webstore/using-api>、<https://developer.chrome.com/blog/cws-api-v2>
- Edge Add-ons API:官方明确 "There is no API for ... updating a product's metadata, such as the description";描述/截图等只能在 Partner Center 手动维护。
  - 来源:<https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api>、<https://github.com/microsoft/MicrosoftEdge-Extensions/discussions/143>

因此**本设计明确不包含**商店 listing 描述/截图/商店内 changelog 的自动化(官方 API 不支持;浏览器自动化方案脆弱、易触发风控、踩 ToS,已排除)。

本设计**仅自动化两项**:
1. manifest 版本号
2. GitHub Release 正文

## 设计方案

### A. 版本号自动化 —— 单一来源 + npm 标准工具

**目标**:发版者不再手改任何版本号。

1. **消灭双源**:修改 `src/manifest.ts`,让它从 `package.json` 读取版本号,使 `package.json` 成为版本号的**唯一来源**。

   ```ts
   import pkg from '../package.json';

   export default defineManifest({
     // ...
     version: pkg.version,
     // ...
   });
   ```

   - 需确认 `tsconfig.json` 允许 `resolveJsonModule`(Vite/CRXJS 构建通常已支持;实现阶段验证)。

2. **用 `npm version` 发版**:`npm version minor`(或 `patch` / `major`)会自动:
   - bump `package.json` 的版本号
   - 创建一条 version commit
   - 打好 `v<新版本>` 的 git tag

   发版者只需 `git push --follow-tags` 推送。

3. **CI 安全网**:`release.yml` 中原 "Verify manifest version matches tag" 步骤改为校验 **`package.json` 版本 == tag 版本**,不一致则 fail。构建产物中的 manifest 版本由 `package.json` 派生,无需再单独校验 `src/manifest.ts`。

**备选(未采用)**:写 `scripts/release.mjs` 同时改两个文件 —— 多一份脚本、效果等同,被单一来源方案取代。

### B. GitHub Release 正文自动化 —— 复用 README 更新日志

**目标**:Release 正文自动带上本次版本的更新日志,发版者不再手写正文。

1. **数据源复用**:更新日志继续手写在 `README.md` 的 `### vX.Y.Z` 小节(质量高于 commit 堆砌,不改变现有习惯)。

2. **CI 抽取步骤**:`release.yml` 新增一步,从 `README.md` 抽取 `### v<本次版本>` 到下一个 `###` 之间的内容,作为 Release 正文的"更新内容"部分。

3. **正文组装**:Release body = 抽取出的更新日志 + 现有的固定安装说明(Chrome/Edge 加载步骤)作为页脚。

4. **防呆闸门**:若 `README.md` 中**找不到**当前版本对应的 `### v<版本>` 小节,CI **直接 fail**,强制发版前先补好更新日志。

**备选(未采用)**:单独维护 `CHANGELOG.md` —— 与 README 现有日志重复维护,被复用 README 方案取代。

## 新发版流程

| 步骤 | 操作 | 谁来做 |
|---|---|---|
| 1 | 在 `README.md` 写好 `### vX.Y.Z` 更新日志 → commit | 人 |
| 2 | `npm version minor`(自动 bump package.json + commit + 打 tag) | 人(一条命令) |
| 3 | `git push --follow-tags` | 人(一条命令) |
| 4 | 校验版本 == tag → 构建(manifest 版本自动来自 package.json)→ 打包 | CI |
| 5 | 发 GitHub Release(正文 = README 日志 + 安装说明) | CI |
| 6 | 推送并发布到 Chrome Web Store / Edge Add-ons | CI |

发版者**不再需要**:手改 `src/manifest.ts` 版本、手改 `package.json` 版本(由 npm version 处理)、手写 GitHub Release 正文。

## 受影响文件

- `src/manifest.ts` —— version 改为从 `package.json` 派生
- `tsconfig.json` —— 确认 `resolveJsonModule`(可能已启用)
- `.github/workflows/release.yml` ——
  - 改写版本校验步骤(grep `src/manifest.ts` → 校验 `package.json`)
  - 新增"从 README 抽取更新日志"步骤
  - `github-release` job 的 body 改为"抽取的日志 + 安装说明"
- `README.md` —— 维护习惯不变(仍手写 `### vX.Y.Z`),可补充发版流程说明

## 错误处理与边界

- README 缺少当前版本日志小节 → CI fail(防呆)。
- `package.json` 版本与 tag 不一致 → CI fail(安全网)。
- 抽取脚本需正确处理:版本小节为最后一节(无后续 `###`)、版本号中的 `.` 在正则中需转义。

## 不在本次范围

- 商店 listing 描述 / 截图 / 商店内更新说明的自动化(官方 API 不支持)。
- 自动生成更新日志(继续手写,质量更高)。
