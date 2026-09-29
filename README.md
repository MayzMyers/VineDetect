# VineDetect

Распознавание вина по фотографии этикетки, каталог и инструменты ручной разметки.

Рабочий путь: **Next.js `/scan` → `/api/recognition/jobs` → VineDetect Core C4 → официальный slug → FastAPI → карточка вина**. В Core используется зафиксированный пайплайн SEM-ORG-FINAL-v3-RC2-R90-GATED с C4-исполнением, OCR, визуальным поиском и геометрической проверкой. Исходное фото передаётся Core без перекодирования в BFF.

## Что находится в репозитории

- `vinedetect_web/` — сканер, каталог, админка и редактор разметки (Next.js).
- `vinedetect_api/` — каталог, API, импортеры и миграции (FastAPI/PostgreSQL).
- `core/` — точные исходники и контрольные суммы рабочего Core C4; зафиксированное Python-окружение.
- `recognize-service/` — очередь задач, метаданные, ручная разметка, экспорт датасетов.
- `vision-service/`, `annotation_controller/`, `ml/` — помощники разметки и ML-инструменты.
- `scripts/` — настройка, проверка, восстановление отдельно передаваемых данных.

Данные поставляются **отдельно**: база PostgreSQL, каталог изображений, эталоны, дескрипторы, веса моделей, OCR-словари и тестовые наборы. Публичный репозиторий не содержит рабочих секретов, истории исходного приватного Git, дампов и результатов экспериментов. Примеры в `public/mock/` синтетические; `/scan` использует настоящий Core.

## Требования

Linux или WSL2, Python 3.11+, Docker Engine с Compose v2 и поддержкой `gpus: all`, NVIDIA GPU и совместимый драйвер CUDA 13. Текущий Core использует CUDA и не имеет проверенного CPU-only режима. Для Core выделяются 4 CPU и 6 GiB RAM; всему стеку и сборке требуется дополнительная память. Модели и дескрипторы занимают значительное место на диске.

## Архитектура ядра сервиса распознавания
[docs/recognize-core-architecture.md](docs/recognize-core-architecture.md)

## Запуск

```bash
git clone https://github.com/MayzMyers/VineDetect.git
cd VineDetect
```

1. Получите отдельно комплект артефактов у владельца проекта. Его структура и формат описаны в [docs/deployment.md](docs/deployment.md). Подставьте пути в JSON по [примеру](docs/artifacts.example.json).

```bash
python3 scripts/provision.py /path/to/artifacts.json
# На той же машине можно добавить --link, чтобы не копировать большие каталоги.
python3 scripts/setup.py
python3 scripts/import_database.py artifacts/database.dump
docker compose up -d --build --wait
python3 scripts/check_stack.py
```

`setup.py` спрашивает новый пароль администратора и генерирует локальные секреты. `import_database.py` работает только с пустой базой и отказывается перезаписывать существующие таблицы. Запуск может занять несколько минут: Core проверяет все файлы и загружает модели.

Откройте **http://localhost:3000/scan**. Админка: **http://localhost:3000/admin**. API: http://localhost:8000/docs. При конфликте портов измените `.env` до запуска. Сервисы по умолчанию доступны только на localhost; для камеры с другого устройства нужен HTTPS.

```bash
python3 scripts/check_stack.py --image /path/to/bottle.jpg
docker compose logs -f core web api
docker compose down  # данные остаются в Docker volume
```

### Разметка и фоновые задачи

Для этих функций дополнительно нужен комплект галереи разметки и OCR-языков (устанавливается `provision.py`). В `.env` укажите:

```dotenv
V5_GALLERY_DIR=./artifacts/annotation-gallery
V5_DINOV3_MODEL_DIR=./artifacts/core-runtime/models/dinov3
V5_HF_CACHE=./artifacts/core-runtime/models/huggingface
V5_PADDLE_CACHE=./artifacts/core-runtime/models/paddlex
```

```bash
docker compose --profile annotation up -d --build
```

Для LLM-помощника дополнительно задайте собственный ключ провайдера в `.env` и включите `--profile llm`. Ключи для обычного распознавания не нужны. Разметка хранится в PostgreSQL; файлы обучения появляются при явном экспорте. Подробнее: [контракт хранения и экспорта](docs/annotation_data_output_ru.md), [рабочий процесс разметки](docs/label_annotation_workflow_ru.md).

## Проверка кода

```bash
cd vinedetect_web
npm ci
npm run test:recognition
npm run test:references
npm run test:scanner
npm run test:workflow
npm run build
cd ../recognize-service
npm ci
npm run typecheck
npm run build
cd ..
python3 -m pip install -e './vinedetect_api[dev]'
python3 -m pytest vinedetect_api/tests
```

Тесты с реальными HTML/JSON/изображениями требуют отдельно поставляемого `supplemental/`. Это относится и к историческим исследовательским тестам vision/ML; состав публичного релиза и выполненные проверки описаны в [docs/public-release.md](docs/public-release.md).

## Ограничения текущей сборки

Core C4 сохраняет зафиксированное поведение RC2-R90-GATED. Историческая проверка HARD10 (жёсткий лимит 10 секунд) **не пройдена**; время отдельных запросов может превышать 10 секунд. HTTP-адаптер Core последовательно обрабатывает запросы. Это локальный запуск; публикация приложения в интернет требует отдельной настройки HTTPS, доступа и лимитов нагрузки.

Веса сторонних моделей и данные имеют собственные условия использования. Они не публикуются и не перелицензируются этим репозиторием. Для точного повторения окружения используйте отдельно поставляемый frozen Docker archive; `core/Dockerfile` — альтернативная пересборка из зафиксированных зависимостей, её побайтовая эквивалентность frozen image не заявляется.
