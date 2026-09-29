FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1     PYTHONUNBUFFERED=1     HF_HOME=/models/huggingface     PADDLE_PDX_CACHE_HOME=/models/paddlex

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ARG TORCH_VERSION=2.14.0+cpu
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==${TORCH_VERSION} --index-url ${TORCH_INDEX_URL}
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
ARG TORCHVISION_VERSION=0.29.0+cpu
RUN pip install --no-cache-dir torchvision==${TORCHVISION_VERSION} --index-url ${TORCH_INDEX_URL}
COPY app ./app
COPY concepts ./concepts

EXPOSE 9200
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9200"]
