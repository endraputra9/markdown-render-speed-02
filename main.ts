// Driver the harness runs as `node /bot/main.ts`.
//
// It loads the case list from the input directory (each case is an object
// with a `markdown` string), renders every case on its own with parse()
// from ./parse.js, and writes the HTML strings, in case order, as a JSON
// array to the output directory. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// stand in for /input and /output when running outside the container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const rendered: string[] = [];
for (const entry of cases) {
  rendered.push(parse(entry.markdown));
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
