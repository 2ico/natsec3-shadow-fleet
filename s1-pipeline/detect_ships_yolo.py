#!/usr/bin/env python3
"""Run YOLOv8n SAR ship detection on a per-scene COG and write detections to
../public/detections/<itemId>.json.

Model: MeWan2808/yolov8n-sar-vessel-detection (YOLOv8n trained on SAR-Ship,
mAP50 ~0.917, single class "vessel"). Input size 640x640.

Pipeline:
  1. Open the EPSG:3857 COG.
  2. Slide a 640x640 window with 64px overlap over the raster.
  3. For each window: replicate the single-channel grayscale into 3 channels,
     run YOLO at conf=0.25, iou=0.45.
  4. Translate window-pixel coords to global pixel coords, then to lat/lon via
     the COG's affine + EPSG:3857→4326 transform.
  5. NMS globally to dedupe overlaps from the window stride.
  6. Write JSON.

Usage:
  ./detect_ships_yolo.py [itemId]    # default: latest scene from manifest
"""

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from huggingface_hub import hf_hub_download
from rasterio.warp import transform as warp_transform
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT.parent / "public"
CACHE = ROOT / ".cache"
MODELS = ROOT / "models"

WINDOW = 640
OVERLAP = 64
CONF = 0.25
IOU = 0.45


def get_model():
    MODELS.mkdir(parents=True, exist_ok=True)
    weights = hf_hub_download(
        repo_id="MeWan2808/yolov8n-sar-vessel-detection",
        filename="unquantized/best.pt",
        cache_dir=str(MODELS),
    )
    print(f"  weights: {weights}", flush=True)
    return YOLO(weights)


def detect_in_cog(cog_path: Path, model: YOLO):
    """Slide WINDOWxWINDOW with OVERLAP, infer, return list of (px_x0, px_y0,
    px_x1, px_y1, conf) in COG pixel coords. Caller converts to lat/lon."""
    with rasterio.open(cog_path) as src:
        H, W = src.height, src.width
        boxes = []
        step = WINDOW - OVERLAP
        ys = list(range(0, max(H - WINDOW, 0) + 1, step))
        xs = list(range(0, max(W - WINDOW, 0) + 1, step))
        if not ys or ys[-1] + WINDOW < H: ys.append(max(0, H - WINDOW))
        if not xs or xs[-1] + WINDOW < W: xs.append(max(0, W - WINDOW))
        print(f"  raster {W}x{H}; sliding {len(xs)}x{len(ys)} = {len(xs)*len(ys)} windows", flush=True)

        # batch windows for speed; YOLO accepts list[ndarray]
        BATCH = 16
        windows = [(x, y) for y in ys for x in xs]
        for i in range(0, len(windows), BATCH):
            batch = windows[i:i + BATCH]
            tiles = []
            for (x, y) in batch:
                w = min(WINDOW, W - x)
                h = min(WINDOW, H - y)
                arr = src.read(1, window=((y, y + h), (x, x + w)))
                # pad to WINDOW x WINDOW if at edge
                if h < WINDOW or w < WINDOW:
                    padded = np.zeros((WINDOW, WINDOW), dtype=arr.dtype)
                    padded[:h, :w] = arr
                    arr = padded
                # 1-channel → 3-channel
                tiles.append(np.stack([arr, arr, arr], axis=-1))
            results = model.predict(source=tiles, conf=CONF, iou=IOU, imgsz=WINDOW, verbose=False)
            for (x, y), r in zip(batch, results):
                if r.boxes is None or r.boxes.xyxy is None:
                    continue
                for b, c in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy()):
                    bx0, by0, bx1, by1 = b
                    boxes.append([
                        x + float(bx0), y + float(by0),
                        x + float(bx1), y + float(by1),
                        float(c),
                    ])
            if (i // BATCH) % 10 == 0:
                print(f"    progress: {i + len(batch)}/{len(windows)}, dets so far {len(boxes)}", flush=True)

        return boxes, src.transform, src.crs


def nms(boxes, iou_thresh=0.5):
    """Simple NMS on (x0,y0,x1,y1,conf) lists."""
    if not boxes: return []
    arr = np.asarray(boxes, dtype=np.float32)
    x0, y0, x1, y1, conf = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]
    areas = (x1 - x0) * (y1 - y0)
    order = conf.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        if order.size == 1: break
        rest = order[1:]
        xx0 = np.maximum(x0[i], x0[rest]); yy0 = np.maximum(y0[i], y0[rest])
        xx1 = np.minimum(x1[i], x1[rest]); yy1 = np.minimum(y1[i], y1[rest])
        w = np.maximum(0, xx1 - xx0); h = np.maximum(0, yy1 - yy0)
        inter = w * h
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou < iou_thresh]
    return arr[keep].tolist()


def boxes_to_geojson(boxes, transform, src_crs):
    """Convert pixel boxes → lat/lon corners + center."""
    out = []
    if not boxes: return out
    arr = np.asarray(boxes)
    px_x = np.concatenate([arr[:, 0], arr[:, 2], (arr[:, 0] + arr[:, 2]) / 2])
    px_y = np.concatenate([arr[:, 1], arr[:, 3], (arr[:, 1] + arr[:, 3]) / 2])
    # pixel → src CRS
    src_x, src_y = rasterio.transform.xy(transform, px_y, px_x, offset="ul")
    # src CRS → EPSG:4326
    lon, lat = warp_transform(src_crs, "EPSG:4326", src_x, src_y)
    n = len(boxes)
    for i, b in enumerate(boxes):
        out.append({
            "lat0": float(lat[i]),       "lon0": float(lon[i]),
            "lat1": float(lat[i + n]),   "lon1": float(lon[i + n]),
            "centerLat": float(lat[i + 2 * n]),
            "centerLon": float(lon[i + 2 * n]),
            "conf": float(b[4]),
        })
    return out


def main():
    manifest_path = PUBLIC / "tiles" / "s1" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if len(sys.argv) > 1:
        scene = next((s for s in manifest["scenes"] if s["id"] == sys.argv[1] or s["date"] == sys.argv[1]), None)
        if scene is None: sys.exit(f"no scene matching {sys.argv[1]}")
    else:
        scene = manifest["scenes"][-1]
    item_id = scene["id"]
    cog_path = CACHE / item_id / "vv_3857.tif"
    if not cog_path.exists():
        sys.exit(f"missing COG {cog_path}")
    print(f"detecting on {item_id}", flush=True)

    model = get_model()
    boxes, transform, src_crs = detect_in_cog(cog_path, model)
    print(f"  raw detections: {len(boxes)}", flush=True)
    boxes = nms(boxes, iou_thresh=0.5)
    print(f"  after global NMS: {len(boxes)}", flush=True)
    geojson = boxes_to_geojson(boxes, transform, src_crs)

    out_dir = PUBLIC / "detections"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{item_id}.json"
    out_path.write_text(json.dumps({
        "sceneId": item_id, "datetime": scene["datetime"],
        "modelId": "MeWan2808/yolov8n-sar-vessel-detection",
        "imgsz": WINDOW, "conf": CONF, "iou": IOU,
        "detections": geojson,
    }, indent=2))
    print(f"wrote {out_path}  ({len(geojson)} detections)", flush=True)


if __name__ == "__main__":
    main()
