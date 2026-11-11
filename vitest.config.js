import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const hostStub = fileURLToPath(new URL('./tests/helpers/host.js', import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^(?:\.\.\/)+extensions\.js$/, replacement: hostStub },
            { find: /^(?:\.\.\/)+popup\.js$/, replacement: hostStub },
        ],
    },
    test: {
        include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
        environment: 'node',
        setupFiles: ['tests/helpers/setup.js'],
        restoreMocks: true,
        unstubGlobals: true,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.js'],
            exclude: ['src/ui/**', 'src/platform/**', 'src/app/**', 'src/store.js', 'src/targets.js', 'src/tools.js'],
            reporter: ['text', 'html'],
        },
    },
});
