# bgremove

Background removal that runs entirely on your machine. No account, no upload, no API.

```
go build -o bgremove .          # CGO_ENABLED=1 required

./bgremove serve                       # drag-drop UI at http://127.0.0.1:7734
./bgremove photo.jpg                   # -> photo.cutout.png
./bgremove -o cutouts photos/          # batch a directory
./bgremove -bg '#ffffff' photo.jpg     # flatten onto a color
./bgremove -model u2net photo.jpg      # 2x faster, noticeably worse
./bgremove -fit squash photo.jpg       # skip letterboxing
./bgremove -clean 0,1 -no-fill photo.jpg  # raw model output
```

Flags come before paths (Go's flag package stops at the first positional).

## Mask handling

Measured on one real photo against an erase.bg cutout of the same file, scoring
mask IoU:

| setup | IoU | background kept | subject lost |
|---|---|---|---|
| u2netp, squash | 77.5% | 0.18% | 4.47% |
| isnet, squash | 80.4% | 0.12% | 3.92% |
| isnet, letterbox | 92.0% | 1.44% | 0.32% |
| isnet, letterbox, holes filled | 92.7% | 1.44% | 0.17% |

Three things are doing the work.

**Per-model normalisation.** u2net was trained with the ImageNet mean and
standard deviation; isnet was trained with 0.5 and 1.0. Feeding isnet the
ImageNet constants returns a blank mask, not a slightly worse one. These
constants, along with the ramp and the letterbox and fill switches, live in
`profiles.json`, which is a byte-identical copy of `wasm/web/profiles.json`.
Nothing here is hardcoded, and `wasm/harness/parity.mjs` fails if the copies
drift or the two builds produce different masks.

**Letterboxing.** `-fit letterbox` pads the image onto a black square before
scaling, so a 3:4 photo is not stretched into the model's square input. This is
the single biggest win, and it is on by default for isnet. It is off for the
u2net family, which was trained on squashed input and scores far worse with it.

**The alpha ramp and hole filling.** These models emit a low-confidence tail:
pixels at alpha 1 to 25 that show up as a ghost of the whole scene. `-clean
lo,hi` maps alpha below `lo` to transparent and above `hi` to opaque, keeping a
ramp between so fur edges stay soft. Default `0.3,0.7`. Separately, a dark logo
printed on the subject reads as background and comes out see-through, so
transparent regions that do not reach the image border are made opaque;
`-no-fill` turns that off.

`-clean 0,1 -no-fill -fit squash` gives the raw mask, which matches rembg's
output for the same model.

First run downloads the ONNX Runtime shared library (8 MB) and the model into
`~/.cache/bgremove`. Every run after that is offline. The default model is
u2netp, 4.5 MB, about 2 s per image on one CPU core. `-model isnet-general-use`
is 176 MB and 5 s, and is the one to use when quality matters.

## Version coupling

`onnxruntime_go` pins an ONNX Runtime C API version, and a mismatch fails at
startup with `requested API version [N] is not available`. This tree is
`onnxruntime_go v1.19.0` against ONNX Runtime `1.23.0`. If you bump one, bump
the other, or point `-ort` at a library you already have.

## Models

| name | size | license | notes |
|---|---|---|---|
| `u2net` | 176 MB | Apache-2.0 | default, general purpose |
| `isnet-general-use` | 176 MB | Apache-2.0 | sharper edges |
| `u2netp` | 4 MB | Apache-2.0 | tiny and fast, rougher masks |
| `u2net_human_seg` | 176 MB | Apache-2.0 | people only |
| `birefnet-general` | 1 GB | MIT | best quality, needs ~4 GB RAM |

rembg's own default is `bria-rmbg`, which is licensed for non-commercial use
only. It is deliberately not in the table above.

## Input formats

JPEG, PNG and GIF, from the standard library. WebP decoding needs
`golang.org/x/image/webp` added to the imports.
