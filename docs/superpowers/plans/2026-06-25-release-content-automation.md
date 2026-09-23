# 发版内容自动化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打 tag 发版时自动确定 manifest 版本号、并用 README 更新日志自动生成 GitHub Release 正文,发版者不再手改版本或手写正文。

**Architecture:** 版本号收敛为单一来源 `package.json`,`src/manifest.ts` 从中派生;发版用 `npm version` 一条命令完成 bump+commit+tag。GitHub Release 正文由一个可单测的纯 JS 抽取器从 `README.md` 的 `### v<版本>` 小节提取,在 CI 的 `build` job(已 checkout)生成正文文件,随 artifact 传给 `github-release` job。

**Tech Stack:** GitHub Actions、Node 20(ESM `.mjs`,无新增依赖)、Vitest、CRXJS `defineManifest`、Vite。

## Global Constraints

- 版本号唯一来源:`package.json` 的 `version` 字段;`src/manifest.ts` 与构建产物均从其派生。
- `npm version` 默认 tag 前缀为 `v`,与 workflow 触发器 `tags: ['v*']` 一致,无需额外配置。
- 不新增运行时依赖;抽取器用原生 Node ESM(`.mjs`),CI 用 `node` 直接执行。
- 仅自动化「manifest 版本号」与「GitHub Release 正文」两项;**不**触碰商店 listing(Chrome/Edge 官方 API 不支持)。
- commit message 用 Conventional Commits;**禁止** `Co-Authored-By` 行(用户全局规则)。
- 抽取器正则匹配 `^### v<版本>\s*$`,版本号中的 `.` 必须转义;小节内容收集到下一个 `## ` 或 `### ` 标题或文件结尾为止;找不到或为空时抛错。

---

### Task 1: README 更新日志抽取器(纯函数 + CLI)

**Files:**
- Create: `scripts/extract-changelog.mjs`
- Test: `scripts/extract-changelog.test.ts`
- Modify: `vitest.config.ts:11`(`test.include` 增加 `scripts/**/*.test.ts`)

**Interfaces:**
- Produces:
  - `export function extractChangelog(readme: string, version: string): string` —— 返回该版本小节去除标题行后的正文(已 `trim`);找不到该小节抛 `Error`,小节为空抛 `Error`。
  - CLI:`node scripts/extract-changelog.mjs <version> [readmePath=README.md]`,成功时把正文写入 stdout;version 缺失退出码 2,抽取失败退出码 1。

- [ ] **Step 1: 让 vitest 能发现 scripts 下的测试**

修改 `vitest.config.ts`,把 `include` 从单条改为两条:

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
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: 写失败测试**

创建 `scripts/extract-changelog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractChangelog } from './extract-changelog.mjs';

const README = `# 标题

## 更新日志

### v3.2.0

- 新功能 A
- 修复 B

### v3.1.0

- 旧功能 C

## 其它章节

- 不应被抽到
`;

describe('extractChangelog', () => {
  it('抽取指定版本小节的正文(不含标题行,首尾去空白)', () => {
    expect(extractChangelog(README, '3.2.0')).toBe('- 新功能 A\n- 修复 B');
  });

  it('在下一个 ### 标题处停止', () => {
    expect(extractChangelog(README, '3.1.0')).toBe('- 旧功能 C');
  });

  it('最后一个小节抽到文件结尾(遇到 ## 停止)', () => {
    const tail = `### v1.0.0\n\n- 首发\n`;
    expect(extractChangelog(tail, '1.0.0')).toBe('- 首发');
  });

  it('版本号中的点号按字面匹配,不当通配符', () => {
    // '3x2x0' 不应匹配 '### v3.2.0'
    expect(() => extractChangelog(README, '3x2x0')).toThrow(/not found/);
  });

  it('找不到对应版本小节时抛错', () => {
    expect(() => extractChangelog(README, '9.9.9')).toThrow(/9\.9\.9/);
  });

  it('小节存在但内容为空时抛错', () => {
    const empty = `### v2.0.0\n\n### v1.0.0\n\n- x\n`;
    expect(() => extractChangelog(empty, '2.0.0')).toThrow(/empty/);
  });
});
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `npx vitest run scripts/extract-changelog.test.ts`
Expected: FAIL —— 报错找不到 `./extract-changelog.mjs` 模块。

