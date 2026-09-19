// Build step for static hosting (Vercel and anything else that serves a folder).
//
// The browser imports the simulation from /shared/*.js. Running locally those
// files are served by Express straight out of shared/; on a static host they
// have to exist under the published directory, so copy them there at build time
// rather than keeping a second copy in the repo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'shared');
const to = path.join(root, 'public', 'shared');

fs.mkdirSync(to, { recursive: true });

const copied = [];
for (const entry of fs.readdirSync(from)) {
  if (!entry.endsWith('.js')) continue;
  fs.copyFileSync(path.join(from, entry), path.join(to, entry));
  copied.push(entry);
}

console.log(`prepare-static: copied ${copied.length} file(s) to public/shared — ${copied.join(', ')}`);
