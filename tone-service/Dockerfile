FROM python:3.11-slim

# libsndfile for soundfile; ffmpeg because FunASR uses it for some audio loading
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch first (much smaller than the default CUDA build), then the rest.
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.14.1 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Run as a non-root user. Model downloads go to /models; mount a volume so they survive restarts.
RUN useradd --create-home tone && mkdir -p /models && chown tone:tone /models
ENV HF_HOME=/models MODELSCOPE_CACHE=/models PYTHONUNBUFFERED=1
USER tone
VOLUME /models

EXPOSE 8000
# Healthy only once the model is loaded (the first start downloads it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s \
  CMD python -c "import json, sys, urllib.request; sys.exit(0 if json.load(urllib.request.urlopen('http://localhost:8000/health', timeout=3))['loaded'] else 1)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
