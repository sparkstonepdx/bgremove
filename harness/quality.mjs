// Scores the pipeline's actual output against reference cutouts and fails if
// it drops. This is the test the codebase was missing: everything else checks
// that the machinery runs, and a model fed the wrong normalisation constants
// runs perfectly while returning a blank mask.
//
//   npm run quality
//
// Fixtures are pairs in fixtures/: <name>.jpg or .png alongside
// <name>.ref.png, whose alpha is the reference. Only put a real cutout there;
// a mask from one of these models is not ground truth.
//
// Floors live in expected.json, keyed by model and fixture. Raise them when a
// change genuinely improves a number, and the commit that raises them is the
// record of why.
import { createCanvas, ImageData as NapiImageData, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

class OffscreenCanvasShim {
  constructor(w, h) { this.canvas = createCanvas(w, h); this.width = w; this.height = h; }
  getContext(t, o) { return this.canvas.getContext(t, o); }
  async convertToBlob() {
    return new Blob([await this.canvas.encode('png')], { type: 'image/png' });
  }
}
globalThis.OffscreenCanvas = OffscreenCanvasShim;
globalThis.ImageData = NapiImageData;
const proto = createCanvas(1, 1).getContext('2d').constructor.prototype;
const realDraw = proto.drawImage;
proto.drawImage = function (img, ...rest) {
  return realDraw.call(this, img instanceof OffscreenCanvasShim ? img.canvas : img, ...rest);
};

const bg = await import(path.join(webDir, 'bg.js'));
const table = JSON.parse(fs.readFileSync(path.join(webDir, 'profiles.json'), 'utf8'));
const expectedFile = JSON.parse(fs.readFileSync(path.join(here, 'expected.json'), 'utf8'));
// keys starting with _ are notes to the reader, not models
const expected = Object.fromEntries(
  Object.entries(expectedFile).filter(([k]) => !k.startsWith('_')),
);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// Fetch a model rather than skipping when it is absent. A skipped quality
// check is how a broken model stays broken.
async function modelBytes(name) {
  const dir = path.join(os.homedir(), '.cache', 'bgremove');
  const file = path.join(dir, `${name}.onnx`);
  if (!fs.existsSync(file)) {
    const url = table.models[name]?.url;
    if (!url) throw new Error(`no url for ${name}`);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`fetching ${name} (${Math.round(table.models[name].bytes / (1 << 20))} MB, once)`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return new Uint8Array(fs.readFileSync(file));
}

async function alphaOf(source, w, h) {
  const img = await loadImage(source);
  const width = w || img.width;
  const height = h || img.height;
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3];
  return out;
}

function report(mask, ref) {
  let inter = 0;
  let union = 0;
  let extra = 0;
  let lost = 0;
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i] > 127;
    const b = ref[i] > 127;
    if (a && b) inter++;
    if (a || b) union++;
    if (a && !b) extra++;
    if (!a && b) lost++;
  }
  return {
    iou: (inter / union) * 100,
    extra: (extra / mask.length) * 100,
    lost: (lost / mask.length) * 100,
  };
}

const pairs = fs.readdirSync(path.join(here, 'fixtures'))
  .filter((f) => /\.(jpe?g|png)$/i.test(f) && !/\.(ref|u2netp-mask)\./.test(f))
  .map((f) => ({ image: f, stem: f.replace(/\.[^.]+$/, '') }))
  .filter((p) => fs.existsSync(path.join(here, 'fixtures', `${p.stem}.ref.png`)));

if (!pairs.length) {
  console.log('no fixture pairs in fixtures/: add <name>.jpg and <name>.ref.png');
  process.exit(1);
}

// bg.js keeps one session, the way a page does, so each model gets its own
// process rather than a reset hook that only tests would ever call.
const only = process.env.BGREMOVE_MODEL;
if (!only) {
  const { spawnSync } = await import('node:child_process');
  let bad = 0;
  for (const model of Object.keys(expected)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: { ...process.env, BGREMOVE_MODEL: model },
    });
    if (r.status !== 0) bad++;
  }
  console.log(bad ? `\n${bad} model(s) failing` : '\nall models within their floors');
  process.exit(bad ? 1 : 0);
}

{
  const model = only;
  const bytes = await modelBytes(model);
  await bg.loadProfiles(table, model);
  console.log(`\n${model}`);

  // Both directions, so neither a new fixture nor a deleted one goes unnoticed.
  const wanted = Object.keys(expected[model] || {});
  for (const stem of wanted) {
    if (!pairs.some((p) => p.stem === stem)) {
      check(`${stem}: fixture pair exists`, false,
        `expected.json names it but fixtures/${stem}.ref.png is missing`);
    }
  }

  for (const pair of pairs) {
    const floor = expected[model]?.[pair.stem];
    if (floor === undefined) {
      check(`${pair.image}: has a recorded floor`, false,
        `add "${pair.stem}" under "${model}" in expected.json`);
      continue;
    }
    const bitmap = await loadImage(path.join(here, 'fixtures', pair.image));
    const pred = await bg.predict(bitmap, bytes);
    const mask = await alphaOf(
      Buffer.from(await (await bg.cutout(bitmap, null, bytes)).arrayBuffer()),
    );
    const ref = await alphaOf(
      fs.readFileSync(path.join(here, 'fixtures', `${pair.stem}.ref.png`)),
      bitmap.width, bitmap.height,
    );
    const r = report(mask, ref);
    check(`${pair.image}: IoU at or above ${floor}%`, r.iou >= floor,
      `${r.iou.toFixed(2)}%  extra bg ${r.extra.toFixed(2)}%  lost subject ${r.lost.toFixed(2)}%`);
    if (r.iou > floor + 1) {
      console.log(`      improved by ${(r.iou - floor).toFixed(2)} points; raise the floor in expected.json`);
    }
    void pred;
  }
}


console.log(`\n${failures} failing`);
process.exit(failures ? 1 : 0);