- [ ] **Step 4: 写最小实现**

创建 `scripts/extract-changelog.mjs`:

```js
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * 从 README 内容中抽取指定版本的更新日志小节正文。
 * @param {string} readme 完整 README markdown 文本
 * @param {string} version 不含前导 'v' 的版本号,如 "3.2.0"
 * @returns {string} 去除标题行、首尾空白后的小节正文
 * @throws 当小节不存在或为空时抛错
 */
export function extractChangelog(readme, version) {
  const lines = readme.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^### v${escaped}\\s*$`);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error(`Changelog section "### v${version}" not found in README.md`);
  }

  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^###\s/.test(lines[i])) break;
    body.push(lines[i]);
  }

  const text = body.join('\n').trim();
  if (!text) {
    throw new Error(`Changelog section "### v${version}" is empty in README.md`);
  }
  return text;
}

// CLI:仅在被直接执行时运行,被 import 时不执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  const readmePath = process.argv[3] ?? 'README.md';
  if (!version) {
    console.error('Usage: node scripts/extract-changelog.mjs <version> [readmePath]');
    process.exit(2);
  }
  try {
    const readme = await readFile(readmePath, 'utf8');
    process.stdout.write(extractChangelog(readme, version));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `npx vitest run scripts/extract-changelog.test.ts`
Expected: PASS(6 个用例全过)。

- [ ] **Step 6: 用真实 README 验证 CLI**

Run: `node scripts/extract-changelog.mjs 3.1.0`
Expected: 打印当前 `README.md` 中 `### v3.1.0` 小节的正文(以 `- **新增个人主页导出**` 开头),退出码 0。

Run: `node scripts/extract-changelog.mjs 9.9.9; echo "exit=$?"`
Expected: 输出 `... "### v9.9.9" not found ...` 且 `exit=1`。

- [ ] **Step 7: 提交**

```bash
git add scripts/extract-changelog.mjs scripts/extract-changelog.test.ts vitest.config.ts
git commit -m "feat: 新增 README 更新日志抽取器(供发版正文复用)"
```

---

### Task 2: manifest 版本号收敛为单一来源

**Files:**
- Modify: `src/manifest.ts:1-7`(新增 import,`version` 改为派生)
- Test: `src/manifest.test.ts`

**Interfaces:**
- Consumes:`package.json` 的 `version` 字段。
- Produces:`src/manifest.ts` 默认导出的 manifest,其 `version` 恒等于 `package.json` 的 `version`。

- [ ] **Step 1: 写失败测试**

创建 `src/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import manifest from './manifest';
import pkg from '../package.json';

describe('manifest', () => {
  it('版本号从 package.json 派生(单一来源)', () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/manifest.test.ts`
Expected: FAIL —— 当前 `src/manifest.ts` 里 `version` 是写死的 `'3.1.0'` 字符串字面量;只要它与 `package.json` 一致测试会"假通过",因此**先把 package.json 改成不同的值制造红灯**:临时执行 `node -e "const fs=require('fs');const p=require('./package.json');p.version='9.9.9';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"`,再跑测试,Expected: FAIL(`'3.1.0'` !== `'9.9.9'`)。记下该红灯后**立即用 `git checkout package.json` 还原**。

- [ ] **Step 3: 写最小实现**

修改 `src/manifest.ts` 顶部的 import 与 `version` 字段(其余字段保持不变):

```ts
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: '知乎文章下载器',
  description: '将知乎文章、回答、问题、想法、收藏夹导出为 Markdown 或 Word (.docx) 文件',
  version: pkg.version,
  permissions: ['activeTab', 'storage', 'unlimitedStorage', 'scripting'],
  host_permissions: [
    'https://www.zhihu.com/*',
    'https://zhuanlan.zhihu.com/*',
  ],
  background: {
    service_worker: 'src/background/index.ts',
  },
  icons: {
    '16': 'src/assets/icons/icon16.png',
    '48': 'src/assets/icons/icon48.png',
    '128': 'src/assets/icons/icon128.png',
  },
  content_scripts: [
    {
      matches: [
        'https://www.zhihu.com/*',
        'https://zhuanlan.zhihu.com/*',
      ],
      js: ['src/content/index.tsx'],
      run_at: 'document_idle',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['src/assets/icons/icon48.png', 'src/content/fetch-bridge.js'],
      matches: ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*'],
    },
  ],
});
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/manifest.test.ts`
Expected: PASS(`manifest.version` === `pkg.version` === `'3.1.0'`)。

- [ ] **Step 5: 构建并验证产物版本来自 package.json**

Run: `npm run build && node -p "require('./dist/manifest.json').version"`
Expected: 打印 `3.1.0`(与 `package.json` 一致)。

二次验证派生关系(改 package.json → 产物随之变):

Run:
```bash
node -e "const fs=require('fs');const p=require('./package.json');p.version='3.1.1';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')" \
  && npm run build && node -p "require('./dist/manifest.json').version"
```
Expected: 打印 `3.1.1`。然后还原:`git checkout package.json`。

- [ ] **Step 6: 提交**

```bash
git add src/manifest.ts src/manifest.test.ts
git commit -m "refactor: manifest 版本号改为从 package.json 派生(单一来源)"
```

---

### Task 3: 改写 release workflow(版本校验 + Release 正文)

**Files:**
- Modify: `.github/workflows/release.yml:34-41`(版本校验步骤)
- Modify: `.github/workflows/release.yml:46-59`(生成正文 + 上传)
- Modify: `.github/workflows/release.yml:61-93`(`github-release` job 改用 `body_path`)

**Interfaces:**
- Consumes:`scripts/extract-changelog.mjs` 的 CLI(Task 1);`package.json.version`(Task 2)。
- Produces:`build` job 额外产出 `release-body.md`,随 `extension-zip` artifact 一同上传;`github-release` 用其作为 Release 正文。

- [ ] **Step 1: 把版本校验从 src/manifest.ts 改为 package.json**

将 `.github/workflows/release.yml` 中「Verify manifest version matches tag」步骤(第 34-41 行)整体替换为:

```yaml
      - name: Verify package.json version matches tag
        run: |
          PKG_VERSION=$(node -p "require('./package.json').version")
          TAG_VERSION=${{ steps.version.outputs.VERSION }}
          if [ "$PKG_VERSION" != "$TAG_VERSION" ]; then
            echo "::error::package.json version ($PKG_VERSION) does not match tag (v$TAG_VERSION)"
            exit 1
          fi
```

- [ ] **Step 2: 新增"生成 Release 正文"步骤**

在 `build` job 的「Build ZIP」步骤(原第 46-54 行)之后、「Upload artifact」之前,插入以下步骤。它先抽取 README 日志(README 缺该版本小节会因退出码 1 使 CI 失败),再拼接安装说明页脚:

```yaml
      - name: Generate release notes
        run: |
          set -e
          {
            node scripts/extract-changelog.mjs "${{ steps.version.outputs.VERSION }}" README.md
            cat <<EOF

## 安装方法

### Chrome
1. 下载下方的 \`${{ steps.build.outputs.ZIP_NAME }}\` 文件
2. 解压到一个固定位置
3. 打开 Chrome，访问 \`chrome://extensions/\`
4. 右上角开启「开发者模式」
5. 点击「加载已解压的扩展程序」，选择解压后的文件夹

### Edge
1. 下载下方的 \`${{ steps.build.outputs.ZIP_NAME }}\` 文件
2. 解压到一个固定位置
3. 打开 Edge，访问 \`edge://extensions/\`
4. 左下角开启「开发人员模式」
5. 点击「加载解压缩的扩展」，选择解压后的文件夹

访问知乎任意文章/回答/收藏夹/专栏页面，右下角会出现蓝色浮动按钮。
EOF
          } > release-body.md
          echo "::group::release-body.md"
          cat release-body.md
          echo "::endgroup::"
```

- [ ] **Step 3: artifact 同时上传 zip 与正文**

将「Upload artifact」步骤(原第 55-59 行)的 `path` 改为多行,纳入 `release-body.md`:

```yaml
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: extension-zip
          path: |
            ${{ steps.build.outputs.ZIP_NAME }}
            release-body.md
```

- [ ] **Step 4: `github-release` job 改用 body_path**

将 `github-release` job(原第 61-93 行)的 `Create GitHub Release` 步骤里写死的 `body: | ...` 整块替换为 `body_path`,其余不变:

```yaml
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          name: v${{ needs.build.outputs.version }}
          body_path: release-body.md
          files: ${{ needs.build.outputs.zip_name }}
```

(`download-artifact` 会把 `release-body.md` 与 zip 一并取到工作目录,故 `body_path: release-body.md` 可直接命中。)

- [ ] **Step 5: 本地复跑正文生成,确认拼接结果正确**

模拟 CI 的拼接逻辑(用当前版本 3.1.0、当前 README):

Run:
```bash
ZIP_NAME="DownloadZhihu-v3.1.0.zip"; \
{ node scripts/extract-changelog.mjs 3.1.0 README.md; printf '\n\n## 安装方法\n(install steps...)\n'; } | head -20
```
Expected: 先输出 `### v3.1.0` 小节正文(以 `- **新增个人主页导出**` 开头),空行后接 `## 安装方法`。无报错、退出码 0。

- [ ] **Step 6: 校验 workflow YAML 合法**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: 打印 `yaml ok`(无缩进/语法错误)。

- [ ] **Step 7: 提交**

```bash
git add .github/workflows/release.yml
git commit -m "ci: 版本校验改用 package.json,Release 正文复用 README 更新日志"
```

---

### Task 4: 文档化新发版流程

**Files:**
- Modify: `README.md`(在「## 更新日志」之前新增「## 发布流程(维护者)」小节)

**Interfaces:**
- Consumes:Task 1-3 落地的流程。
- Produces:面向维护者的发版步骤说明。

- [ ] **Step 1: 新增发布流程说明**

在 `README.md` 的 `## 更新日志` 标题**之前**插入以下小节(确保位于该标题上方,避免被抽取器当作 `v` 小节正文):

```markdown
## 发布流程(维护者)

1. 在下方「更新日志」新增 `### vX.Y.Z` 小节并写明本次变更(CI 会直接复用为 GitHub Release 正文;缺失则发布失败)。
2. 提交改动:`git commit -am "docs: vX.Y.Z 更新日志"`。
3. 升版本并打 tag(三选一):`npm version patch` / `npm version minor` / `npm version major` —— 自动 bump `package.json`、提交并打好 `vX.Y.Z` tag(`src/manifest.ts` 版本由 `package.json` 自动派生,无需手改)。
4. 推送:`git push --follow-tags`。
5. 其余交给 CI:校验版本 == tag → 构建打包 → 发 GitHub Release(正文 = 更新日志 + 安装说明)→ 发布到 Chrome Web Store / Edge Add-ons。

```

- [ ] **Step 2: 验证抽取器不受新小节影响**

Run: `node scripts/extract-changelog.mjs 3.1.0`
Expected: 仍只输出 `### v3.1.0` 小节正文,不含「发布流程」内容(因为抽取在 `## 发布流程` 处不会越界——它只从 `### v3.1.0` 开始)。退出码 0。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: 补充维护者发布流程说明"
```

---

## Self-Review

**Spec coverage:**
- A. 版本号单源 → Task 2(manifest 派生)+ Task 3 Step 1(CI 校验改 package.json)+ Task 4(`npm version` 流程文档)✅
- B. Release 正文复用 README → Task 1(抽取器)+ Task 3 Step 2-4(生成正文、上传、body_path)✅
- 防呆:README 缺版本小节 → 抽取器退出码 1 → CI 失败(Task 1 Step 6 验证、Task 3 Step 2 依赖)✅
- 安全网:package.json 版本 != tag → CI 失败(Task 3 Step 1)✅
- 边界:点号转义、末节抽到结尾、空小节抛错 → Task 1 测试覆盖 ✅
- tsconfig `resolveJsonModule` 已为 `true`,无需改动(实现时无额外步骤)✅

**Placeholder scan:** 无 TBD/TODO;所有代码步骤含完整代码;命令含预期输出。✅

**Type consistency:** `extractChangelog(readme, version)` 签名在 Task 1 定义、Task 3 经 CLI 调用一致;`manifest.version` / `pkg.version` 命名贯穿 Task 2 一致。✅
