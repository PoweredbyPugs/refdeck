from __future__ import annotations

import threading
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from .thumbs import cache_key

MODEL_URL = "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx"
MODEL_NAME = "depth_anything_v2_vits.onnx"
INPUT_SIZE = 518

_lock = threading.Lock()
_session = None


def depth_output_path(source: Path, depth_dir: Path) -> Path:
    return depth_dir / f"{source.stem}-{cache_key(source)[:8]}-depth.png"


def _get_session(model_dir: Path):
    global _session
    with _lock:
        if _session is None:
            import onnxruntime
            model_dir.mkdir(parents=True, exist_ok=True)
            model = model_dir / MODEL_NAME
            if not model.exists():
                partial = model.with_suffix(".part")
                urllib.request.urlretrieve(MODEL_URL, partial)
                partial.rename(model)
            _session = onnxruntime.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        return _session


def generate_depth_map(source: Path, depth_dir: Path, model_dir: Path) -> Path:
    out = depth_output_path(source, depth_dir)
    if out.exists():
        return out
    session = _get_session(model_dir)
    with Image.open(source) as img:
        rgb = img.convert("RGB")
        width, height = rgb.size
        arr = np.asarray(rgb.resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR), dtype=np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    tensor = ((arr - mean) / std).transpose(2, 0, 1)[None]
    input_name = session.get_inputs()[0].name
    depth = session.run(None, {input_name: tensor})[0].squeeze()
    lo, hi = float(depth.min()), float(depth.max())
    norm = (depth - lo) / (hi - lo) if hi > lo else depth * 0
    gray = Image.fromarray((norm * 255).astype(np.uint8), "L").resize((width, height), Image.BILINEAR)
    depth_dir.mkdir(parents=True, exist_ok=True)
    gray.save(out, "PNG")
    return out
