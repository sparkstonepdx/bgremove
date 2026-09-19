// DOM wiring for a one-image-at-a-time editor. The image work lives in bg.js.
//
// One item is open at a time and fills the stage; finished ones go to the rail
// and can be reopened with their strokes and settings intact. Everything a
// control does re-composites from the cached prediction, so only Letterbox
// costs another model run.
import { compose, getSession, loadProfiles, predict, profile, sessionWithFallback, threadCount } from './bg.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const preview = $('preview');
const paint = $('paint');
const status = $('status');
const picker = Object.assign(document.createElement('input'), {
  type: 'file', accept: 'image/*', multiple: true,
});

const finished = [];   // items the person marked done
const queued = [];     // dropped together, opened one at a time
let current = null;
let defaults = null;
let queue = Promise.resolve();

const tool = () => document.querySelector('input[name=tool]:checked')?.value || 'off';

function newItem(file) {
  return {
    file,
    strokes: [],
    settings: {
      clean: { ...profile.clean },
      fillHoles: profile.fillHoles,
      letterbox: profile.letterbox,
      bg: null,
    },
  };
}

// ---------------------------------------------------------------- rendering

function settings() {
  return {
    clean: { lo: Number($('lo').value), hi: Number($('hi').value) },
    fillHoles: $('fill').checked,
    letterbox: $('letterbox').checked,
    bg: $('usebg').checked ? $('bg').value : null,
  };
}

function render() {
  if (!current?.pred) return;
  // Capture the item. Encoding a large PNG takes long enough that the person
  // can file this one away and open another before it resolves, and a
  // callback that reads `current` at that point writes one image's pixels
  // onto another's card.
  const item = current;
  item.settings = settings();
  const canvas = compose(item.bitmap, item.pred, {
    ...item.settings,
    strokes: item.strokes,
  });
  canvas.convertToBlob({ type: 'image/png' }).then((blob) => {
    const url = URL.createObjectURL(blob);
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = url;
    if (item.li) item.li.querySelector('img').src = url;
    if (item !== current) return;
    preview.src = url;
    $('save').href = url;
    $('save').download = item.file.name.replace(/\.[^.]+$/, '') + '.cutout.png';
  });
}

// The stage carries the image's aspect ratio so the paint layer sits exactly
// over the pixels. Anything else and a stroke lands where it was not drawn.
function fitStage(bitmap) {
  stage.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
  requestAnimationFrame(() => {
    paint.width = stage.clientWidth;
    paint.height = stage.clientHeight;
    drawStrokes();
  });
}

