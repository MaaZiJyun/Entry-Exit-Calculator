import os
import shutil
import re
import threading
import time
import uuid
import logging
import csv
import io
import json
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# 将 PaddleX 缓存目录固定在项目根目录，避免下载到用户主目录
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", os.path.join(PROJECT_ROOT, ".paddlex"))
# 使用本地缓存模型时跳过源站连通性检测，避免每次启动都做网络检查
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from paddleocr import PaddleOCR
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("entry_exit_calculator")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=PROJECT_ROOT), name="static")

_ocr = None
_ocr_lock = threading.Lock()


def _flatten_keys(obj, max_keys=30):
    keys = set()

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                keys.add(str(k))
                walk(v)
        elif isinstance(x, list):
            for item in x[:20]:
                walk(item)

    walk(obj)
    return sorted(keys)[:max_keys]


def get_ocr():
    global _ocr
    if _ocr is None:
        with _ocr_lock:
            if _ocr is None:
                # 懒加载：仅在首次请求时初始化，避免重复启动时反复触发模型准备流程
                logger.info("Initializing PaddleOCR pipeline...")
                _ocr = PaddleOCR(use_doc_orientation_classify=True, use_doc_unwarping=True)
                logger.info("PaddleOCR pipeline initialized.")
    return _ocr

def parse_table_from_html(html: str):
    """从 PaddleOCR 返回的表格 HTML 中提取数据"""
    rows = []
    tr_pattern = re.compile(r'<tr>(.*?)</tr>', re.S)
    td_pattern = re.compile(r'<td>(.*?)</td>', re.S)
    for tr in tr_pattern.findall(html):
        cells = td_pattern.findall(tr)
        if len(cells) >= 7:
            cells = [c.strip() for c in cells]
            rows.append({
                "seq": cells[0],
                "type": cells[1],
                "date": cells[2],
                "docName": cells[3],
                "docNum": cells[4],
                "port": cells[5],
                "flight": cells[6] if len(cells) > 6 else ""
            })
    return rows


def _extract_text_points_from_page(page):
    text_points = []

    if not isinstance(page, dict):
        return text_points

    # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
    # Path 1: Flat OCRResult format (PaddleOCR ≥3.7 / PaddleX pipeline)
    # Keys: rec_texts, rec_polys, rec_boxes — all top-level on the page dict.
    # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
    rec_texts = page.get("rec_texts")
    if isinstance(rec_texts, list) and len(rec_texts):
        # Prefer rec_polys (4-point polygon per text); fall back to rec_boxes
        polys = page.get("rec_polys") or page.get("rec_boxes") or []
        if len(polys) != len(rec_texts):
            polys = []
        for idx, txt in enumerate(rec_texts):
            if not txt:
                continue
            try:
                poly = polys[idx] if idx < len(polys) else None
                if poly is None:
                    continue
                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                cx = sum(xs) / len(xs)
                cy = sum(ys) / len(ys)
                text_points.append((str(txt).strip(), cx, cy))
            except Exception:
                continue
        if text_points:
            return text_points

    # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
    # Path 2: PaddleX-style nested result: page['overall_ocr_res']
    # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
    overall = page.get("overall_ocr_res")
    if isinstance(overall, dict):
        texts = overall.get("rec_texts") or []
        polys = overall.get("rec_polys") or []
        if texts and polys and len(texts) == len(polys):
            for txt, poly in zip(texts, polys):
                if not txt:
                    continue
                try:
                    xs = [p[0] for p in poly]
                    ys = [p[1] for p in poly]
                    cx = sum(xs) / len(xs)
                    cy = sum(ys) / len(ys)
                    text_points.append((str(txt).strip(), cx, cy))
                except Exception:
                    continue

    # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
    # Path 3: Legacy per-item result list: page['res']
    # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
    res = page.get("res", [])
    for item in res:
        if not isinstance(item, dict):
            continue
        txt = item.get("text") or item.get("rec_text") or item.get("transcription")
        poly = item.get("poly") or item.get("dt_poly") or item.get("polygon")
        if txt and poly:
            try:
                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                cx = sum(xs) / len(xs)
                cy = sum(ys) / len(ys)
                text_points.append((str(txt).strip(), cx, cy))
            except Exception:
                pass

    return text_points


def _parse_rows_from_text_points(text_points):
    if not text_points:
        return []

    # Group tokens by Y coordinate to reconstruct each table row
    text_points = sorted(text_points, key=lambda x: (x[2], x[1]))
    rows_grouped = []
    current = []
    y_threshold = 14

    for token in text_points:
        if not current:
            current.append(token)
            continue
        if abs(token[2] - current[-1][2]) <= y_threshold:
            current.append(token)
        else:
            rows_grouped.append(sorted(current, key=lambda x: x[1]))
            current = [token]
    if current:
        rows_grouped.append(sorted(current, key=lambda x: x[1]))

    parsed_rows = []
    date_pattern = re.compile(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}")
    seq_pattern = re.compile(r"^\d{1,3}$")
    type_set = {"入境", "出境"}

    for row_tokens in rows_grouped:
        texts = [t[0].strip() for t in row_tokens if t[0].strip()]
        if not texts:
            continue

        if "序号" in texts or "出入境日期" in "".join(texts):
            continue

        seq = ""
        type_ = ""
        date = ""
        port = ""
        flight = ""

        for t in texts:
            if not seq and seq_pattern.match(t):
                seq = t
            if not type_ and t in type_set:
                type_ = t
            if not date and date_pattern.search(t):
                date = date_pattern.search(t).group(0).replace("/", "-")
            if not port and "口岸" in t:
                port = t

        doc_name_candidates = [t for t in texts if "证" in t or "通行" in t]
        doc_name = doc_name_candidates[0] if doc_name_candidates else ""

        doc_num = ""
        for t in texts:
            if re.match(r"^[A-Za-z0-9*#-]{6,}$", t):
                if t not in {seq, date, port}:
                    doc_num = t
                    break

        for t in texts[::-1]:
            if re.match(r"^[A-Za-z]{2}\d{2,5}$", t) or re.match(r"^[A-Za-z0-9]{4,8}$", t):
                if t not in {doc_num, seq} and "口岸" not in t:
                    flight = t
                    break

        # Require minimum core fields to avoid noisy rows
        if type_ and date:
            parsed_rows.append({
                "seq": seq,
                "type": type_,
                "date": date,
                "docName": doc_name,
                "docNum": doc_num,
                "port": port,
                "flight": flight,
            })

    return parsed_rows


