// Drives web/app.js against a fake DOM to check the editing workflow: one
// image open at a time, finished work on the rail, and reopening an old one
// without losing its strokes. The image work it calls into is the same bg.js
// the page uses; this file only supplies the browser objects Node lacks.
import { parseHTML } from 'linkedom';
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
const webDir = path.join(here, '..', 'web');

// ---------------------------------------------------------------- shims

class OffscreenCanvasShim {
  constructor(width, height) {
    this.canvas = createCanvas(width, height);
    this.width = width;
    this.height = height;
  }
  getContext(type, opts) { return this.canvas.getContext(type, opts); }
  async convertToBlob() {
    return new Blob([await this.canvas.encode('png')], { type: 'image/png' });
  }
}
globalThis.OffscreenCanvas = OffscreenCanvasShim;
globalThis.ImageData = NapiImageData;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const proto = createCanvas(1, 1).getContext('2d').constructor.prototype;
const realDraw = proto.drawImage;
proto.drawImage = function (img, ...rest) {
  return realDraw.call(this, img instanceof OffscreenCanvasShim ? img.canvas : img, ...rest);
};

const bytes = new WeakMap();
class FakeFile {
  constructor(buf, name, type) {
    this.name = name;
    this.type = type;
    bytes.set(this, buf);
  }
}
globalThis.createImageBitmap = async (src) => {
  const img = await loadImage(bytes.get(src) || src);
  img.close = () => {};
  return img;
};

let urls = 0;
globalThis.URL = Object.assign(globalThis.URL, { createObjectURL: () => `blob:fake/${++urls}` });

