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
