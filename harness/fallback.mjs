// The phone case, in its own process because getSession caches: once a page
// has a session, a later call cannot exercise the failure path.
//
// The configured model can be 178 MB running at 1024x1024, which a browser
// may refuse on memory alone. A dead page is a worse answer than a weaker
// mask, so the page drops to u2netp, which the build always includes.
import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';
import fs from 'node:fs';
import { modelBytes } from '../scripts/models.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const webDir = path.join(here, '..', 'web');

globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.canvas = createCanvas(w, h); this.width = w; this.height = h; }
  getContext(t, o) { return this.canvas.getContext(t, o); }
};
globalThis.ImageData = NapiImageData;

const bg = await import(path.join(webDir, 'bg.js'));
await bg.loadProfiles(
  JSON.parse(fs.readFileSync(path.join(webDir, 'profiles.json'), 'utf8')),
  'isnet-general-use',
);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

check('starts on the configured model', bg.profile.letterbox === true,
  `letterbox ${bg.profile.letterbox}`);

const refused = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const small = await modelBytes('u2netp');

// order matters: getSession caches, so once a session exists no later call
// can reach the failure path
let threw = false;
try {
  await bg.sessionWithFallback(refused, null, 'u2netp');
} catch {
  threw = true;
}
check('with no fallback offered it still throws', threw);

const fb = await bg.sessionWithFallback(refused, small, 'u2netp');
check('a refused model falls back instead of throwing', fb.fellBack === true);
check('the fallback returns a working session', !!fb.session);
check('it reports why it fell back', !!fb.error, fb.error?.message?.slice(0, 40));
check('the fallback profile is adopted, not the refused one',
  bg.profile.letterbox === false, `letterbox ${bg.profile.letterbox}`);

console.log(`\n${failures} failing`);
process.exit(failures ? 1 : 0);
