# bgremove

Two takes on local background removal. Both are Go, both keep every image on
the machine, and both use the same ONNX segmentation models.

    native/   CLI and local server. Real batch mode. Needs cgo and the
              ONNX Runtime shared library, which it downloads on first run.

    wasm/     Inference in the browser tab. No cgo, single static binary,
              cross-compiles anywhere Go does. Ships u2netp embedded and
              fetches any larger model once on demand.

Both read the same `profiles.json`, and `wasm/harness/parity.mjs` fails if
they drift apart or produce different masks on the same image:

    cd wasm/harness && npm install && npm run check

Default model is isnet-general-use: 92.7% mask IoU against an erase.bg cutout
of the test photo, where u2netp gets 77.5%. Of everything reachable, only
isnet makes that jump; silueta at 44 MB and u2net at 175 MB both score worse
than the 4 MB u2netp on this image. The two builds land within 0.1 IoU of each
other on the same model.

One reference photo is a sample of one, so treat those numbers accordingly.
`wasm/harness/fixtures/` takes more pairs, as `<name>.jpg` plus
`<name>.ref.png`, and everything below is scored across whatever is in there.

    npm run check    both builds agree, and neither regressed
    npm run clicks   how many corrective clicks it takes to reach 95%

Every model used here is Apache-2.0 or MIT. rembg's own default, bria-rmbg,
is non-commercial only and is used by neither.
