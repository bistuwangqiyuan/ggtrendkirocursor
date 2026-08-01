import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // The default 5s is a statement about machine speed, not about the code:
        // several suites embed a 2 MB font, render PDFs, or walk a fake snapshot
        // store, and on a laptop with an antivirus scanning node_modules those take
        // seconds. A real hang still fails, just 25 seconds later.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'html'],
            reportsDirectory: 'coverage',
            // Measure the pure business logic the unit suite targets. UI (.astro/.tsx)
            // and Netlify function entrypoints are exercised by the live e2e smoke
            // suite instead, so counting them here would misstate unit coverage.
            include: ['src/lib/**/*.ts'],
        },
    },
});
