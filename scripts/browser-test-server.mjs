// Local fixture server for Playwright. It serves the real extension plus explicit host doubles.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/scripts/extensions/third-party/thrive/';
const hostPaths = new Set([
    '/world-info.js', '/scripts/world-info.js',
    '/extensions.js', '/popup.js', '/preset-manager.js',
    '/scripts/extensions.js', '/scripts/popup.js', '/scripts/preset-manager.js',
    '/slash-commands/SlashCommandParser.js', '/slash-commands/SlashCommand.js', '/slash-commands/SlashCommandArgument.js',
    '/scripts/slash-commands/SlashCommandParser.js', '/scripts/slash-commands/SlashCommand.js', '/scripts/slash-commands/SlashCommandArgument.js',
]);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/favicon.ico') {
            response.writeHead(204).end();
            return;
        }
        let target;
        if (url.pathname === '/' || url.pathname === '/health') {
            target = 'tests/fixtures/browser.html';
        } else if (hostPaths.has(url.pathname)) {
            // One module identity shares the fixture state across host entry points.
            response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
            response.end("export * from '/host-fixture.js';");
            return;
        } else if (url.pathname === '/host-fixture.js') {
            target = 'tests/fixtures/browser-host.js';
        } else if (url.pathname.startsWith(prefix)) {
            target = decodeURIComponent(url.pathname.slice(prefix.length));
            if (!/^(src\/.*\.js|index\.js|settings\.html|style\.css|manifest\.json)$/.test(target)) {
                throw new Error('Unsupported fixture asset');
            }
        } else {
            response.writeHead(404).end();
            return;
        }
        const path = resolve(root, target);
        const local = relative(root, path);
        if (local.startsWith('..') || isAbsolute(local)) {
            throw new Error('Path outside fixture root');
        }
        const data = await readFile(path);
        response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(data);
    } catch {
        response.writeHead(404).end();
    }
});

server.listen(Number(process.env.THRIVE_TEST_PORT || 4178), '127.0.0.1', () => {
    console.log(`Thrive fixture server: http://127.0.0.1:${server.address().port}`);
});
