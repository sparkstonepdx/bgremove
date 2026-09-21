// One place that finds a model file, fetching it if it is not cached.
//
// Every test used to have its own copy of this, and most of them exited 0
// when the file was missing. On a fresh CI runner the cache is always empty,
// so those tests would have passed without running anything.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'web', 'profiles.json'), 'utf8'),
);

export const cacheDir = path.join(os.homedir(), '.cache', 'bgremove');

export async function modelPath(name) {
  const file = path.join(cacheDir, `${name}.onnx`);
  if (fs.existsSync(file)) return file;

  const entry = table.models[name];
  if (!entry) throw new Error(`no profile for ${name} in web/profiles.json`);
  fs.mkdirSync(cacheDir, { recursive: true });

  // Built rather than downloaded: fetch the model it comes from, then run the
  // quantizer. Deterministic for the toolchain pinned in requirements.txt, so
  // this reproduces the exact file the quality floors were measured on.
  if (entry.quantize) {
    const source = await modelPath(entry.from);
    const python = process.env.PYTHON || 'python3';
    console.log(`quantizing ${entry.from} to ${entry.quantize} (once)`);
    const tmp = `${file}.part`;
    const run = spawnSync(python, [path.join(here, 'quantize.py'), source, tmp], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (run.error || run.status !== 0) {
      throw new Error(
        `quantizing ${name} failed; it needs Python with scripts/requirements.txt installed ` +
        `(pip install -r scripts/requirements.txt)`,
      );
    }
    fs.renameSync(tmp, file);
    return file;
  }

  console.log(`fetching ${name} (${Math.round(entry.bytes / (1 << 20))} MB, once)`);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`${entry.url}: ${res.status}`);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
  return file;
}

export async function modelBytes(name) {
  return new Uint8Array(fs.readFileSync(await modelPath(name)));
}
