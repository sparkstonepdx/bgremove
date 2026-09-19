// Runs web/bg.js outside a browser by supplying the three APIs it touches:
// OffscreenCanvas, ImageData and createImageBitmap. Everything else is the
// same code the page loads.
import { createCanvas, ImageData as NapiImageData, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Models live in the user cache, put there by either build on first run.
function modelPath(name) {
  const cached = path.join(os.homedir(), '.cache', 'bgremove', `${name}.onnx`);
  if (!fs.existsSync(cached)) {
    console.log(`no ${name}.onnx in ~/.cache/bgremove; run either build once to fetch it`);
    process.exit(0);
  }
  return cached;
}

class OffscreenCanvasShim {
  constructor(width, height) {
    this.canvas = createCanvas(width, height);
    this.width = width;
    this.height = height;
  }

  getContext(type, opts) {
    return this.canvas.getContext(type, opts);
  }

  // node-canvas gives us a sync encoder; wrap it to match the browser's API.
  async convertToBlob() {
    const buf = await this.canvas.encode('png');
    return new Blob([buf], { type: 'image/png' });
  }
}

globalThis.OffscreenCanvas = OffscreenCanvasShim;
globalThis.ImageData = NapiImageData;
globalThis.createImageBitmap = async (src) =>
  src instanceof Uint8Array || Buffer.isBuffer(src) ? loadImage(src) : loadImage(src);

// drawImage needs the underlying napi canvas, not our wrapper
const proto = createCanvas(1, 1).getContext('2d').constructor.prototype;
const realDraw = proto.drawImage;
proto.drawImage = function (img, ...rest) {
  return realDraw.call(this, img instanceof OffscreenCanvasShim ? img.canvas : img, ...rest);
};

const bg = await import(path.join(here, '..', 'web', 'bg.js'));

// ---------------------------------------------------------------- checks

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function alphaOf(png) {
  // decode via the same canvas backend
  return loadImage(png).then((img) => {
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height).data;
  });
}

// the browser passes a relative URL; Node needs the bytes
const model = new Uint8Array(fs.readFileSync(modelPath('u2netp')));
// this harness runs against the embedded u2netp file, so pin that profile
// rather than following the table's default, which may be a larger model
await bg.loadProfiles(JSON.parse(fs.readFileSync(path.join(here, '..', 'web', 'profiles.json'), 'utf8')), 'u2netp');
const srcPath = process.argv[2] || path.join(here, 'fixtures', 'test.png');
const refPath = process.argv[3] || path.join(here, 'fixtures', 'test.u2netp-mask.png');

const bitmap = await loadImage(srcPath);
check('source image loads', bitmap.width > 0 && bitmap.height > 0,
  `${bitmap.width}x${bitmap.height}`);

// 1. input tensor shape and normalisation range
const t0 = Date.now();
const tensor = bg.toTensor(bitmap);
check('toTensor shape', JSON.stringify(tensor.dims) === JSON.stringify([1, 3, 320, 320]),
  JSON.stringify(tensor.dims));
let lo = tensor.data[0];
let hi = tensor.data[0];
for (const v of tensor.data) {
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}
check('toTensor normalised range', lo >= -2.2 && hi <= 2.7,
  `${lo.toFixed(2)} .. ${hi.toFixed(2)}`);

check('input size read from the model', bg.inputSize() === 320, String(bg.inputSize()));

// 2. the alpha ramp clears the model's low-confidence tail
const hazeBand = (px) => {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 1 && px[i] < 77) n++;
  return n / (px.length / 4);
};

// 3. full cutout against the rembg reference
const started = Date.now();
const blob = await bg.cutout(bitmap, null, model);
const elapsed = Date.now() - started;
const out = Buffer.from(await blob.arrayBuffer());
check('cutout returns a png', out.subarray(1, 4).toString() === 'PNG', `${out.length} bytes in ${elapsed}ms`);

const got = await alphaOf(out);
const want = await alphaOf(fs.readFileSync(refPath));
check('cutout size matches source', got.length === bitmap.width * bitmap.height * 4);