function drawStrokes() {
  const ctx = paint.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, paint.width, paint.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of current?.strokes || []) {
    ctx.strokeStyle = stroke.mode === 'keep' ? 'rgba(67,209,122,.5)' : 'rgba(232,86,74,.5)';
    ctx.fillStyle = ctx.strokeStyle;
    const radius = (stroke.size * Math.max(paint.width, paint.height)) / 2;
    ctx.lineWidth = radius * 2;
    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(stroke.points[0].x * paint.width, stroke.points[0].y * paint.height, radius, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const px = p.x * paint.width;
      const py = p.y * paint.height;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- opening

function adopt(item) {
  $('lo').value = item.settings.clean.lo;
  $('hi').value = item.settings.clean.hi;
  $('fill').checked = item.settings.fillHoles;
  $('letterbox').checked = item.settings.letterbox;
  $('usebg').checked = item.settings.bg !== null;
  if (item.settings.bg) $('bg').value = item.settings.bg;
  profile.letterbox = item.settings.letterbox;
  readouts();
}

function open(item) {
  current = item;
  document.body.classList.add('editing');
  adopt(item);
  preview.src = item.url || URL.createObjectURL(item.file);
  status.textContent = item.pred ? `Editing ${item.file.name}` : `Removing background from ${item.file.name}`;

  if (item.bitmap) {
    fitStage(item.bitmap);
    render();
    return;
  }

  stage.classList.add('busy');
  queue = queue.then(async () => {
    const started = performance.now();
    try {
      item.bitmap = await createImageBitmap(item.file);
      fitStage(item.bitmap);
      item.pred = await predict(item.bitmap);
      stage.classList.remove('busy');
      if (current === item) render();
      status.textContent = `${item.file.name} done in ${((performance.now() - started) / 1000).toFixed(1)}s`;
    } catch (err) {
      stage.classList.remove('busy');
      status.textContent = `${item.file.name}: ${err.message}`;
      if (current === item) close();
    }
  });
}

function close() {
  current = null;
  document.body.classList.remove('editing');
  preview.removeAttribute('src');
  drawStrokes();
}

function showQueue() {
  $('queue').textContent = queued.length ? `${queued.length} waiting` : '';
}

function next() {
  const item = queued.shift();
  showQueue();
  if (item) open(item);
  else close();
}

// ---------------------------------------------------------------- rail

function railAdd(item) {
  $('railempty').hidden = true;
  const li = document.createElement('li');
  li.innerHTML = '<div class="thumb"><img alt=""></div><div class="label"></div>';
  li.querySelector('img').src = item.url;
  li.querySelector('.label').textContent = item.file.name;
  li.addEventListener('click', () => reopen(item));
  item.li = li;
  $('finished').prepend(li);
}

// Reopening puts the current image back on the rail first, so exactly one is
// ever open.
function reopen(item) {
  if (current === item) return;
  if (current) finish();
  const at = finished.indexOf(item);
  if (at >= 0) finished.splice(at, 1);
  item.li?.remove();
  item.li = null;
  open(item);
}

function finish() {
  if (!current?.pred) return false; // still working; leave it open
  const item = current;
  finished.push(item);
  railAdd(item);
  current = null;
  return true;
}

// ---------------------------------------------------------------- input

function accept(list) {
  const files = [...list].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const items = files.map(newItem);
  if (current) finish();
  queued.push(...items);
  next();
}

$('drop').addEventListener('click', () => picker.click());
$('drop').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); }
});
picker.addEventListener('change', () => accept(picker.files));
for (const target of [$('drop'), stage]) {
  target.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
  target.addEventListener('dragleave', () => $('drop').classList.remove('over'));
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    $('drop').classList.remove('over');
    accept(e.dataTransfer.files);
  });
}
window.addEventListener('paste', (e) => accept(e.clipboardData.files));
window.addEventListener('resize', () => { if (current?.bitmap) fitStage(current.bitmap); });

// ---------------------------------------------------------------- painting

let active = null;
const at = (e) => {
  const r = paint.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
};

paint.addEventListener('pointerdown', (e) => {
  if (tool() === 'off' || !current?.pred) return;
  e.preventDefault();
  paint.setPointerCapture?.(e.pointerId);
  active = {
    mode: tool(),
    size: Number($('brush').value),
    grow: growth(),
    points: [at(e)],
  };
  current.strokes.push(active);
  drawStrokes();
});
paint.addEventListener('pointermove', (e) => {
  if (!active) return;
  active.points.push(at(e));
  drawStrokes();
});
const endStroke = () => { if (active) { active = null; render(); } };
for (const ev of ['pointerup', 'pointercancel']) {
  paint.addEventListener(ev, endStroke);
}

// ---------------------------------------------------------------- controls

function readouts() {
  $('loval').textContent = Number($('lo').value).toFixed(2);
  $('hival').textContent = Number($('hi').value).toFixed(2);
  $('brushval').textContent = Number($('brush').value).toFixed(2);
  $('tolval').textContent = Number($('tol').value).toFixed(2);
}

function growth() {
  return $('smart').checked
    ? { tolerance: Number($('tol').value), radius: 0.25 }
    : null;
}

function rerun() {
  if (!current?.bitmap) return;
  const item = current;
  profile.letterbox = $('letterbox').checked;
  stage.classList.add('busy');
  queue = queue.then(async () => {
    item.pred = await predict(item.bitmap);
    stage.classList.remove('busy');
    if (current === item) render();
    status.textContent = 'Re-ran with letterbox ' + (profile.letterbox ? 'on' : 'off');
  });
}

