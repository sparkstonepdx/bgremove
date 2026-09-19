// Fails when the two builds drift apart.
//
// Three checks, in order of how cheap they are:
//   1. the two copies of profiles.json are byte-identical
//   2. the browser pipeline reads its settings from that file, not constants
//   3. both builds produce the same mask on the same images
//
// The third needs the native binary. Build it first:
//     cd ../../native && go build -o bgremove .
// Fixtures live in fixtures/: any .jpg or .png, plus an optional
// <name>.ref.png whose alpha is treated as ground truth. Only put a real
// cutout there. A mask from one of these models is not ground truth, and
// scoring a different model against it says nothing.
import { createCanvas, ImageData as NapiImageData, loadImage } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const nativeDir = path.join(here, '..', '..', 'native');
const MODEL = process.env.BGREMOVE_MODEL || JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'profiles.json'), 'utf8'),
).default;

// how far the two are allowed to differ, in mean absolute alpha out of 255.
// Not zero: node-canvas and Go resample differently.
const TOLERANCE = Number(process.env.BGREMOVE_TOLERANCE || 4);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- 1. config

const webProfiles = path.join(webDir, 'profiles.json');
const nativeProfiles = path.join(nativeDir, 'profiles.json');
const a = fs.readFileSync(webProfiles);
const b = fs.existsSync(nativeProfiles) ? fs.readFileSync(nativeProfiles) : Buffer.alloc(0);
check('profiles.json is identical in both builds', a.equals(b),
  a.equals(b) ? `${a.length} bytes` : 'copy web/profiles.json to native/profiles.json');

const table = JSON.parse(a.toString());
check('the table names a default model', !!table.models?.[table.default], table.default);

// ---------------------------------------------------------------- 2. wiring

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
await bg.loadProfiles(table, MODEL);
const want = table.models[MODEL];

check('browser pipeline takes mean and std from the table',
  JSON.stringify(bg.profile.mean) === JSON.stringify(want.mean) &&
  JSON.stringify(bg.profile.std) === JSON.stringify(want.std),
  `mean ${JSON.stringify(bg.profile.mean)}`);
check('browser pipeline takes the ramp from the table',
  bg.profile.clean.lo === want.clean.lo && bg.profile.clean.hi === want.clean.hi,
  `${bg.profile.clean.lo}/${bg.profile.clean.hi}`);
check('browser pipeline takes letterbox and fillHoles from the table',
  bg.profile.letterbox === want.letterbox && bg.profile.fillHoles === want.fillHoles,
  `letterbox ${bg.profile.letterbox}`);

// ---------------------------------------------------------------- 3. output

const binary = path.join(nativeDir, 'bgremove');
const fixtures = fs.readdirSync(path.join(here, 'fixtures'))
  .filter((f) => /\.(jpe?g|png)$/i.test(f) && !/\.(ref|u2netp-mask)\./.test(f));

if (!fs.existsSync(binary)) {
  console.log('\nskip  mask parity: build the native binary first (cd ../../native && go build -o bgremove .)');
} else if (fixtures.length === 0) {
  console.log('\nskip  mask parity: no fixtures');
} else {
  const modelFile = path.join(webDir, `${MODEL}.onnx`);
  const cached = path.join(os.homedir(), '.cache', 'bgremove', `${MODEL}.onnx`);
  const modelPath = fs.existsSync(modelFile) ? modelFile : cached;
  if (!fs.existsSync(modelPath)) {
    console.log(`\nskip  mask parity: no ${MODEL}.onnx in web/ or ~/.cache/bgremove`);
  } else {
    const model = new Uint8Array(fs.readFileSync(modelPath));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgparity-'));

    for (const name of fixtures) {
      const src = path.join(here, 'fixtures', name);
      execFileSync(binary, ['-model', MODEL, '-o', outDir, src], { stdio: 'pipe' });
      const stem = name.replace(/\.[^.]+$/, '');
      const nativeAlpha = await alphaOf(fs.readFileSync(path.join(outDir, `${stem}.png`)));

      const bitmap = await loadImage(src);
      const blob = await bg.cutout(bitmap, null, model);
      const wasmAlpha = await alphaOf(Buffer.from(await blob.arrayBuffer()));

      check(`${name}: same dimensions`, nativeAlpha.length === wasmAlpha.length);
      if (nativeAlpha.length !== wasmAlpha.length) continue;

      let sum = 0;
      for (let i = 0; i < nativeAlpha.length; i++) sum += Math.abs(nativeAlpha[i] - wasmAlpha[i]);
      const mean = sum / nativeAlpha.length;
      check(`${name}: masks agree`, mean <= TOLERANCE, `mean abs ${mean.toFixed(2)}/255`);

      const refPath = path.join(here, 'fixtures', `${stem}.ref.png`);
      if (fs.existsSync(refPath)) {
        const ref = await alphaOf(fs.readFileSync(refPath), bitmap.width, bitmap.height);
        console.log(`      quality vs reference: native ${iou(nativeAlpha, ref)}  wasm ${iou(wasmAlpha, ref)}`);
      }
    }
  }
}

function iou(alpha, ref) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < alpha.length; i++) {
    const x = alpha[i] > 127;
    const y = ref[i] > 127;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return `${((inter / union) * 100).toFixed(2)}% IoU`;
}

async function alphaOf(png, w, h) {
  const img = await loadImage(png);
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

console.log(`\n${failures} failing`);
process.exit(failures ? 1 : 0);
