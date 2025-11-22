// import { createHighlighter } from 'shiki';

// Mock highlighter to avoid shiki issues in Netlify Functions
export const highlighterPromise = Promise.resolve({
    codeToHtml: (code: string) => `<pre><code>${code}</code></pre>`
});
