// The image pipeline, with no DOM in it, so a harness can run it outside a
// browser. app.js holds the event wiring.
// Bare specifier on purpose: Node resolves it from node_modules, and the
// browser resolves it through the import map in index.html. Neither one
// hardcodes a path into this file.
import * as ort from 'onnxruntime-web';

// Model settings come from profiles.json, which the native build embeds
// byte-for-byte. Nothing about a model is hardcoded here; harness/parity.mjs
// fails if the two copies of that file drift apart.
export const profile = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  clean: { lo: 0.3, hi: 0.7 },
  letterbox: false,
  fillHoles: true,
};

export let profiles = null;

// Load the table and adopt one model's settings. Pass a parsed object to skip
// the fetch, which is how the harness runs it under Node.
export async function loadProfiles(source = './profiles.json', name) {
  profiles = typeof source === 'string' ? await (await fetch(source)).json() : source;
  return useProfile(name || profiles.default);
}

export function useProfile(name) {
  const p = profiles?.models?.[name];
  if (!p) throw new Error(`unknown model ${name}`);
  Object.assign(profile, {
    mean: p.mean,
    std: p.std,
    clean: { ...p.clean },
    letterbox: p.letterbox,
    fillHoles: p.fillHoles,
    protect: p.protect ?? 0.85,
    protectShare: p.protectShare ?? 0.25,
  });
  return p;
}

// kept for callers that only want to nudge the ramp
let session = null;
let size = 320;

// The model states its own input resolution: 320 for u2net and u2netp, 1024
// for isnet. Read it rather than hardcoding, so swapping the file is enough.
export function inputSize() {
  return size;
}

export function threadCount() {
  if (!globalThis.crossOriginIsolated) return 1;
  return Math.min(4, globalThis.navigator?.hardwareConcurrency || 2);
}

// No default: the caller knows which file the server wrote. A default here
// was a second place that named a model file, and it went stale.
export async function getSession(model) {
  if (session) return session;
  ort.env.wasm.numThreads = threadCount();
  session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const dims = session.inputMetadata?.[0]?.shape;
  if (dims?.length === 4 && Number.isInteger(dims[3]) && dims[3] > 0) {
    size = dims[3];
  }
  return session;
}

// Try the configured model, and fall back to a smaller one if the browser
// refuses it. A phone can run out of memory on a 178 MB model at 1024x1024,
// and a dead page is a worse answer than a weaker mask.
export async function sessionWithFallback(primary, fallback, fallbackName) {
  try {
    return { session: await getSession(primary), fellBack: false };
  } catch (error) {
    if (!fallback || !profiles?.models?.[fallbackName]) throw error;
    const p = useProfile(fallbackName);
    return { session: await getSession(fallback), fellBack: true, profile: p, error };
  }
}

function canvas(w, h) {
  return new OffscreenCanvas(w, h);
}

// The square region of src the model actually sees: the whole image squashed,
// or the image centred on a black square when letterboxing.
export function framing(src) {
  if (!profile.letterbox) return { side: 0, ox: 0, oy: 0 };
  const side = Math.max(src.width, src.height);
  return {
    side,
    ox: Math.floor((side - src.width) / 2),
    oy: Math.floor((side - src.height) / 2),
  };
}

// Scale src into a SIZE x SIZE canvas and build the NCHW input tensor.
export function toTensor(src) {
  const SIZE = size;
  const { mean, std } = profile;
  const c = canvas(SIZE, SIZE);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const { side, ox, oy } = framing(src);
  if (side) {
    // black, because these models read a flat dark border as background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const k = SIZE / side;
    ctx.drawImage(src, ox * k, oy * k, src.width * k, src.height * k);
  } else {
    ctx.drawImage(src, 0, 0, SIZE, SIZE);
  }
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  const n = SIZE * SIZE;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      out[ch * n + i] = (data[i * 4 + ch] / 255 - mean[ch]) / std[ch];
    }
  }
  const tensor = new ort.Tensor('float32', out, [1, 3, SIZE, SIZE]);
  // the scaled pixels are kept so a brush stroke can grow along real edges
  tensor.rgb = data;
  return tensor;
}

