// Click simulation, kept pure so the rig itself can be tested. Nothing here
// touches a canvas or a model.

export function iou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 1;
}

// Label connected components of `on`, return them largest first.
export function components(on, w, h) {
  const seen = new Uint8Array(w * h);
  const found = [];
  const stack = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue;
    const pixels = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % w;
      const push = (j) => { if (j >= 0 && j < on.length && on[j] && !seen[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      push(i - w);
      push(i + w);
    }
    found.push(pixels);
  }
  return found.sort((a, b) => b.length - a.length);
}

// The pixel of a component furthest from anything outside it, which is where a
// person would click: the middle of the blob, not its edge.
export function deepestPoint(pixels, on, w, h) {
  const inside = new Set(pixels);
  const dist = new Map();
  const queue = [];
  for (const i of pixels) {
    const x = i % w;
    const y = (i - x) / w;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
      || !inside.has(i - 1) || !inside.has(i + 1)
      || !inside.has(i - w) || !inside.has(i + w);
    if (edge) { dist.set(i, 0); queue.push(i); }
  }
  let best = pixels[0];
  let bestD = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const d = dist.get(i);
    if (d > bestD) { bestD = d; best = i; }
    const x = i % w;
    const step = (j) => {
      if (!inside.has(j) || dist.has(j)) return;
      dist.set(j, d + 1);
      queue.push(j);
    };
    if (x > 0) step(i - 1);
    if (x < w - 1) step(i + 1);
    step(i - w);
    step(i + w);
  }
  return { index: best, depth: bestD };
}

// The next click a person would make: the middle of the biggest mistake.
export function nextClick(mask, truth, w, h) {
  const missed = new Uint8Array(w * h);
  const extra = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (truth[i] && !mask[i]) missed[i] = 1;
    if (!truth[i] && mask[i]) extra[i] = 1;
  }
  const a = components(missed, w, h)[0];
  const b = components(extra, w, h)[0];
  const pickMissed = (a?.length || 0) >= (b?.length || 0);
  const pixels = pickMissed ? a : b;
  if (!pixels || pixels.length < 16) return null;
  const { index } = deepestPoint(pixels, pickMissed ? missed : extra, w, h);
  const x = index % w;
  const y = (index - x) / w;
  return { x: (x + 0.5) / w, y: (y + 0.5) / h, label: pickMissed ? 1 : 0, size: pixels.length };
}

