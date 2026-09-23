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