globalThis.fetch = async (url) => {
  const name = String(url).replace(/^\.\//, '');
  if (name === 'config.json') return { ok: true, json: async () => ({ model: 'u2netp' }) };
  const file = path.join(webDir, name);
  if (!fs.existsSync(file)) return { ok: false, json: async () => ({}) };
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const { window, document } = parseHTML(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8'));
globalThis.window = window;
globalThis.document = document;

// linkedom has an HTMLCanvasElement with no drawing backend, and no layout, so
// the paint layer would silently do nothing. Back it with a real canvas and
// give the stage a size.
const CanvasProto = Object.getPrototypeOf(document.createElement('canvas'));
CanvasProto.getContext = function (type, opts) {
  const w = Number(this.width) || 300;
  const h = Number(this.height) || 150;
  if (!this._napi || this._w !== w || this._h !== h) {
    this._napi = createCanvas(w, h);
    this._w = w;
    this._h = h;
  }
  return this._napi.getContext(type, opts);
};
const ElementProto = Object.getPrototypeOf(document.createElement('div'));
Object.defineProperty(ElementProto, 'clientWidth', { get() { return 600; }, configurable: true });
Object.defineProperty(ElementProto, 'clientHeight', { get() { return 800; }, configurable: true });

const bg = await import(path.join(webDir, 'bg.js'));
const model = new Uint8Array(fs.readFileSync(modelPath('u2netp')));
// pinned to the embedded model, not the table default
await bg.loadProfiles(JSON.parse(fs.readFileSync(path.join(webDir, 'profiles.json'), 'utf8')), 'u2netp');
await bg.getSession(model);

await import(path.join(webDir, 'app.js'));
await new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------- helpers

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const $ = (id) => document.getElementById(id);
const editing = () => document.body.classList.contains('editing');
const railItems = () => [...$('finished').children];
const shot = () => $('preview').getAttribute('src');
const settle = (ms = 6000) => new Promise((r) => setTimeout(r, ms));

const imageFile = (name) =>
  new FakeFile(fs.readFileSync(path.join(here, 'fixtures', 'test.png')), name, 'image/png');

const dropFiles = (files) => {
  $('drop').dispatchEvent(Object.assign(new window.Event('drop'), {
    preventDefault: () => {}, dataTransfer: { files },
  }));
};

const pickTool = (value) => {
  for (const r of document.querySelectorAll('input[name=tool]')) {
    if (r.getAttribute('value') === value) r.setAttribute('checked', '');
    else r.removeAttribute('checked');
  }
};

// ---------------------------------------------------------------- checks

check('model loaded on page open', $('status').textContent.startsWith('Ready'),
  $('status').textContent);
check('nothing is open before an upload', !editing());
check('the rail starts empty', railItems().length === 0);

// one image opens straight into the editor
dropFiles([imageFile('first.png'), new FakeFile(Buffer.from('x'), 'notes.txt', 'text/plain')]);
check('a drop opens the editor', editing());
check('non-images are ignored', $('queue').textContent === '', $('queue').textContent);
await settle();
check('the image finished processing', /done in/.test($('status').textContent),
  $('status').textContent);
check('the save link is named after the file',
  $('save').getAttribute('download') === 'first.cutout.png', $('save').getAttribute('download'));
check('the stage carries the image aspect ratio',
  /\d+ \/ \d+/.test($('stage').style.aspectRatio || ''), $('stage').style.aspectRatio);

// the controls act on the open image
const beforeRamp = shot();
$('lo').value = '0.6';
$('lo').dispatchEvent(new window.Event('input'));
await settle(500);
check('a slider re-renders the open image', shot() !== beforeRamp);
check('the readout follows', $('loval').textContent === '0.60', $('loval').textContent);
check('a slider does not re-run the model', !$('stage').classList.contains('busy'));

// painting
const beforePaint = shot();
$('paint').getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 });
pickTool('cut');
$('paint').dispatchEvent(Object.assign(new window.Event('pointerdown'), {
  preventDefault: () => {}, clientX: 300, clientY: 400, pointerId: 1,
}));
$('paint').dispatchEvent(Object.assign(new window.Event('pointermove'), {
  clientX: 320, clientY: 420, pointerId: 1,
}));
$('paint').dispatchEvent(Object.assign(new window.Event('pointerup'), { pointerId: 1 }));
await settle(800);
check('a stroke re-renders the open image', shot() !== beforePaint);
const painted = shot();
pickTool('off');

// done moves it to the rail and clears the stage
$('done').dispatchEvent(new window.Event('click'));
await settle(300);
check('done closes the editor', !editing());
check('done puts the image on the rail', railItems().length === 1);
check('the rail shows the file name',
  railItems()[0].querySelector('.label').textContent === 'first.png',
  railItems()[0].querySelector('.label').textContent);
check('the rail thumbnail is the edited result',
  railItems()[0].querySelector('img').getAttribute('src') === painted);

// a second batch queues rather than opening together
dropFiles([imageFile('second.png'), imageFile('third.png')]);
await settle();
check('only one of a batch opens', editing() && railItems().length === 1);
check('the rest are shown as waiting', $('queue').textContent === '1 waiting',
  $('queue').textContent);
check('the open one is the first of the batch',
  $('save').getAttribute('download') === 'second.cutout.png', $('save').getAttribute('download'));

$('done').dispatchEvent(new window.Event('click'));
await settle();
check('done advances to the queued image', editing(), $('status').textContent);
check('the queue empties', $('queue').textContent === '', $('queue').textContent);
check('the finished one joined the rail', railItems().length === 2, String(railItems().length));

// reopening an old one
railItems()[railItems().length - 1].dispatchEvent(new window.Event('click'));
await settle(600);
check('clicking the rail reopens that image', editing());
check('reopening files the previous one back to the rail', railItems().length === 2,
  String(railItems().length));
check('the reopened image is the one clicked',
  $('save').getAttribute('download') === 'first.cutout.png', $('save').getAttribute('download'));
check('its ramp came back with it', $('loval').textContent === '0.60', $('loval').textContent);
// undo only does anything if a stroke came back with the image
const reopened = shot();
$('undo').dispatchEvent(new window.Event('click'));
await settle(600);
check('its strokes came back with it', shot() !== reopened);

// touch behaviour: the paint layer must not swallow gestures unless a brush
// is selected, or the page cannot be scrolled or pinched on a phone
const toolsRow = document.querySelector('.tools-row');
pickTool('keep');
toolsRow.dispatchEvent(new window.Event('change'));
check('selecting a brush marks the body for painting',
  document.body.classList.contains('brushing'));
pickTool('off');
toolsRow.dispatchEvent(new window.Event('change'));
check('turning the brush off releases touch gestures',
  !document.body.classList.contains('brushing'));

// the panel shows one group at a time on a phone
const tab = (name) => {
  const b = [...$('tabs').children].find((x) => x.dataset.for === name);
  b.dispatchEvent(Object.assign(new window.Event('click', { bubbles: true }), { target: b }));
};
tab('mask');
check('a tab switches the panel group', $('panel').dataset.tab === 'mask',
  $('panel').dataset.tab);
check('the tab marks itself selected',
  [...$('tabs').children].filter((b) => b.classList.contains('on')).length === 1);

// the race that made reopening look broken: a render in flight when the
// person clicks the rail must not land its pixels on the newly opened image
$('lo').value = '0.55';
$('lo').dispatchEvent(new window.Event('input'));
const oldest = railItems()[railItems().length - 1];
const oldestName = oldest.querySelector('.label').textContent;
oldest.querySelector('img').dispatchEvent(new window.Event('click', { bubbles: true }));
await settle(1200);
check('a click during a render still reopens the clicked image',
  $('save').getAttribute('download') === oldestName.replace('.png', '.cutout.png'),
  $('save').getAttribute('download'));
check('the editor is open after that click', editing());

// a file that cannot be decoded should not leave a broken editor open
dropFiles([new FakeFile(Buffer.from('\x89PNG\r\n\x1a\nbroken'), 'broken.png', 'image/png')]);
await settle(1500);
check('an undecodable image closes the editor', !editing(), $('status').textContent);
check('it is not added to the rail', railItems().length === 3, String(railItems().length));

console.log(`\n${failures} failing`);
process.exit(failures ? 1 : 0);
