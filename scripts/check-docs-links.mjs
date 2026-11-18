// Every link from one page of the built documentation to another must lead to a page that
// is there, and to a heading on it if it names one. Run on the site as Jekyll built it for
// the root of a domain: node scripts/check-docs-links.mjs docs-site/_site
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const site = process.argv[2];
if (!site) {
  console.error('usage: check-docs-links.mjs <built site>');
  process.exit(2);
}

const pages = new Map();
for (const name of readdirSync(site)) {
  if (!name.endsWith('.html')) continue;
  const html = readFileSync(join(site, name), 'utf8');
  pages.set(name, { html, ids: new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])) });
}

const problems = [];
for (const [name, { html }] of pages) {
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    // Other sites, and the theme's own files, are not what this checks.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/assets/')) continue;
    const [path, anchor] = href.split('#');
    const target = path === '' ? name : path === '/' ? 'index.html' : path.replace(/^\//, '');
    const page = pages.get(target);
    if (!page) problems.push(`${name}: ${href} leads to no page`);
    else if (anchor && !page.ids.has(decodeURIComponent(anchor))) {
      problems.push(`${name}: ${href} names a heading that is not on that page`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${pages.size} pages: every link between them leads somewhere.`);
