import { describe, it, expect } from 'vitest';
import { latexToOmmlString } from '@/shared/converters/latex-to-omml';
import fixtures from '../../../docs/superpowers/specs/2026-06-24-word-formula-omml-fixtures.json';

const formulas = fixtures as string[];

describe('真实公式回归(96 条)', () => {
  it('夹具共 96 条公式', () => {
    expect(formulas.length).toBe(96);
  });

  it('display 模式下每条都产出非空 OMML(无静默丢失)', () => {
    const blanks = formulas.filter((f) => latexToOmmlString(f, { display: true }) === null);
    expect(blanks).toEqual([]);
  });

  it('含 \\oint 的公式保留 ∮(不坍缩为 Σ)', () => {
    const oint = formulas.filter((f) => f.includes('\\oint'));
    expect(oint.length).toBeGreaterThan(0);
    for (const f of oint) {
      expect(latexToOmmlString(f, { display: true })!).toContain('∮');
    }
  });

  it('含 \\prod 的公式保留 ∏', () => {
    const prod = formulas.filter((f) => f.includes('\\prod'));
    expect(prod.length).toBeGreaterThan(0);
    for (const f of prod) {
      expect(latexToOmmlString(f, { display: true })!).toContain('∏');
    }
  });

  it('含 \\dot 的公式重音渲染为正确形式(acc 或 groupChr,不残留 limUpp)', () => {
    const dot = formulas.filter((f) => f.includes('\\dot{'));
    expect(dot.length).toBeGreaterThan(0);
    for (const f of dot) {
      const out = latexToOmmlString(f, { display: true })!;
      expect(out).toContain('˙');             // 重音符保留
      expect(out).not.toContain('<m:limUpp'); // 未残留为"极限"形式(已转 acc 或本就是 groupChr)
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