def extract_rows_from_result(result, request_id):
    all_rows = []
    page_metrics = []

    for page_idx, page in enumerate(result, start=1):
        page_rows_before = len(all_rows)

        # 1) Table HTML path (best quality)
        page_res = page.get("res", []) if isinstance(page, dict) else []
        for item in page_res:
            if isinstance(item, dict) and "table" in item:
                html_table = item["table"]
                all_rows.extend(parse_table_from_html(html_table))

        table_rows = len(all_rows) - page_rows_before

        # 2) Fallback text-row parser
        fallback_rows = 0
        if table_rows == 0:
            text_points = _extract_text_points_from_page(page)
            parsed_fallback = _parse_rows_from_text_points(text_points)
            all_rows.extend(parsed_fallback)
            fallback_rows = len(parsed_fallback)

        page_metrics.append({
            "page": page_idx,
            "tableRows": table_rows,
            "fallbackRows": fallback_rows,
        })

    logger.info("[%s] Page extraction metrics: %s", request_id, page_metrics)
    return all_rows


def _coerce_row(row):
    return {
        "seq": str(row.get("seq", "")).strip(),
        "type": str(row.get("type", "")).strip(),
        "date": str(row.get("date", "")).strip(),
        "docName": str(row.get("docName", "")).strip(),
        "docNum": str(row.get("docNum", "")).strip(),
        "port": str(row.get("port", "")).strip(),
        "flight": str(row.get("flight", "")).strip(),
    }




def rows_to_csv(rows):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["序号", "出境/入境", "出入境日期", "证件名称", "证件号码", "出入境口岸", "航班号"])
    for row in rows:
        writer.writerow([
            row.get("seq", ""),
            row.get("type", ""),
            row.get("date", ""),
            row.get("docName", ""),
            row.get("docNum", ""),
            row.get("port", ""),
            row.get("flight", ""),
        ])
    return buffer.getvalue()


@app.on_event("startup")
async def _startup_log_runtime_config():
    logger.info("OCR service started.")


@app.get("/")
async def index():
    return FileResponse(os.path.join(PROJECT_ROOT, "index.html"))

@app.post("/parse_images")
async def parse_images(files: list[UploadFile] = File(...)):
    request_id = str(uuid.uuid4())[:8]
    started_at = time.perf_counter()
    if not files:
        raise HTTPException(status_code=400, detail="No image files provided")

    logger.info("[%s] Received %d image files", request_id, len(files))

    ocr = get_ocr()
    all_rows = []
    image_count = 0

    try:
        for image_idx, image_file in enumerate(files, start=1):
            image_count = image_idx
            filename = image_file.filename or f"image_{image_idx}.jpg"
            ext = os.path.splitext(filename)[1] or ".jpg"
            temp_path = f"/tmp/{request_id}_{image_idx}{ext}"

            with open(temp_path, "wb") as f:
                shutil.copyfileobj(image_file.file, f)
            logger.info("[%s] Saved image %d/%d to %s", request_id, image_idx, len(files), temp_path)

            logger.info("[%s] Starting inference for image %d/%d", request_id, image_idx, len(files))
            result = ocr.predict(temp_path)
            logger.info("[%s] Image %d result keys: %s", request_id, image_idx, _flatten_keys(result, max_keys=40))

            image_rows_before = len(all_rows)
            rows = extract_rows_from_result(result, request_id)
            all_rows.extend(rows)

            image_rows = len(all_rows) - image_rows_before
            logger.info("[%s] Image %d parsed, extracted rows: %d", request_id, image_idx, image_rows)

            if os.path.exists(temp_path):
                os.remove(temp_path)
                logger.info("[%s] Removed temp image: %s", request_id, temp_path)

        raw_rows = [_coerce_row(r) for r in all_rows]
        csv_text = rows_to_csv(raw_rows)

        elapsed = time.perf_counter() - started_at
        logger.info(
            "[%s] Inference completed: images=%d, rows=%d, elapsed=%.2fs",
            request_id,
            image_count,
            len(raw_rows),
            elapsed,
        )
        return {
            "data": raw_rows,
            "csv": csv_text,
            "meta": {
                "requestId": request_id,
                "imageCount": image_count,
                "rowCount": len(raw_rows),
            },
        }
    except Exception:
        elapsed = time.perf_counter() - started_at
        logger.exception("[%s] Inference failed after %.2fs", request_id, elapsed)
        raise HTTPException(status_code=500, detail="Image parsing failed")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8004)