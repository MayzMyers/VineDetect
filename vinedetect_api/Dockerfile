FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY pyproject.toml README.md ./
COPY app ./app
RUN mkdir -p /app/data/contest_reference_overrides /app/data/contest_identity_corrections /app/data/contest_metadata_overrides
COPY migrations ./migrations

RUN python -m pip install --no-cache-dir --no-build-isolation .

USER app

EXPOSE 8000

CMD ["uvicorn", "app.api.application:app", "--host", "0.0.0.0", "--port", "8000"]
