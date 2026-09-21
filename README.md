# bgremove

Background removal that runs in the browser tab. No image leaves the machine,
and there is no server: the whole thing is a static site.

```
pnpm install
pnpm build            # writes site/ with the default model
pnpm serve            # http://localhost:3000
```

`pnpm build --model u2netp` picks a model; `--out dir` writes somewhere other
than `site/`. Models are not in the repo. Whichever one you ask for is fetched
on first use into `~/.cache/bgremove` and copied into the site.

The default, and what GitHub Pages ships, is isnet-general-use with 8-bit
weights: 44 MB instead of 178, and within 0.05 points of the full model on
average across the fixtures. It is built locally from the full model rather
than downloaded, so the first build needs Python:

```
pip install -r scripts/requirements.txt
```

The toolchain is pinned because the quantizer is deterministic for a given
version and not across versions: pinned, it reproduces the exact file the
quality floors were measured on, byte for byte.

## Hosting it as a static site

`scripts/build.mjs` copies the page, the runtime, one model, and a service
worker into `site/`, and writes a `config.json` naming which model it put
there. That file matters more than it looks: without it the page falls back
to whatever `profiles.json` calls default, and one model's normalisation on
another's weights returns a blank mask rather than an error. Any static host
will serve the result.

Two constraints worth knowing before you push it.

