// Measures how well a refiner turns corrective clicks into a better mask.
//
// This is the standard interactive-segmentation evaluation. Clicks are not
// placed by hand: each one lands at the centre of the largest region where the
// current mask disagrees with the ground truth, positive if the mask is
// missing subject there and negative if it is keeping background. That is how
// RITM and FocalClick report their numbers, so anything measured here is
// comparable to their published NoC@90: the number of clicks needed to reach
// 90% IoU.
//
//   node clicks.mjs                 score the built-in brush
//   node clicks.mjs --refiner ./my-refiner.mjs
//
// A refiner module exports:
//   export const name = 'whatever';
//   export async function init(ctx)      // ctx: { bitmap, pred, bg }
//   export async function refine(state)  // state: { mask, clicks, width, height }
//     -> Uint8Array mask, 1 byte per pixel, 0 or 1, width*height
//
// The point of the interface is that a click model and a paint brush are
// interchangeable behind it, so a candidate can be compared against what
// already ships before anyone wires it into the app.
import { createCanvas, ImageData as NapiImageData, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
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
const { iou, components, deepestPoint, nextClick } = await import(path.join(here, 'clicksim.mjs'));

const args = process.argv.slice(2);
const refinerPath = args[args.indexOf('--refiner') + 1];
const MAX_CLICKS = Number(process.env.BGREMOVE_CLICKS || 8);
// 90% is the figure the literature reports, but a good base model is already
// past it, which makes the metric say nothing. Default higher and let the
// caller pick.
const TARGET = Number(process.env.BGREMOVE_TARGET || 0.95);

// Everything is scored on a grid this wide. Full resolution would make the
// distance transform the slowest part of the run for no gain in ranking.
const GRID = 384;

// ---------------------------------------------------------------- built-in

const brush = {
  name: 'paint brush (what ships today)',
  async init(ctx) { this.ctx = ctx; this.strokes = []; },
  async refine({ clicks, width, height }) {
    this.strokes = clicks.map((c) => ({
      mode: c.label ? 'keep' : 'cut',
      size: 0.04,
      grow: { tolerance: 0.15, radius: 0.25 },
      points: [{ x: c.x, y: c.y }],
    }));
    const canvas = bg.compose(this.ctx.bitmap, this.ctx.pred, { strokes: this.strokes });
    return alphaGrid(canvas, width, height);
  },
};

// ---------------------------------------------------------------- helpers

function alphaGrid(source, w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source instanceof OffscreenCanvasShim ? source.canvas : source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------- run

const refiner = refinerPath
  ? await import(path.resolve(refinerPath))
  : brush;

const table = JSON.parse(fs.readFileSync(path.join(webDir, 'profiles.json'), 'utf8'));
const model = process.env.BGREMOVE_MODEL || table.default;
await bg.loadProfiles(table, model);

const modelFile = fs.existsSync(path.join(webDir, `${model}.onnx`))
  ? path.join(webDir, `${model}.onnx`)
  : path.join(process.env.HOME, '.cache', 'bgremove', `${model}.onnx`);
if (!fs.existsSync(modelFile)) {
  console.log(`no ${model}.onnx in web/ or ~/.cache/bgremove; run the native build once to fetch it`);
  process.exit(0);
}
const modelBytes = new Uint8Array(fs.readFileSync(modelFile));

const pairs = fs.readdirSync(path.join(here, 'fixtures'))
  .filter((f) => /\.(jpe?g|png)$/i.test(f) && !/\.(ref|u2netp-mask)\./.test(f))
  .map((f) => ({ image: f, ref: `${f.replace(/\.[^.]+$/, '')}.ref.png` }))
  .filter((p) => fs.existsSync(path.join(here, 'fixtures', p.ref)));

if (!pairs.length) {
  console.log('no fixture pairs: add <name>.jpg and <name>.ref.png to fixtures/');
  process.exit(0);
}

console.log(`refiner: ${refiner.name || path.basename(refinerPath)}`);
console.log(`base model: ${model}\n`);

let totalNoC = 0;
let scored = 0;

for (const pair of pairs) {
  const bitmap = await loadImage(path.join(here, 'fixtures', pair.image));
  const w = GRID;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * GRID));

  const truth = alphaGrid(await loadImage(path.join(here, 'fixtures', pair.ref)), w, h);
  const pred = await bg.predict(bitmap, modelBytes);
  const ctx = { bitmap, pred, bg };
  await refiner.init?.(ctx);

  let mask = alphaGrid(bg.compose(bitmap, pred), w, h);
  const clicks = [];
  let start = iou(mask, truth);
  let reached = start >= TARGET ? 0 : null;
  const trail = [start];

  for (let n = 1; n <= MAX_CLICKS && reached === null; n++) {
    const click = nextClick(mask, truth, w, h);
    if (!click) break;
    clicks.push(click);
    mask = await refiner.refine({ mask, clicks, width: w, height: h, truth: null });
    start = iou(mask, truth);
    trail.push(start);
    if (start >= TARGET && reached === null) { reached = n; break; }
  }

  const noc = reached === null ? `>${MAX_CLICKS}` : String(reached);
  totalNoC += reached === null ? MAX_CLICKS + 1 : reached;
  scored++;
  console.log(`${pair.image}`);
  console.log(`  IoU  ${trail.map((v) => (v * 100).toFixed(1)).join('  ->  ')}`);
  const best = Math.max(...trail);
  console.log(`  clicks to ${(TARGET * 100).toFixed(0)}%: ${noc}   best ${(best * 100).toFixed(1)}%   net ${((best - trail[0]) * 100 >= 0 ? '+' : '')}${((best - trail[0]) * 100).toFixed(1)}`);
}

console.log(`\nmean clicks to ${(TARGET * 100).toFixed(0)}%: ${(totalNoC / scored).toFixed(2)} over ${scored} fixture(s)`);
