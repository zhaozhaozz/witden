# Optional System 1 decision model for the topic dispatcher: the open-source Laya
# (https://github.com/NandhaKishorM/laya, Apache-2.0) served over its Jev-compatible API, POST /v1/systemone.
# CPU only. The weights (about 700 MB for "multilingual") are downloaded on first start into the cache volume.
FROM python:3.12-slim

ARG LAYA_VERSION=0.4.6
# CPU PyTorch first, so that installing laya does not pull the much larger CUDA build.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir "laya[serve]==${LAYA_VERSION}"

RUN useradd --uid 10001 --create-home laya \
 && mkdir -p /home/laya/.cache/huggingface \
 && chown -R laya:laya /home/laya/.cache
USER laya

# LAYA_MODELS: checkpoints loaded at start; "multilingual" reads Chinese and other languages, "english" only English.
ENV HF_HOME=/home/laya/.cache/huggingface \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_MODELS=multilingual
EXPOSE 8000
# The server listens once the checkpoints are loaded, which includes the first download.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["laya-serve"]