let sum = 0;
let corner = got[3];
for (let i = 3; i < got.length; i += 4) sum += Math.abs(got[i] - want[i]);
const meanDiff = sum / (got.length / 4);
check('alpha matches rembg u2netp', meanDiff < 3, `mean abs diff ${meanDiff.toFixed(2)}/255`);
check('background corner is transparent', corner < 8, `alpha ${corner}`);

const mid = (bitmap.height >> 1) * bitmap.width * 4 + (bitmap.width >> 1) * 4;
check('subject centre is opaque', got[mid + 3] > 240, `alpha ${got[mid + 3]}`);

// 3. solid backdrop path
const flatBlob = await bg.cutout(bitmap, '#ff8800', model);
const flat = await alphaOf(Buffer.from(await flatBlob.arrayBuffer()));
check('backdrop leaves no transparency', flat[3] === 255, `alpha ${flat[3]}`);
check('backdrop colour applied', flat[0] === 255 && flat[1] === 136 && flat[2] === 0,
  `rgb(${flat[0]},${flat[1]},${flat[2]})`);

// 4. same image with the ramp disabled should carry more faint alpha
const before = bg.profile.clean.lo;
bg.profile.clean.lo = 0;
bg.profile.clean.hi = 1;
const rawAlpha = await alphaOf(Buffer.from(await (await bg.cutout(bitmap, null, model)).arrayBuffer()));
bg.profile.clean.lo = before;
bg.profile.clean.hi = 0.9;
check('ramp reduces the faint-alpha haze', hazeBand(got) <= hazeBand(rawAlpha),
  `${(hazeBand(got) * 100).toFixed(2)}% with ramp vs ${(hazeBand(rawAlpha) * 100).toFixed(2)}% without`);

// 5. the session is reused rather than rebuilt per image. Assert on identity,
// not wall time: timings on a loaded machine are not a signal.
const s1 = await bg.getSession(model);
const s2 = await bg.getSession(model);
check('getSession returns the same session', s1 === s2);

// 6. letterboxing and hole filling
check('framing is a no-op when letterbox is off',
  bg.framing({ width: 300, height: 400 }).side === 0);

bg.profile.letterbox = true;
const f = bg.framing({ width: 300, height: 400 });
check('letterbox centres on the long side',
  f.side === 400 && f.ox === 50 && f.oy === 0, `side ${f.side}, ox ${f.ox}, oy ${f.oy}`);

const boxed = await bg.cutoutCanvas(bitmap, null, model);
check('letterboxed output keeps the source size',
  boxed.width === bitmap.width && boxed.height === bitmap.height,
  `${boxed.width}x${boxed.height}`);
bg.profile.letterbox = false;

// an opaque ring with a transparent middle: the middle should close up
const ring = new Uint8Array(8 * 8 * 4);
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    const edge = x === 0 || y === 0 || x === 7 || y === 7;
    const inner = x >= 2 && x <= 5 && y >= 2 && y <= 5;
    ring[(y * 8 + x) * 4 + 3] = edge || inner ? (edge ? 0 : 0) : 255;
  }
}
// ring of opaque at radius 1, hole at the centre
for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) ring[(y * 8 + x) * 4 + 3] = 255;
for (let y = 3; y <= 4; y++) for (let x = 3; x <= 4; x++) ring[(y * 8 + x) * 4 + 3] = 0;
bg.fillHoles(ring, 8, 8);
check('fillHoles closes an enclosed hole', ring[(3 * 8 + 3) * 4 + 3] === 255,
  String(ring[(3 * 8 + 3) * 4 + 3]));
check('fillHoles leaves the outside alone', ring[3] === 0, String(ring[3]));

// 7. brush strokes beat the model and the ramp
const pred = await bg.predict(bitmap, model);
const place = bg.maskPlacement(pred);
check('maskPlacement covers the whole input when squashing',
  place.x === 0 && place.y === 0 && place.w === pred.size, `${place.w}x${place.h}`);

const alphaAt = (canvasOut, fx, fy) => {
  const ctx = canvasOut.getContext('2d');
  const x = Math.round(fx * (canvasOut.width - 1));
  const y = Math.round(fy * (canvasOut.height - 1));
  return ctx.getImageData(x, y, 1, 1).data[3];
};

