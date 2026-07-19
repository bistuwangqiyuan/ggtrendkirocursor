import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
    output: 'server',
    vite: {
        plugins: [tailwindcss()],
    },
    integrations: [react()],
    adapter: netlify({
        devFeatures: {
            // When the project is not linked to a Netlify site, the env-var
            // emulation injects an EMPTY env and masks the local shell's
            // process.env (DATABASE_URL etc.), breaking local real-DB testing.
            // Netlify production injects env vars directly, so this emulation
            // is only ever needed for linked-site local dev.
            environmentVariables: false
        }
    })
});