for (const id of ['lo', 'hi']) {
  $(id).addEventListener('input', () => {
    const lo = Number($('lo').value);
    const hi = Number($('hi').value);
    if (lo >= hi) {
      if (id === 'lo') $('hi').value = Math.min(1, lo + 0.05);
      else $('lo').value = Math.max(0, hi - 0.05);
    }
    readouts();
    render();
  });
}
for (const id of ['fill', 'usebg', 'bg']) $(id).addEventListener('input', render);
$('brush').addEventListener('input', readouts);
$('tol').addEventListener('input', () => {
  readouts();
  for (const stroke of current?.strokes || []) {
    if (stroke.grow) stroke.grow = { ...stroke.grow, tolerance: Number($('tol').value) };
  }
  render();
});
$('smart').addEventListener('change', () => {
  for (const stroke of current?.strokes || []) stroke.grow = growth();
  render();
});
document.querySelector('.tools-row').addEventListener('change', () => {
  // the paint layer only swallows touch gestures while a brush is selected
  document.body.classList.toggle('brushing', tool() !== 'off');
});

// On a phone the panel shows one group at a time; on a wide screen the tab
// row is hidden and every group is visible, so this is inert there.
$('tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-for]');
  if (!button) return;
  $('panel').dataset.tab = button.dataset.for;
  for (const b of $('tabs').children) b.classList.toggle('on', b === button);
});
$('letterbox').addEventListener('change', rerun);
$('undo').addEventListener('click', () => {
  if (!current?.strokes.length) return;
  current.strokes.pop();
  drawStrokes();
  render();
});
$('clearstrokes').addEventListener('click', () => {
  if (!current?.strokes.length) return;
  current.strokes.length = 0;
  drawStrokes();
  render();
});
$('reset').addEventListener('click', () => {
  if (!defaults || !current) return;
  $('lo').value = defaults.clean.lo;
  $('hi').value = defaults.clean.hi;
  $('fill').checked = defaults.fillHoles;
  $('usebg').checked = false;
  readouts();
  const changed = $('letterbox').checked !== defaults.letterbox;
  $('letterbox').checked = defaults.letterbox;
  current.strokes.length = 0;
  drawStrokes();
  if (changed) rerun();
  else render();
});
$('done').addEventListener('click', () => {
  if (!current?.pred) return;
  finish();
  next();
  $('panel').dataset.tab = 'brush';
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.for === 'brush');
});

// ---------------------------------------------------------------- boot

let fellBack = false;

status.textContent = 'Loading model';
fetch('./config.json')
  .then((r) => (r.ok ? r.json() : { model: undefined }))
  .catch(() => ({ model: undefined }))
  .then((cfg) => loadProfiles('./profiles.json', cfg.model))
  .then((p) => {
    defaults = {
      clean: { ...profile.clean },
      fillHoles: profile.fillHoles,
      letterbox: profile.letterbox,
    };
    $('lo').value = profile.clean.lo;
    $('hi').value = profile.clean.hi;
    $('fill').checked = profile.fillHoles;
    $('letterbox').checked = profile.letterbox;
    readouts();
    status.textContent = `Loading model (${Math.round(p.bytes / (1 << 20))} MB)`;
    return sessionWithFallback('./model.onnx', './u2netp.onnx', 'u2netp');
  })
  .then((result) => {
    if (result.fellBack) {
      fellBack = true;
      console.warn('falling back to u2netp:', result.error);
      defaults = {
        clean: { ...profile.clean },
        fillHoles: profile.fillHoles,
        letterbox: profile.letterbox,
      };
      $('lo').value = profile.clean.lo;
      $('hi').value = profile.clean.hi;
      $('fill').checked = profile.fillHoles;
      $('letterbox').checked = profile.letterbox;
      readouts();
    }

    const threads = globalThis.crossOriginIsolated
      ? `${threadCount()} threads`
      : 'single thread (page is not cross-origin isolated)';
    status.textContent = fellBack
      ? `Ready on the small model, ${threads}. The full one would not load here.`
      : `Ready, ${threads}`;
  })
  .catch((err) => {
    status.textContent = 'Model failed to load: ' + err.message;
  });
