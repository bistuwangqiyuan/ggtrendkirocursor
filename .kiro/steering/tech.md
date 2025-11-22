# Tech Stack

## Core Framework

- **Astro.js** (v5.15.0+): Static site generator with SSR support
- **Node.js**: v18.20.8+ required
- **TypeScript**: Configured with React JSX support

## Integrations & Adapters

- `@astrojs/netlify`: Netlify adapter for deployment
- `@astrojs/react`: React integration for interactive components

## Styling

- **Tailwind CSS v4**: Utility-first CSS framework
- `@tailwindcss/vite`: Vite plugin for Tailwind
- `@fontsource-variable/inter`: Inter variable font
- Custom theme variables defined in `src/styles/globals.css`
- Noise texture background pattern

## Key Libraries

- `@netlify/blobs`: Netlify Blobs storage API
- `@netlify/functions`: Netlify Functions runtime
- `blobshape`: SVG blob shape generation
- `marked` + `marked-shiki`: Markdown parsing with syntax highlighting
- `unique-names-generator`: Random name generation

## UI Framework

- **React 19**: For interactive components (`.tsx` files)
- **Astro Components**: For static/SSR pages (`.astro` files)

## Common Commands

```bash
# Install dependencies
npm install

# Development server (localhost:4321)
npm run dev
# or
npm start

# Build for production
npm run build

# Preview production build locally
npm run preview

# Run Astro CLI commands
npm run astro [command]
```

## Deployment

- Platform: **Netlify**
- Link local project: `netlify link`
- Automatic deployment via Git integration