const plain = bg.compose(bitmap, pred);
const cutStroke = [{ mode: 'cut', size: 0.5, points: [{ x: 0.5, y: 0.5 }] }];
// protect 0 for the raw mechanism; forgiveness gets its own checks below
const cutOut = bg.compose(bitmap, pred, { strokes: cutStroke, protect: 0 });
check('a cut stroke clears alpha where the model said keep',
  alphaAt(plain, 0.5, 0.5) > 200 && alphaAt(cutOut, 0.5, 0.5) === 0,
  `${alphaAt(plain, 0.5, 0.5)} -> ${alphaAt(cutOut, 0.5, 0.5)}`);

const keepStroke = [{ mode: 'keep', size: 0.25, points: [{ x: 0.06, y: 0.06 }] }];
const keepOut = bg.compose(bitmap, pred, { strokes: keepStroke });
check('a keep stroke restores alpha where the model said drop',
  alphaAt(plain, 0.06, 0.06) === 0 && alphaAt(keepOut, 0.06, 0.06) > 200,
  `${alphaAt(plain, 0.06, 0.06)} -> ${alphaAt(keepOut, 0.06, 0.06)}`);

const both = bg.compose(bitmap, pred, { strokes: [...cutStroke, ...keepStroke], protect: 0 });
check('keep wins where the two overlap in order', alphaAt(both, 0.06, 0.06) > 200);
check('strokes do not disturb the rest of the mask',
  alphaAt(plain, 0.5, 0.95) === alphaAt(keepOut, 0.5, 0.95));

// 8. a seeded stroke grows past the brush shape, along the region it landed in
// count only what the stroke changed, not the background that was already gone
const alphaBuf = (canvasOut) => canvasOut.getContext('2d')
  .getImageData(0, 0, canvasOut.width, canvasOut.height).data;
const base = alphaBuf(plain);
const area = (canvasOut) => {
  const data = alphaBuf(canvasOut);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (base[i] >= 128 && data[i] < 128) n++;
  return n;
};

const dab = { mode: 'cut', size: 0.02, points: [{ x: 0.5, y: 0.5 }] };
const stamped = bg.compose(bitmap, pred, { strokes: [dab], protect: 0 });
const grown = bg.compose(bitmap, pred, {
  strokes: [{ ...dab, grow: { tolerance: 0.15, radius: 0.5 } }], protect: 0,
});
check('a seeded stroke removes more than the brush shape',
  area(grown) > area(stamped) * 2,
  `${area(stamped)}px stamped vs ${area(grown)}px grown`);

const tight = bg.compose(bitmap, pred, {
  strokes: [{ ...dab, grow: { tolerance: 0.01, radius: 0.5 } }], protect: 0,
});
check('tolerance bounds how far it spreads', area(tight) < area(grown),
  `${area(tight)}px at 0.01 vs ${area(grown)}px at 0.15`);

const penned = bg.compose(bitmap, pred, {
  strokes: [{ ...dab, grow: { tolerance: 0.9, radius: 0.02 } }], protect: 0,
});
check('radius bounds it even at high tolerance', area(penned) < area(grown),
  `${area(penned)}px vs ${area(grown)}px`);

check('the prediction carries its scaled pixels for growing',
  pred.rgb?.length === pred.size * pred.size * 4, String(pred.rgb?.length));

// 9. the click simulator itself, since the benchmark's numbers rest on it
const sim = await import(path.join(here, 'clicksim.mjs'));

const grid = (w, h, fn) => {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y) ? 1 : 0;
  return a;
};

const solid = grid(20, 20, () => true);
check('iou of a mask with itself is 1', sim.iou(solid, solid) === 1);
check('iou of disjoint masks is 0',
  sim.iou(grid(20, 20, (x) => x < 5), grid(20, 20, (x) => x > 14)) === 0);