**Headers.** Threads need SharedArrayBuffer, which needs
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`, and a static
host cannot set either. The build ships `coi-serviceworker`, which adds them to
every response client-side and reloads once on first visit. On a host that
sets the headers itself it does nothing. Without either, the page still works,
single-threaded, and the status line says so.

**Model size.** The model never goes into git: CI downloads it and puts it
straight into the deploy artifact, where the limit is 1 GB for the whole site.
GitHub's 100 MB file limit applies to repositories and does not come into it.
What does is bandwidth. Pages has a soft limit of 100 GB a month, and every
first visit downloads the model before the browser caches it. Full isnet
works out to 564 first visits per 100 GB; the int8 build to 1843.

The whole site is 60 MB: the 44 MB model, the 12 MB runtime, and u2netp at
4.5 MB as the fallback for devices that refuse the larger one.

`.github/workflows/pages.yml` does all of that on every push to `main`: frozen
install, `pnpm test`, the quality floors for the model being shipped, then the
build and the deploy. A failing test stops the deploy. It needs one
setting changed by hand, once: Settings, Pages, Source, set to GitHub Actions.

## Workflow

Drop an image and it opens on the stage, filling the centre of the window at
the image's own aspect ratio, with the tools down the right and finished work
down the left. One image is open at a time, deliberately: the point of the
layout is that the thing you are painting on is large enough to see where you
are painting.

Done files the open image onto the rail and clears the stage. Clicking
anything on the rail reopens it with its strokes, its ramp and its backdrop
intact, and files whatever was open back to the rail first, so exactly one is
ever editable. Dropping several images at once opens the first and queues the
rest; Done walks through them, and the footer says how many are waiting.

Everything except Letterbox re-renders from the cached prediction and is
effectively instant. Letterboxing changes what the model sees, so it re-runs
inference and the stage dims while it does.

### On a phone

The layout stacks: the rail becomes a thumbnail strip along the top, hidden
entirely in landscape, and the tools collapse to one group at a time behind a
Brush / Mask / Finish tab row, so the image keeps the screen. Height is `dvh`
so browser chrome sliding in and out does not crop the bottom, and the layout
respects the safe-area insets.

The paint layer only takes over touch gestures while a brush is selected. With
the brush off, scrolling and pinching work normally, which they did not in the
first version of this page.

The bigger problem is the model. isnet is 178 MB and runs at 1024x1024, and a
phone can refuse it on memory alone. If the configured model fails to load,
the page falls back to u2netp, which the build always includes for exactly
this and which `config.json` names, adopts that profile's defaults, and says so in the status line rather than leaving a dead
page. Building with `--model u2netp` avoids the question entirely, at a real
cost in quality.

None of the layout above has been tested. linkedom has no layout engine, so
the harness can check that the brush releases touch gestures and that the tabs
switch groups, but nothing about how any of it actually sizes on a device.

### Brush

Green keeps, red removes. While a brush is selected the original shows
faintly beneath the cutout, so the parts that were removed are still visible
to paint against. It sits under the cutout rather than over it, which keeps
the kept subject at full strength; only the transparent areas reveal it. Its
strength is the `--ghost` custom property on the stage, 0.2 by default. Paint on the open image to correct the model
directly: strokes are applied after the ramp and after hole filling, so they
always win. Undo drops the last stroke.

Red is forgiving on purpose. A remove stroke is usually aimed at background
near an edge, so the part of it that clips pixels the model is confident are
subject is treated as a slip and ignored: you take the background you crossed
without gouging what you are keeping.

That only applies while the clipped part is a minority of the stroke. Put a
quarter or more of a stroke on confident subject and you are aiming at it, so
it goes. Both numbers are in `profiles.json`, as `protect` and `protectShare`;
`protect: 0` makes red literal. Green gets no such treatment, because painting
green over confident background is how you recover something the model
dropped.

Painting the same place a second time is not a slip, though. Pixels covered by
two or more red strokes go whatever the model thinks, so if a spot survives
one pass, a second pass over it removes it. Only the overlap is forced; the
rest of each stroke is still judged as above, and strokes in different places
never add up.

Forgiveness is judged per stroke. Judging it across the whole set would let a
careful dab somewhere else change what a sloppy one does.

**Grow to edges** is what makes a dab useful. With it off, a stroke stamps the
brush shape and nothing more. With it on, the stroke is a seed: it spreads
into the surrounding region that matches what you painted, so one dab on a box
flap takes the whole flap. Growth stops at three limits, which is what keeps
it from swallowing the frame on a low-contrast subject:

- **Tolerance** is how far a pixel's colour may sit from the seed's average.
  The slider revises strokes already on the image, so you can paint once and
  then dial the spread.
- The model's own prediction may not drift more than 0.5 from the seed's, so a
  stroke cannot cross from subject into confident background.
- A radius of a quarter of the input, which bounds a runaway fill.

Growth spreads breadth-first from the seed, and the radius cap is counted in
steps taken rather than straight-line distance to the nearest seed pixel.
That keeps the cost linear in the image: measuring against every seed pixel
made it quadratic in brush area, and one wide stroke at 1024 locked the page
up for 15 seconds. Steps are the better measure anyway, since growth cannot
reach around a barrier it never crossed.

Growing works on the scaled input the model saw, not the full-resolution
photo, so it follows edges at the model's own resolution. Strokes themselves
are stored as normalised points rather than pixels and rasterised into the
model's coordinate space at compose time, so they survive a window resize and
land correctly whether or not letterboxing is on. Brush precision is bounded
by the model's input: 320 pixels for u2netp, 1024 for isnet.

Nothing here re-runs the model. Growing reads the cached prediction and the
cached scaled pixels, so it is the same instant path as the sliders.

If a setting works better than the default across several of your own photos,
change `profiles.json` in both builds rather than reaching for the sliders
each time.

## Where the settings live

Everything a model needs is in `web/profiles.json`: input normalisation, the
alpha ramp, whether to letterbox, whether to fill holes, how forgiving the
remove brush is. Nothing is hardcoded in the pipeline.

Three things drive the quality number. **Normalisation is per model**: u2net
uses the ImageNet constants, isnet uses 0.5 and 1.0, and feeding isnet the
wrong ones returns a blank mask rather than a slightly worse one.
**Letterboxing** pads onto a black square before scaling so a 3:4 photo is not
stretched into the square input; it is worth 12 points for isnet and actively
harmful for u2net, which was trained on squashed input. **The ramp and hole
filling** clear the low-confidence tail that ghosts the whole scene, and close
see-through patches where a dark logo on the subject reads as background.

## Layout

    web/bg.js     the image pipeline, no DOM in it
    web/app.js    event wiring only
    harness/      runs both outside a browser

`bg.js` touches exactly three browser APIs: `OffscreenCanvas`, `ImageData` and
the `ort` module. That is the whole reason it can be tested in Node.

## Tests

```
pnpm install                  # from the repo root; covers harness too
cd harness
pnpm test                     # pipeline, DOM workflow, fallback, static export
pnpm run quality              # output scored against reference cutouts
pnpm run browser              # the built page in a real Chrome
pnpm run check                # all three
```

`pnpm test` only needs u2netp. `pnpm run quality` grades every model in
`expected.json`, including the int8 build, so it needs the Python toolchain
above; `BGREMOVE_MODEL=u2netp pnpm run quality` grades one model and skips it.

`browser.mjs` builds the site and drives it in a real Chrome, because the Node
tests cannot see layout or use a real file picker, and bugs in both shipped.
It checks that a photo picked while the model is still downloading waits for it
instead of failing, that the preview and the guide share one box on screen
throughout processing, and that picking the same photo twice works. It uses
`CHROME_PATH` if set, then a local Chrome, then the Chromium bundled in
`@sparticuz/chromium`, which is Linux only and is what CI uses.

Tests fetch any model they need rather than skipping. They used to print a note
and exit 0 when a model was missing, which on a fresh CI runner means every one
of them passes without testing anything.

`quality.mjs` runs each model in its own process, because `bg.js` keeps one
session the way a page does. It fetches any model it does not find in
`~/.cache/bgremove` rather than skipping, since a skipped quality check is how
a broken model stays broken. Scoring happens on a grid capped at 1024 pixels
on the long edge: at full resolution several 12-megapixel canvases live
alongside a 1.3 GB wasm heap, and the run dies partway through on a modest
machine. Floors in `expected.json` are recorded at that size.

Thirteen fixtures: one photo of mine, plus twelve portraits from the P3M demo
set, which ships hand-annotated ground truth alpha under MIT.

| | mean | worst | below 90% |
|---|---|---|---|
| u2netp | 83.4% | 38.2% | 4 of 13 |
| isnet-general-use | 89.5% | 59.6% | 3 of 13 |
| isnet-general-use-int8 | 89.5% | 59.7% | 3 of 13 |

isnet is better on 9 of the 13, and u2netp's losses are the bad kind: it
drops 16 to 22% of the subject on three portraits, where isnet takes one of
them from 47.4% to 96.6%. isnet is not better everywhere, though: on one image
it keeps 11.3% extra background and scores 62.2% against u2netp's 94.1%.

The int8 build is within 0.05 points of full isnet on average, and its largest
drop on any single fixture is 0.8.

### Scoring a click refiner

`pnpm run clicks` measures how well corrective clicks actually fix a mask. It
is the standard interactive-segmentation evaluation: clicks are placed
automatically, each at the centre of the largest region where the current mask
disagrees with the reference, positive where subject is missing and negative
where background is being kept. The number reported is clicks needed to reach
a target IoU, which is comparable to the NoC figures RITM and FocalClick
publish.

The brush that ships today, on the cat fixture:

| base model | IoU trajectory | clicks to 95% |
|---|---|---|
| u2netp | 78.4 -> 87.7 -> 95.1 | 2 |
| isnet-general-use | 92.8 -> 95.3 | 1 |

A candidate model plugs in behind the same interface:

```
node clicks.mjs --refiner ./my-refiner.mjs
```

See `refiner-template.mjs` for the shape. `init(ctx)` runs once per image and
is where a session gets loaded; `refine({ mask, clicks, width, height })` runs
once per click and returns the corrected mask. FocalClick and RITM both take
image, two click maps and the previous mask, which maps onto `refine`
directly. The point of the interface is that a click model and a paint brush
are interchangeable behind it, so a candidate is compared against what already
ships before it touches the app.

`BGREMOVE_TARGET`, `BGREMOVE_CLICKS` and `BGREMOVE_MODEL` adjust the target
IoU, the click budget and the base model.

`run.mjs` shims those three APIs and runs the real pipeline, checking the
tensor shape and normalised range, that the output alpha matches rembg's
u2netp reference within 3/255, that the backdrop path produces a fully opaque
image in the requested colour, and that the session is reused between images.

It also checks that the ramp cuts the faint-alpha band, that the input size
comes from the model rather than a constant, that letterboxing centres on the
long side and returns output at the source size, and that hole filling closes
an enclosed hole without touching the outside.



`dom.mjs` parses `index.html` with linkedom, imports `app.js` unmodified, and
dispatches synthetic dragover/dragleave/drop events: non-images are ignored,
the card goes working then done, the Save link picks up the `.cutout.png`
name, and an undecodable file marks its own card failed without disturbing
the others.

Not covered: the browser's own bilinear scaling in `drawImage` (node-canvas
does its own, close but not identical), `convertToBlob`, and the relative-URL
model fetch, since Node takes the model as bytes instead.

## Swapping the model

Add an entry to `profiles.json` and build with `--model <name>`. The input
resolution comes from the model's own metadata, so nothing in the code
changes. Every model is fetched on first use into `~/.cache/bgremove`; none
are vendored. Add a floor for it in `harness/expected.json` so it is covered
by `pnpm run quality`.

| name | size | license | |
|---|---|---|---|
| `isnet-general-use-int8` | 44 MB | Apache-2.0 | the default and what Pages ships; built by `scripts/quantize.py` |
| `isnet-general-use` | 178 MB | Apache-2.0 | the full model the int8 build comes from |
| `u2netp` | 4.5 MB | Apache-2.0 | the fallback when a device refuses the default |
| `u2net` | 176 MB | Apache-2.0 | |
| `silueta` | 44 MB | Apache-2.0 | |

rembg's own default, `bria-rmbg`, is non-commercial only and is deliberately
not listed.
