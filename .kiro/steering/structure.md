# Project Structure

## Root Configuration

- `astro.config.mjs`: Astro configuration with Netlify adapter, React, and Tailwind
- `tsconfig.json`: TypeScript config extending Astro base with React JSX
- `.prettierrc`: Code formatting rules
- `.env*`: Environment variables (`.env`, `.env.example`, `.env.local`)

## Source Directory (`src/`)

### Pages (`src/pages/`)

File-based routing following Astro conventions:

- `index.astro`: Homepage
- `revalidation.astro`: Cache revalidation demo
- `image-cdn.astro`: Image CDN demo
- `blobs/`: Blob storage demo with interactive components
- `edge/`: Edge function routing demos (australia, not-australia)
- `api/`: API routes (TypeScript files)
  - `blob.ts`, `blobs.ts`: Blob storage endpoints
  - `revalidate.ts`: Cache revalidation endpoint

### Components (`src/components/`)

Reusable Astro components (`.astro` files):

- Layout components: `Header.astro`, `Footer.astro`, `Logo.astro`
- Content components: `Markdown.astro`, `Alert.astro`, `Diff.astro`
- Feature-specific: `EdgeFunctionExplainer.astro`

### Page-Specific Components

React components (`.tsx`) in `_components` subdirectories:

- `src/pages/blobs/_components/`: Interactive blob shape components
- Naming: Use `_components` folder for page-scoped components

### Layouts (`src/layouts/`)

Page layout templates (`.astro` files)

### Styles (`src/styles/`)

- `globals.css`: Global styles with Tailwind imports, theme variables, and custom component classes
- Uses `@layer` directives for base, components
- Custom `.btn` and `.markdown` component classes

### Utilities (`src/utils/`)

- `utils.ts`: Shared utility functions
- `highlighter.ts`: Syntax highlighting utilities

### Types (`src/types.ts`)

Shared TypeScript type definitions

## Netlify Directory (`netlify/`)

### Edge Functions (`netlify/edge-functions/`)

- `rewrite.js`: Geo-based routing logic
- Export default handler function and `config` object with path

## Public Directory (`public/`)

Static assets served directly:

- `favicon.svg`
- `images/`: Image assets (corgi.jpg, noise.png)

## Conventions

1. **File Extensions**:

   - `.astro`: Astro components and pages
   - `.tsx`: React components
   - `.ts`: TypeScript utilities and API routes

2. **Component Organization**:

   - Shared components → `src/components/`
   - Page-specific components → `src/pages/[page]/_components/`

3. **API Routes**:

   - Must export `prerender = false` for SSR
   - Export HTTP method handlers: `GET`, `POST`, etc.
   - Receive `APIRoute` context with `url`, `request`, etc.

4. **Styling**:

   - Tailwind utility classes preferred
   - Custom components in `globals.css` using `@layer components`
   - Theme variables in `@theme` block

5. **Edge Functions**:
   - Export default async handler
   - Export `config` object with routing path
   - Access geo data via `context.geo`