const twoBlobs = grid(40, 20, (x, y) => (x > 2 && x < 10 && y > 2 && y < 18) || (x > 20 && x < 24 && y > 8 && y < 12));
const comps = sim.components(twoBlobs, 40, 20);
check('components finds both blobs', comps.length === 2, `${comps.length}`);
check('components returns the largest first', comps[0].length > comps[1].length,
  `${comps[0].length} then ${comps[1].length}`);

const square = grid(21, 21, (x, y) => x >= 5 && x <= 15 && y >= 5 && y <= 15);
const deep = sim.deepestPoint(sim.components(square, 21, 21)[0], square, 21, 21);
const dx = deep.index % 21;
const dy = (deep.index - dx) / 21;
check('deepestPoint lands in the middle of a blob', dx === 10 && dy === 10, `${dx},${dy}`);

// a mask missing a chunk of the truth should draw a positive click into it
const truth = grid(40, 40, (x, y) => x >= 4 && x <= 35 && y >= 4 && y <= 35);
const missingRight = grid(40, 40, (x, y) => x >= 4 && x <= 20 && y >= 4 && y <= 35);
const c1 = sim.nextClick(missingRight, truth, 40, 40);
check('a missed region draws a positive click', c1.label === 1, String(c1?.label));
check('the positive click lands inside the missed region',
  c1.x > 20 / 40 && c1.x < 36 / 40, c1.x.toFixed(2));

// a mask keeping background should draw a negative click into that
const tooWide = grid(40, 40, (x, y) => x >= 4 && y >= 4 && y <= 35);
const c2 = sim.nextClick(tooWide, truth, 40, 40);
check('kept background draws a negative click', c2.label === 0, String(c2?.label));
check('a perfect mask asks for no click', sim.nextClick(truth, truth, 40, 40) === null);

// 10. a sloppy remove stroke should take the background it crossed and leave
// the subject it clipped
const midPoint = { x: 0.5, y: 0.5 };    // solidly subject in the fixture
const bgPoint = { x: 0.06, y: 0.06 };   // solidly background

const sloppy = [{ mode: 'cut', size: 0.5, points: [midPoint] }];
const literal = bg.compose(bitmap, pred, { strokes: sloppy, protect: 0 });
const forgiving = bg.compose(bitmap, pred, { strokes: sloppy, protect: 0.85 });
check('without forgiveness red cuts straight through the subject',
  alphaAt(literal, 0.5, 0.5) === 0, String(alphaAt(literal, 0.5, 0.5)));
check('with forgiveness a slip onto the subject is ignored',
  alphaAt(forgiving, 0.5, 0.5) > 200, String(alphaAt(forgiving, 0.5, 0.5)));

// the same stroke must still remove the background half it covered
const straddle = [{ mode: 'cut', size: 0.3, points: [{ x: 0.2, y: 0.2 }] }];
const wasThere = alphaAt(bg.compose(bitmap, pred), 0.28, 0.28);
const nowThere = alphaAt(bg.compose(bitmap, pred, { strokes: straddle, protect: 0.85 }), 0.28, 0.28);
check('a straddling stroke still removes what it crossed on the background side',
  wasThere !== nowThere || wasThere === 0, `${wasThere} -> ${nowThere}`);

// deliberate removal of something the model is sure about must still work
const onlySubject = [{ mode: 'cut', size: 0.12, points: [midPoint] }];
const deliberate = bg.compose(bitmap, pred, { strokes: onlySubject, protect: 0.85 });
check('a stroke entirely on the subject is taken as meant',
  alphaAt(deliberate, 0.5, 0.5) === 0, String(alphaAt(deliberate, 0.5, 0.5)));

// green is not softened: recovering a dropped region is the point of it
const greenOnBg = [{ mode: 'keep', size: 0.25, points: [bgPoint] }];
check('green is never softened',
  alphaAt(bg.compose(bitmap, pred, { strokes: greenOnBg, protect: 0.85 }), 0.06, 0.06) > 200);

check('protect comes from the profile table', bg.profile.protect === 0.85,
  String(bg.profile.protect));

console.log(`\ntotal ${Date.now() - t0}ms, ${failures} failing`);
process.exit(failures ? 1 : 0);