// Grow a painted seed into the region around it that looks like what was
// painted. This is what turns a dab on a box flap into the whole flap rather
// than a brush-shaped blob. Growth is bounded by colour distance from the
// seed, by how far the model's own prediction drifts, and by a radius, so a
// stroke on a low-contrast subject cannot leak across the whole frame.
export function grow(pred, seedMask, { tolerance = 0.12, radius = 0.25 } = {}) {
  const SIZE = pred.size;
  const rgb = pred.rgb;
  if (!rgb) return seedMask;

  const n = SIZE * SIZE;
  const limit = Math.round(radius * SIZE);
  const tol = tolerance * 255;

  // average colour and prediction under the seed
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sp = 0;
  let count = 0;
  const out = Uint8Array.from(seedMask);
  const queue = new Int32Array(n);
  const depth = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!seedMask[i]) continue;
    sr += rgb[i * 4];
    sg += rgb[i * 4 + 1];
    sb += rgb[i * 4 + 2];
    sp += pred.data[i];
    count++;
    queue[tail++] = i;
  }
  if (!count) return seedMask;
  sr /= count;
  sg /= count;
  sb /= count;
  sp /= count;

  // Breadth first, carrying how many steps each pixel is from the seed, so
  // the radius cap costs nothing. Measuring the cap as distance to the
  // nearest seed pixel instead meant scanning every seed for every candidate,
  // which is quadratic in brush area: a wide stroke at 1024 took 15 seconds
  // and locked up the page. Steps also beat straight-line distance here,
  // since growth cannot reach around a barrier it never crossed.
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const d = depth[i];
    if (d >= limit) continue;

    const x = i % SIZE;
    const consider = (j) => {
      if (out[j]) return;
      const dr = rgb[j * 4] - sr;
      const dg = rgb[j * 4 + 1] - sg;
      const db = rgb[j * 4 + 2] - sb;
      if (Math.sqrt(dr * dr + dg * dg + db * db) > tol) return;
      if (Math.abs(pred.data[j] - sp) > 0.5) return;
      out[j] = 1;
      depth[j] = d + 1;
      queue[tail++] = j;
    };

    if (x > 0) consider(i - 1);
    if (x < SIZE - 1) consider(i + 1);
    if (i >= SIZE) consider(i - SIZE);
    if (i < n - SIZE) consider(i + SIZE);
  }
  return out;
}

