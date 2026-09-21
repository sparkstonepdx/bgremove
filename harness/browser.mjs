// Runs the built site in a real Chrome, for the bugs linkedom cannot see: it
// has no layout engine and no real file picker, and both of these shipped
// because of that.
//
//   pnpm run browser
//
// Uses CHROME_PATH if set, then a local Chrome, then the Chromium bundled in
// @sparticuz/chromium on Linux, which is what CI and the sandbox this was
// written in use.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fixture = (name) => path.join(here, 'fixtures', name);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]) if (fs.existsSync(p)) return p;
  const { default: chromium } = await import('@sparticuz/chromium');
  return { path: await chromium.executablePath(), args: chromium.args };
}

// A static server that can hold the model back, to open the window in which
// a person picks a photo before the model has arrived.
function serve(dir, { modelDelay = 0 } = {}) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    if (modelDelay && file.endsWith('model.onnx')) await new Promise((r) => setTimeout(r, modelDelay));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () =>
    r({ close: () => server.close(), url: `http://localhost:${server.address().port}/` })));
}

const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bgbrowser-'));
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--model', 'u2netp', '--out', site],
  { stdio: 'pipe' });

const found = await chromePath();
const browser = await puppeteer.launch({
  executablePath: typeof found === 'string' ? found : found.path,
  args: typeof found === 'string' ? [] : found.args,
  headless: true,
});

async function openPage(server) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  // On a first visit coi-serviceworker registers and then reloads the page,
  // about 100ms in. No person clicks that fast, but a test does, and a click
  // that lands across the reload is lost. Wait until the worker controls the
  // page, which is only true after that reload.
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 15000 });
  await page.waitForSelector('#drop');
  return page;
}
const statusOf = (page) => page.$eval('#status', (e) => e.textContent);
const until = (page, re, ms = 60000) => page.waitForFunction(
  (src) => new RegExp(src).test(document.getElementById('status').textContent), { timeout: ms }, re.source,
).then(() => true, () => false);
async function pick(page, name) {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#drop')]);
  await chooser.accept([fixture(name)]);
}

// 1. a photo picked while the model is still downloading
{
  const server = await serve(site, { modelDelay: 3000 });
  const page = await openPage(server);
  await pick(page, 'cat.jpg');
  await new Promise((r) => setTimeout(r, 500));
  check('a photo picked during the model download stays open',
    await page.$eval('body', (b) => b.classList.contains('editing')), await statusOf(page));
  check('it says it is waiting for the model', /will start once/.test(await statusOf(page)),
    await statusOf(page));
  check('it processes once the model arrives', await until(page, /done in/), await statusOf(page));
  await page.close();
  server.close();
}

// 2. layout while processing: one box for the stage, the preview and the guide
{
  const server = await serve(site);
  const page = await openPage(server);
  await until(page, /^Ready/);
  await pick(page, 'cat.jpg');
  const samples = [];
  while (!(await page.evaluate(() => /done in/.test(document.getElementById('status').textContent)))) {
    samples.push(await page.evaluate(() => {
      const box = (id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        return `${Math.round(b.width)}x${Math.round(b.height)}`;
      };
      const stage = document.getElementById('stage');
      return {
        visible: getComputedStyle(stage).visibility === 'visible',
        busy: stage.classList.contains('busy'),
        stage: box('stage'), preview: box('preview'), ghost: box('ghost'),
        ghost_opacity: Number(getComputedStyle(document.getElementById('ghost')).opacity),
      };
    }));
    await new Promise((r) => setTimeout(r, 50));
    if (samples.length > 400) break;
  }
  const busy = samples.filter((s) => s.busy);
  const shown = samples.filter((s) => s.visible);
  check('the layout was sampled while processing', busy.length > 0, `${busy.length} samples`);
  check('the stage becomes visible while still processing',
    busy.some((s) => s.visible), `${busy.filter((s) => s.visible).length} of ${busy.length}`);
  // What matters is what is on screen: the stage is hidden until it is fitted,
  // so a mismatch in a hidden frame is never seen.
  const mismatched = shown.filter((s) => s.preview !== s.stage || s.ghost !== s.stage);
  check('whenever the stage is visible, the preview and the guide share its box',
    mismatched.length === 0,
    mismatched[0] ? JSON.stringify(mismatched[0]) : `${shown.length} visible samples`);
  check('the guide is hidden while processing', busy.every((s) => s.ghost_opacity === 0),
    JSON.stringify(busy.find((s) => s.ghost_opacity !== 0) || {}));

  // after processing: hidden with the brush off, shown with a brush selected
  await new Promise((r) => setTimeout(r, 300));
  const opacity = () => page.$eval('#ghost', (g) => Number(getComputedStyle(g).opacity));
  check('with the brush off the guide stays hidden', (await opacity()) === 0, String(await opacity()));
  await page.evaluate(() => document.querySelector('input[name=tool][value=cut]').closest('label').click());
  await new Promise((r) => setTimeout(r, 300));
  check('with a brush selected the guide shows, faintly',
    (await opacity()) > 0.1 && (await opacity()) < 0.3, String(await opacity()));
  await page.close();
  server.close();
}

// 3. the same photo picked twice
{
  const server = await serve(site);
  const page = await openPage(server);
  await until(page, /^Ready/);
  await pick(page, 'test.png');
  check('a photo picked from the dialog processes', await until(page, /done in/, 30000));
  await page.evaluate(() => {
    document.getElementById('status').textContent = '';
    document.getElementById('done').click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await pick(page, 'test.png');
  check('picking the same photo again processes it too', await until(page, /done in/, 30000),
    await statusOf(page));
  await page.close();
  server.close();
}

await browser.close();
fs.rmSync(site, { recursive: true, force: true });
console.log(`\n${failures} failing`);
process.exit(failures ? 1 : 0);
