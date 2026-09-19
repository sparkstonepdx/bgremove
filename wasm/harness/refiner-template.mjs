// Template for a click-driven refiner, so a candidate model can be scored
// against the brush without touching the app.
//
//   node clicks.mjs --refiner ./refiner-template.mjs
//
// FocalClick and RITM both take the image, two click maps and the previous
// mask, and return a corrected mask. That maps onto refine() directly. The
// reason they are worth trying over SAM is that they were trained to correct
// an existing mask rather than propose a new object, which is the failure
// mode you get when you prompt SAM from a mask it did not produce.

export const name = 'template (does nothing)';

let ctx;

// Called once per image. ctx.bitmap is the source, ctx.pred is the base
// model's prediction, ctx.bg is the pipeline module. Load your session here;
// anything expensive that depends only on the image belongs here, not in
// refine().
export async function init(context) {
  ctx = context;
  // const ort = await import('onnxruntime-web');
  // session = await ort.InferenceSession.create(fs.readFileSync('focalclick.onnx'));
}

// Called once per click. `clicks` is the full list so far, each
// { x, y, label } with x and y normalised to the image and label 1 for
// positive and 0 for negative. `mask` is the current mask at width x height,
// one byte per pixel. Return the corrected mask in the same shape.
export async function refine({ mask, clicks, width, height }) {
  // Build the two click-map channels the model expects, at its own input size:
  //
  //   positive = disk of radius ~5 at every click where label === 1
  //   negative = the same for label === 0
  //   previous = `mask`, resized to the model's input
  //
  // then run, threshold, and resize the result back to width x height.
  return mask;
}
