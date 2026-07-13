import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
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
