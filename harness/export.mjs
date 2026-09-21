// Checks that a site written with -dir is self-contained: every local file the
// page asks for is actually there.
//
// This exists because the export shipped without config.json. The page then
// fell back to whatever profiles.json calls default, which was a different
// model from the one exported, and applying one model's normalisation to
// another's weights returns a blank mask rather than an error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const binary = path.join(root, 'bgremove');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

if (!fs.existsSync(binary)) {
  // Not a skip: in CI a missing binary means the build step broke, and a test
  // that passes because there was nothing to test is worse than no test.
  check('the binary exists to export with', false, 'run pnpm install && go build -o bgremove . first');
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgexport-'));
const model = process.env.BGREMOVE_MODEL || 'u2netp';
execFileSync(binary, ['-model', model, '-dir', dir], { stdio: 'pipe' });

const present = new Set(fs.readdirSync(dir));

// every ./something the page loads, from both the markup and the module
const sources = ['index.html', 'app.js', 'bg.js']
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
  .join('\n');
const wanted = new Set(
  [...sources.matchAll(/["'`](\.\/[A-Za-z0-9._-]+)["'`]/g)].map((m) => m[1].slice(2)),
);
// the import map turns the bare specifier into a real file; follow it
for (const m of sources.matchAll(/"onnxruntime-web":\s*"\.\/([A-Za-z0-9._-]+)"/g)) {
  wanted.add(m[1]);
}

check('the export names at least the page, the model and the runtime',
  wanted.size >= 4, [...wanted].join(' '));
for (const name of [...wanted].sort()) {
  check(`${name} is in the export`, present.has(name));
}

// the runtime resolves its own siblings relative to itself
check('the runtime glue sits next to its wasm',
  present.has('ort-wasm-simd-threaded.mjs') && present.has('ort-wasm-simd-threaded.wasm'));

// and the config has to name the model that was actually written
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
check('config.json names the exported model', cfg.model === model, cfg.model);
check('the fallback model it names is present',
  present.has((cfg.fallback || '').replace('./', '')), cfg.fallback);
const table = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
check('that model has a profile in the exported table', !!table.models[cfg.model]);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures} failing`);
process.exit(failures ? 1 : 0);