// The pixels a set of strokes covers, as a flat 0/1 mask at model resolution.
export function strokeMask(strokes, pred) {
  const SIZE = pred.size;
  const ctx = rasterizeStrokes(strokes, pred).getContext('2d');
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const out = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

// Make transparent regions that do not reach the border opaque.
export function fillHoles(alpha, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (outside[i] || alpha[i * 4 + 3] >= 128) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  for (let i = 0; i < w * h; i++) {
    if (!outside[i] && alpha[i * 4 + 3] < 128) alpha[i * 4 + 3] = 255;
  }
}

// Run the model. This is the expensive half; the result is worth caching so
// the shaping controls can re-render without touching the model again.
export async function predict(bitmap, model) {
  const sess = await getSession(model);
  const feeds = { [sess.inputNames[0]]: toTensor(bitmap) };
  const res = await sess.run(feeds);
  return {
    data: res[sess.outputNames[0]].data,
    rgb: feeds[sess.inputNames[0]].rgb,
    size,
    width: bitmap.width,
    height: bitmap.height,
    // remember how the image was framed, so a later profile change cannot
    // compose this prediction against the wrong crop
    frame: framing(bitmap),
  };
}

// Where the source image sits inside the model's square input, in mask pixels.
// Brush strokes are stored in image coordinates, so they have to be mapped
// through the same framing the prediction used.
export function maskPlacement(pred) {
  const SIZE = pred.size;
  const { side, ox, oy } = pred.frame ?? { side: 0, ox: 0, oy: 0 };
  if (!side) return { x: 0, y: 0, w: SIZE, h: SIZE };
  const k = SIZE / side;
  return { x: ox * k, y: oy * k, w: pred.width * k, h: pred.height * k };
}

// Paint one set of strokes into a mask-sized canvas as opaque black. Strokes
// carry normalised coordinates so they survive zoom and resizing.
export function rasterizeStrokes(strokes, pred) {
  const SIZE = pred.size;
  const c = canvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  const { x, y, w, h } = maskPlacement(pred);

  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    const radius = (stroke.size * Math.max(w, h)) / 2;
    ctx.lineWidth = radius * 2;
    const pt = (p) => [x + p.x * w, y + p.y * h];
    if (stroke.points.length === 1) {
      const [px, py] = pt(stroke.points[0]);
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const [px, py] = pt(p);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  return c;
}

// Turn a prediction into a mask canvas, applying the ramp and hole filling.
// Cheap: no model involved, so it can run on every slider movement.
export function toMaskCanvas(pred, opts = {}) {
  const { clean = profile.clean, fillHoles: fill = profile.fillHoles, strokes = [] } = opts;
  const raw = pred.data ?? pred;
  const SIZE = pred.size ?? size;

  let lo = raw[0];
  let hi = raw[0];
  for (const v of raw) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;

  const ramp = clean.hi - clean.lo;
  const img = new ImageData(SIZE, SIZE);
  // the model's own confidence, before the ramp squashes it; the remove brush
  // uses this to tell a slip from an instruction
  const norm = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const n = (raw[i] - lo) / span;
    norm[i] = n;
    let a = n;
    if (ramp > 0) a = (a - clean.lo) / ramp;
    img.data[i * 4 + 3] = Math.max(0, Math.min(1, a)) * 255;
  }
  if (fill) fillHoles(img.data, SIZE, SIZE);

  const c = canvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  ctx.putImageData(img, 0, 0);

  // Brush strokes are applied last, so they always beat the model and the
  // ramp. Green adds, red removes.
  const protect = opts.protect ?? profile.protect ?? 0;
  const protectShare = opts.protectShare ?? profile.protectShare ?? 0.25;

  // Drop the part of a remove stroke that landed on confident subject, unless
  // enough of the stroke is on confident subject that it was the target.
  // Judged per stroke: merging strokes first would let a careful dab elsewhere
  // change what a sloppy one does.
  const forgive = (painted) => {
    if (!protect) return painted;
    const kept = new Uint8Array(painted.length);
    let total = 0;
    let confident = 0;
    for (let i = 0; i < painted.length; i++) {
      if (!painted[i]) continue;
      total++;
      if (norm[i] < protect) kept[i] = 1;
      else confident++;
    }
    if (!total) return painted;
    return confident / total >= protectShare ? painted : kept;
  };

  const apply = (mode, value) => {
    const picked = strokes.filter((s) => s.mode === mode);
    if (!picked.length) return;
    const soften = mode === 'cut' ? forgive : (x) => x;

    const area = new Uint8Array(SIZE * SIZE);
    for (const stroke of picked) {
      const painted = soften(strokeMask([stroke], pred));
      const region = stroke.grow ? grow(pred, painted, stroke.grow) : painted;
      for (let i = 0; i < area.length; i++) if (region[i]) area[i] = 1;
    }

    const layer = new ImageData(SIZE, SIZE);
    for (let i = 0; i < area.length; i++) if (area[i]) layer.data[i * 4 + 3] = 255;
    const lc = canvas(SIZE, SIZE);
    lc.getContext('2d').putImageData(layer, 0, 0);

    ctx.globalCompositeOperation = value ? 'source-over' : 'destination-out';
    ctx.drawImage(lc, 0, 0);
  };

  apply('cut', false);
  apply('keep', true);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

// Composite a cached prediction onto the source image.
export function compose(bitmap, pred, opts = {}) {
  const mask = toMaskCanvas(pred, opts);
  const { side, ox, oy } = pred.frame ?? framing(bitmap);

  const c = canvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  if (side) {
    ctx.drawImage(mask, -ox, -oy, side, side); // crop the padding back off
  } else {
    ctx.drawImage(mask, 0, 0, c.width, c.height);
  }
  if (opts.bg) {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

export async function cutoutCanvas(bitmap, bg = null, model) {
  return compose(bitmap, await predict(bitmap, model), { bg });
}

export async function cutout(bitmap, bg = null, model) {
  const c = await cutoutCanvas(bitmap, bg, model);
  return c.convertToBlob({ type: 'image/png' });
}
