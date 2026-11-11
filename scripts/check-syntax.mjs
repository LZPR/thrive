// Check maintained JavaScript only; historical scripts and installed dependencies stay outside the gate.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', '.workbuddy', '.test-sandbox', 'node_modules', 'test-results', 'playwright-report', 'coverage']);

async function collect(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const batches = await Promise.all(entries.map(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return ignored.has(entry.name) ? [] : collect(path);
        }
        return /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
    }));
    return batches.flat();
}

const files = (await collect(root)).sort();
let failed = 0;
for (const path of files) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed += 1;
        console.error(result.stderr || result.error || path);
    }
}
console.log(`Syntax: ${files.length - failed}/${files.length} files passed.`);
process.exitCode = failed ? 1 : 0;
