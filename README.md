# 留学生出入境计算器（多图识别版）
本应用支持上传多张图片（如出入境记录截图），通过 OCR 识别表格，最终导出 CSV。

适配环境：MacBook M1，16GB 内存。

```bash
python3 -m venv venv
```

```bash
source venv/bin/activate
```

```bash
which python; which pip; pip --version
```

```bash
source venv/bin/activate
hash -r
rehash
which python; which pip; pip --version
```

```bash
# 升级 pip
python -m pip install --upgrade pip

# 安装 paddlepaddle（CPU 版本，M1 推荐；与 paddleocr 3.7 兼容）
python -m pip install paddlepaddle==3.3.1 -i https://pypi.tuna.tsinghua.edu.cn/simple

# 安装 paddleocr 及相关
python -m pip install paddleocr fastapi uvicorn python-multipart

# 如果遇到依赖冲突，可尝试先安装 opencv-python-headless 和 pillow
python -m pip install opencv-python-headless pillow
```

```bash
python app.py
```

浏览器访问：

```bash
http://127.0.0.1:8004/
```

## 使用方式

1. 打开页面后，上传多张图片（支持拖拽和多选）。
2. 系统会识别图片中的表格并整理为统一字段。
3. 点击导出 CSV，得到多图合并后的结果。