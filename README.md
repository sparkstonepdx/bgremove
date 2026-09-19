# bgremove

Background removal that runs in the browser tab. One Go binary serves a page
that does the inference locally; no image leaves the machine and nothing is
uploaded anywhere.

```
cd wasm
npm install                          # the ONNX Runtime the page loads
CGO_ENABLED=0 go build -o bgremove .
./bgremove                           # http://127.0.0.1:7734
```

`npm install` is a build prerequisite, not a convenience: the binary embeds
the runtime out of `node_modules`, so `go build` fails without it.

## Tests

```
cd wasm/harness && npm install
npm test       # pipeline, DOM workflow, model fallback
npm run quality  # output scored against reference cutouts, fails on regression
npm run check    # both
npm run clicks   # how many corrective clicks it takes to reach 95% IoU
```

`npm run quality` is the one that matters most. Everything else checks that
the machinery runs, and a model fed the wrong normalisation constants runs
perfectly while returning a blank mask. Floors live in
`wasm/harness/expected.json`; fixtures are `<name>.jpg` plus `<name>.ref.png`
in `wasm/harness/fixtures/`, where the reference is a real cutout.

Current numbers on the one fixture, mask IoU against an erase.bg cutout:
u2netp 78.6%, isnet-general-use 92.8%. One reference photo is a sample of
one, so more pairs are worth more than more tuning.

Models are Apache-2.0 or MIT and fetched on first use into
`~/.cache/bgremove`. rembg's own default, bria-rmbg, is non-commercial only
and is not used.
