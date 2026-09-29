FROM python:3.12.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu130 -r /tmp/requirements.lock
WORKDIR /release
CMD ["python", "-u", "/engineering/engineering_service.py"]
