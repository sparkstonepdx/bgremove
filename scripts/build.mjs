// Builds the static site: the page, the runtime it loads, one model, and a
// config naming which model that is. Everything here is copying; there is no
// server anywhere in the result.
//
//   pnpm build                       the default model from profiles.json
//   pnpm build --model u2netp        a specific one
//   pnpm build --out dist            somewhere other than site/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelPath } from './models.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const modules = path.join(root, 'node_modules');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const table = JSON.parse(fs.readFileSync(path.join(web, 'profiles.json'), 'utf8'));
const model = flag('model') || table.default;
const out = path.resolve(root, flag('out') || 'site');

if (!table.models[model]) {
  console.error(`unknown model ${model}; have ${Object.keys(table.models).join(', ')}`);
  process.exit(1);
}

// The runtime resolves its glue and wasm relative to itself, so all three
// sit next to each other at the site root.
const runtime = [
  'onnxruntime-web/dist/ort.wasm.min.mjs',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  // A static host cannot set COOP and COEP, so this service worker adds them
  // client-side, which is what unlocks threads on GitHub Pages.
  'coi-serviceworker/coi-serviceworker.min.js',
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const name of fs.readdirSync(web)) {
  fs.copyFileSync(path.join(web, name), path.join(out, name));
}

for (const rel of runtime) {
  const from = path.join(modules, rel);
  if (!fs.existsSync(from)) {
    console.error(`missing ${rel}; run pnpm install first`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(out, path.basename(rel)));
}

fs.copyFileSync(await modelPath(model), path.join(out, 'model.onnx'));

// The page drops to u2netp if the browser refuses the configured model.
// Naming the file here means exporting u2netp does not ship itself twice.
let fallback = './model.onnx';
if (model !== 'u2netp') {
  fs.copyFileSync(await modelPath('u2netp'), path.join(out, 'u2netp.onnx'));
  fallback = './u2netp.onnx';
}

// Without this the page falls back to whatever profiles.json calls default,
// which need not be the model built in: one model's normalisation on
// another's weights returns a blank mask, not an error.
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({ model, fallback }));

const bytes = fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
const shown = out.startsWith(root + path.sep) ? path.relative(root, out) : out;
console.log(`built ${shown}/ with ${model}, ${(bytes / (1 << 20)).toFixed(1)} MB`);
