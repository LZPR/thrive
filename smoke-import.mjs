// Link and evaluate the entry point and every source module without a running SillyTavern.
// VM modules keep host stubs in memory: no copied source tree or files outside this repository.
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const context = createContext({
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    TextEncoder,
    structuredClone,
    // Registering the real ready callback would start the extension. Linking must stay offline.
    jQuery: () => {},
    document: { getElementById: () => null, dispatchEvent: () => true },
    CustomEvent: class {
        constructor(type, options) {
            this.type = type;
            this.detail = options?.detail;
        }
    },
});
const modules = new Map();
const hostExports = {
    'world-info.js': { selected_world_info: [], world_info: {} },
    'extensions.js': { getContext: () => { throw new Error('Host context accessed during import'); } },
    'popup.js': { POPUP_RESULT: {}, POPUP_TYPE: {}, callGenericPopup: () => {} },
    'preset-manager.js': { getPresetManager: () => null },
};

async function load(path) {
    if (modules.has(path)) {
        return modules.get(path);
    }
    const pending = (async () => {
        const local = relative(root, path);
        if (local === '..' || local.startsWith(`..\\`) || local.startsWith('../') || isAbsolute(local)) {
            const exports = hostExports[basename(path)];
            assert.ok(exports, `Unstubbed host module: ${path}`);
            return new SyntheticModule(Object.keys(exports), function () {
                for (const [name, value] of Object.entries(exports)) {
                    this.setExport(name, value);
                }
            }, { context, identifier: path });
        }
        return new SourceTextModule(await readFile(path, 'utf8'), {
            context,
            identifier: path,
        });
    })();
    modules.set(path, pending);
    return pending;
}

async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const batches = await Promise.all(entries.map(entry => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : (entry.name.endsWith('.js') ? [path] : []);
    }));
    return batches.flat();
}

const files = [resolve(root, 'index.js'), ...(await sourceFiles(resolve(root, 'src'))).sort()];
for (const path of files) {
    const module = await load(path);
    if (module.status === 'unlinked') {
        await module.link((specifier, parent) => {
            assert.ok(specifier.startsWith('.'), `Browser source requires a relative import: ${specifier}`);
            return load(resolve(dirname(parent.identifier), specifier));
        });
    }
    if (module.status === 'linked') {
        await module.evaluate();
    }
}

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
for (const asset of [manifest.js, manifest.css, 'settings.html']) {
    await readFile(resolve(root, asset));
}
console.log(`ESM smoke: ${files.length} modules linked and evaluated; manifest assets exist.`);
