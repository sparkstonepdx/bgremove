#!/bin/sh
# Fetches the ONNX Runtime WASM build and the embedded model. These are kept
# out of git so patches stay readable; run this once after cloning.
set -e
cd "$(dirname "$0")"

ORT=1.23.0
MODEL=u2netp

if [ ! -f ort-wasm-simd-threaded.wasm ]; then
  echo "fetching onnxruntime-web $ORT"
  npm pack "onnxruntime-web@$ORT" >/dev/null
  tar xzf "onnxruntime-web-$ORT.tgz"
  for f in ort.wasm.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
    cp "package/dist/$f" .
  done
  rm -rf package "onnxruntime-web-$ORT.tgz"
fi

if [ ! -f "$MODEL.onnx" ]; then
  echo "fetching $MODEL"
  curl -fL -o "$MODEL.onnx" \
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/$MODEL.onnx"
fi

echo "ready:"
ls -la ort-wasm-simd-threaded.wasm ort.wasm.min.mjs "$MODEL.onnx"
