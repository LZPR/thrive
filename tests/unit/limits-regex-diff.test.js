import { it, expect } from 'vitest';
import { LIMIT_SPECS, clampLimit, readLimits } from '../../src/core/limits.js';
import { compilePattern, replaceIn, scan } from '../../src/core/regex.js';
import { buildDiffRows } from '../../src/core/diff.js';

it('clamps every setting and never lets a soft limit exceed its hard limit', () => {
    for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
        expect(clampLimit(key, 0)).toBe(spec.default);
        expect(clampLimit(key, NaN)).toBe(spec.default);
        expect(clampLimit(key, 999999)).toBe(spec.max);
        expect(clampLimit(key, 0.1)).toBe(spec.min);
    }
    const limits = readLimits({ softLimitEntry: 5000, hardLimitEntry: 400, softLimitDesc: 9000, hardLimitDesc: 500 });
    expect(limits.softLimitEntry).toBe(400);
    expect(limits.softLimitDesc).toBe(500);
});

it('counts all matches while limiting returned excerpts and requires replaceAll for ambiguous writes', () => {
    const compiled = compilePattern('北境', 'i');
    const read = scan('北境，北境，北境', compiled, { maxMatches: 1 });
    expect(read.count).toBe(3);
    expect(read.matches).toHaveLength(1);
    expect(replaceIn('北境，北境', compiled, '南境', false).ok).toBe(false);
    expect(replaceIn('北境，北境', compiled, '南境', true)).toMatchObject({ ok: true });
});

it('represents changed lines as removals and additions without executing embedded HTML', () => {
    const rows = buildDiffRows('旧内容\n相同', '<script>新内容</script>\n相同');
    expect(rows.some(row => row.type === 'del')).toBe(true);
    expect(rows.some(row => row.type === 'add')).toBe(true);
});
