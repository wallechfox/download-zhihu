import { describe, it, expect } from 'vitest';
import manifest from './manifest';
import pkg from '../package.json';

describe('manifest', () => {
  it('版本号从 package.json 派生(单一来源)', () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
