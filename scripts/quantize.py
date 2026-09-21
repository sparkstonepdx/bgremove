"""Quantize a model's weights to 8-bit integers.

    python3 scripts/quantize.py source.onnx out.onnx

Dynamic quantization: weights are stored as uint8 and activations are
quantized on the fly, which is what lets isnet ship at a quarter of its size.
Across the thirteen fixtures it scores within 0.05 points of the full model
on average, with no single fixture dropping more than 0.8.

16-bit is not an option here. At 16 bits every convolution becomes a
ConvInteger with int16 weights, and ConvInteger only accepts 8-bit types, so
the runtime rejects the model outright.
"""
import sys

from onnxruntime.quantization import QuantType, quantize_dynamic

if len(sys.argv) != 3:
    sys.exit(__doc__)

quantize_dynamic(sys.argv[1], sys.argv[2], weight_type=QuantType.QUInt8)
