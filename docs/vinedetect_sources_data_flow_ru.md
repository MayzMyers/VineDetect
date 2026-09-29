# VineDetect Sources: вход, выход и движение данных

Статус: описание текущей реализации  
Проверено по коду: 2026-09-16

Этот документ описывает фактический путь данных одной карточки: сначала
детерминированный Auto Helper, затем stage-scoped LLM review, после него —
валидация и применение correction plan. Основной ключ карточки:

```text
(source, sourceItemId, annotationTrackId)
```

Для Label-scoped стадий к ключу обязательно добавляется `labelId`.

## 1. Общая схема

```text
Catalog source-data + source image + annotation graph + helper config
                              |
                              v
                    Auto Helper / эвристика
                              |
                              v
             AutoOutput + candidates + debug evidence
                              |
                              v
        StageObservation + source/overlay preview + catalogEvidence
                              |
                              v
                      LLM stage decision
               accept | review | rerun | human_required
                              |
                              v
              server-side validation and correction plan
                              |
                              v
                   Wizard Command Executor
                              |
                              v
             canonical graph / reviewed checkpoint
```

Критический инвариант:

```text
AutoOutput != ProposedOutput != ReviewedOutput
```

- `AutoOutput` — машинный результат Auto Helper. Он ещё не является разметкой.
- `ProposedOutput` — проверенное сервером предложение LLM, сохранённое в
  correction plan. Оно ещё не применено к canonical graph.
- `ReviewedOutput` — результат после применения допустимых операций либо после
  подтверждения разметчиком.

LLM не пишет напрямую в БД и не получает произвольный mutation API.

## 2. Исходные данные карточки

### 2.1 Вход

Минимальный адрес карточки:

```json
{
  "source": "roskachestvo",
  "sourceItemId": "3962636",
  "annotationTrackId": "cf098016-4f95-42ef-a263-7d07c9357dfa"
}
```

Recognize собирает `VisionContext` из пяти источников:

1. catalog/source item;
2. canonical annotation graph текущей карточки;
3. Package, связанного с `annotationTrackId`;
4. последних stage executions и helper runs;
5. materialized metadata и выбранной catalog identity.

Основной объект выглядит так:

```json
{
  "card": {
    "source": "roskachestvo",
    "sourceItemId": "3962636",
    "title": "...",
    "manufacturer": "..."
  },
  "catalogEvidence": {
    "authority": "untrusted-catalog-evidence",
    "usagePolicy": "prior_only",
    "identity": {
      "status": "unreviewed",
      "selectedSource": "roskachestvo",
      "selectedSourceItemId": "3962636"
    },
    "fields": {
      "title": "...",
      "manufacturer": "...",
      "category": "...",
      "region": "...",
      "year": 2022,
      "barcode": null,
      "color": "...",
      "description": "..."
    },
    "aliases": [],
    "normalizedTokens": []
  },
  "assets": {
    "source": "source image reference",
    "alternatives": [],
    "coordinateSpace": "source-image-pixels"
  },
  "package": {},
  "labels": [],
  "stageState": {},
  "executionEvidence": [],
  "recentOperations": [],
  "validation": {}
}
```

`catalogEvidence` действительно передаётся в LLM, но только как `prior_only`:
каталожное название, год или производитель помогают интерпретации OCR, однако
не могут подменять видимое содержимое изображения.

Если Catalog Identity была явно изменена, `catalogEvidence` берётся из
выбранной пары `(selectedSource, selectedSourceItemId)`, а адрес рабочей
карточки остаётся прежним.

### 2.2 Публичные read-only запросы

```http
GET /api/v1/catalog?source=all&q=vibes&limit=20&offset=0
GET /api/v1/catalog?source=roskachestvo&q=vibes&limit=20&offset=0
GET /api/v1/catalog?source=svoe_vino&q=vibes&limit=20&offset=0
GET /api/v1/wines/{wineId}
GET /api/v1/wines/by-barcode/{barcode}
```

Нормализованный контекст рабочей карточки:

```http
GET /api/admin/recognition/metadata/{source}/{sourceItemId}
Authorization: Bearer {JWT}
```

Этот endpoint возвращает source item вместе с Recognition metadata/jobs. Это
не raw dump таблиц провайдера.

## 3. Часть I — Auto Helper / автоэвристика

На image-processing стадиях Auto Helper всегда выполняется до LLM review. Его
задача — получить воспроизводимый набор кандидатов, метрик и визуальных
доказательств. LLM не должна вычислять CV-результат с нуля, когда для стадии
существует helper. Исключения — Package count gate, где candidates формирует
stage adapter для самой LLM, и advisory Summary.

### 3.1 Общий вход helper

```json
{
  "source": "roskachestvo",
  "sourceItemId": "3962636",
  "annotationTrackId": "...",
  "stage": "mask",
  "labelId": "label UUID",
  "config": {
    "...": "immutable config snapshot"
  }
}
```

Вход формируется сервером. Для каждой стадии проверяются prerequisites и
принадлежность `labelId` текущему Package/track.

### 3.2 Общий выход helper

```json
{
  "helper": {
    "id": "label-mask",
    "algorithm": "binary-mask-variant-search-v1",
    "version": "1",
    "runId": "...",
    "config": {},
    "intermediateStates": []
  },
  "candidates": [
    {
      "id": "immutable candidate ID",
      "rank": 1,
      "score": 1.39,
      "features": {}
    }
  ],
  "reviewTargets": [],
  "visuals": {
    "sourcePreview": {},
    "candidateOverlay": {}
  }
}
```

Candidate ID связывает изображение, структурированные метрики и последующее
решение. LLM разрешено ссылаться только на ID из текущего observation.

### 3.3 Порядок стадий и их AutoOutput

| Стадия | Вход авточасти | Автоматический алгоритм | Выход для review |
|---|---|---|---|
| `package` | Package scope и source preview | отдельной CV-эвристики нет; это LLM count gate | `single`/`multiple` candidates |
| `label` | source image + Package scope + helper config | `label-multi-family-consensus-v4` | до 4 ROI candidates с quad/bbox, score и metrics |
| `bottle` | source image + ровно один reviewed Label как exclusion | `bottle-border-flood-v2` | до 4 контуров физической упаковки |
| `ocr` / normalization | reviewed Label без rectification | `cv-label-rectification-v1` | original/perspective/guided-cylindrical candidates и отдельные previews |
| `ocr` / recognition | rectified reviewed Label | `label-ocr-cascade` / `tesseract-cascade-v6` | OCR regions, текст, confidence, duplicate/parent evidence |
| `mask` | rectified или исходный Label crop + reviewed OCR | `binary-mask-variant-search-v1` | shortlist масок обеих polarities и downstream component metrics |
| `morphology` | сохранённая/выбранная Mask | `label-morphology-variant-search-v1` | identity/erode/dilate/open/close pipelines и comparison board |
| `components` | Morphology result | `connected-components-v2` | components, bbox, proposalAccepted и stage metrics |
| `elements` | accepted Components | `element-grouping-v1` | semantic Elements и ownership `sourceComponentIds` |
| `contours` | accepted Elements | `component-contours-v2` | контуры, связанные с Element/Component IDs |
| `palette` | Label crop | `label-palette-v1` | сгруппированные RGB colours и ratios |
| `summary` | canonical graph + validation | `canonical-summary-validation` | advisory validation candidate |

Для каждого Label цепочка `ocr -> ... -> palette` выполняется отдельно.

### 3.4 Коррекция изображения

Все CV-стадии одной Label-ветки используют один и тот же immutable crop space:

```text
rectification.type = guided-cylindrical -> corrected / guided-cylindrical
rectification.type = perspective        -> corrected / perspective
rectification отсутствует               -> uncorrected / source-bbox
```

Mask, Morphology, Components, Elements, Contours, Palette и их overlays не
должны смешивать corrected и uncorrected coordinates внутри одного run.

### 3.5 Mask и Morphology shortlist

Mask перебирает варианты:

- foreground polarity: dark/light;
- размеры: 256, 400, 512;
- threshold families;
- downstream probe через connected components.

В shortlist попадает до четырёх вариантов. LLM видит rendered comparison board
и метрики: foreground ratio, component/noise count, largest blob,
fragmentation, edge/text-like coverage.

Morphology строит shortlist семейств:

```text
identity | erode | dilate | open | close | open-dilate | close-erode
```

Визуализация показывает неизменённую input mask и различия кандидата:
сохранённые, добавленные и удалённые пиксели.

## 4. Переход Auto Helper -> LLM

Recognize преобразует helper result в ограниченный `StageObservation`:

```json
{
  "schemaVersion": 1,
  "observationId": "UUID",
  "stage": "ocr",
  "annotationId": "track UUID",
  "packageId": "package UUID",
  "labelId": "label UUID",
  "helper": {
    "id": "label-ocr-cascade",
    "algorithm": "tesseract-cascade-v6",
    "runId": "operation UUID",
    "config": {},
    "intermediateStates": []
  },
  "context": {
    "objective": "...",
    "coordinateSpace": {},
    "catalogEvidence": {}
  },
  "candidates": [],
  "reviewTargets": [],
  "policy": {
    "allowedActions": ["accept", "review", "human_required"],
    "maxLLMIterations": 2,
    "remainingLLMIterations": 2,
    "allowedSemanticAdjustments": [],
    "granularReviewAllowed": true
  },
  "runtimeState": {},
  "editEngine": {},
  "visuals": {
    "sourcePreview": { "dataUrl": "data:image/webp;base64,..." },
    "candidateOverlay": { "dataUrl": "data:image/webp;base64,..." }
  }
}
```

Внешнему controller отправляется:

```json
{
  "schemaVersion": 1,
  "task": "stage-evaluation",
  "stageObservation": {}
}
```

Большие внутренние объекты БД и произвольные пути мутации наружу не передаются.

## 5. Часть II — LLM review

### 5.1 Что получает модель

Мультимодальный запрос содержит в таком порядке:

1. чистый source/stage preview;
2. input mask, если это Morphology;
3. overlay или comparison board Auto Helper;
4. отдельные previews rectification candidates, если это OCR normalization;
5. JSON Schema допустимого ответа;
6. `StageObservation` без встроенных base64-картинок;
7. `catalogEvidence` и, для session-chain, persisted session context.

Модель должна сначала оценить чистое изображение, затем сопоставить его с
эвристикой. Каталожные данные используются как контекст, а не как визуальная
истина.

### 5.2 Выход LLM

```json
{
  "schemaVersion": 1,
  "stage": "mask",
  "action": "accept",
  "candidateId": "mask-dark-400-low-115",
  "confidence": 0.93,
  "flags": ["clear_best_candidate"],
  "paramsPatch": null,
  "reviews": [],
  "topologyEdits": [],
  "editOperations": []
}
```

Допустимые action:

| Action | Смысл | Следующий шаг |
|---|---|---|
| `accept` | принять существующий candidate без исправления | создать correction plan |
| `review` | применить только разрешённые granular/Edit Engine операции | создать correction plan |
| `rerun` | семантически изменить bounded config | сервер переводит adjustment в числовой config и заново запускает helper |
| `human_required` | безопасного автоматического решения нет | остановить текущую зависимую ветку |

LLM не может вернуть произвольный numeric config для rerun. Она выбирает только
разрешённый semantic adjustment, например:

```json
{
  "adjustment": "reduce_noise",
  "strength": "small"
}
```

Сервер сам переводит его в bounded параметры. Максимум повторов задаётся
runtime contract стадии; обычно это 0 или 2. Mask и Morphology используют
immutable visual shortlist и не принимают слепой parameter patch.

### 5.3 Stage-specific изменения

- Label: accept/reject/edit/merge только известных candidate nodes.
- OCR: approve/reject/edit/split/merge/create region, edit text, compose или
  decompose string. Geometry-changing edit вызывает bounded OCR rerun.
- Components: accept/reject известных component IDs.
- Elements: semantic type/role и перенос известных Components между
  существующими или bounded new groups.
- Остальные стадии: выбор candidate либо разрешённый rerun; произвольное
  создание сущностей запрещено.

## 6. Валидация и запись результата

После ответа LLM Recognize последовательно проверяет:

1. совпадает ли `observationId`;
2. совпадает ли stage;
3. разрешён ли action текущим runtime state;
4. принадлежит ли `candidateId` observation;
5. существуют ли все IDs в review/edit operations;
6. не нарушены ли Label/Component/Element ownership и coordinate space;
7. соблюдены ли limits rerun/edit engine.

После этого создаётся correction plan:

```json
{
  "executor": "llm",
  "interactionMode": "auto",
  "controller": {},
  "proposedOutput": {
    "stageDecision": {},
    "observation": {},
    "iterationTrace": [],
    "providerEvidence": {}
  },
  "operations": [],
  "continueOnError": false
}
```

`interactionMode`:

- `auto` — helper output принят без коррекции;
- `mixed` — были `review` или `rerun`;
- `manual` — зарезервирован для результата, созданного независимо от полезного
  helper output.

В LLM pipeline валидный plan автоматически применяется через Wizard Command
Executor. Executor вызывает те же canonical stage services, что и UI, а не
пишет annotation rows напрямую.

После успешного apply сохраняются:

- canonical graph/checkpoint;
- stage execution и review status;
- helper/config/candidate provenance;
- LLM decision и iteration trace;
- correction plan ID;
- provider response/request/conversation IDs;
- token usage и latency, если их вернул provider.

## 7. Session-chain и порядок выполнения

Полный LLM job проходит стадии так:

```text
Package count gate
  -> Label
  -> Object Context
  -> для каждого reviewed Label:
       OCR normalization (если rectification отсутствует)
       -> OCR recognition/review
       -> Mask
       -> Morphology
       -> Components
       -> Elements
       -> Contours
       -> Palette
  -> Summary
```

`LLMSession` принадлежит одному annotation track. Каждый stage вызов создаёт
отдельный `LLMStageRun` с input artifacts, decisions, status и plan reference.
Нужный контекст каждый раз можно восстановить из persisted Wizard state; история
чата провайдера не является единственным источником истины.

## 8. Остановка, ошибки и `human_required`

`human_required` — не HTTP/transport error. Это допустимое решение модели либо
безопасный результат `no-action`, когда текущая стадия не может быть завершена
автоматически.

- `package=multiple` останавливает автоматический pipeline как multipackage;
- `label=human_required` блокирует создание Label-веток;
- `human_required` внутри Label блокирует только зависимую ветку этого Label;
- без блокировок выполняется Summary;
- transport/provider/plan-apply error помечает `LLMStageRun` как `failed` и
  закрывает session/job как failed;
- cancel помечает stage/session/job как cancelled и прерывает provider request
  через `AbortSignal`.

Для диагностики stage run хранит `transportError`, provider evidence, decision
trace, input artifact IDs и текст ошибки.

## 9. Где смотреть данные

- Postman collection: `postman/VineDetect-Sources.postman_collection.json`;
- локальное окружение: `postman/VineDetect-Sources.postman_environment.json`;
- normalized source context:
  `GET /api/admin/recognition/metadata/{source}/{sourceItemId}`;
- canonical graph и stage state доступны через Wizard/annotation endpoints;
- Jobs/Pipeline Run показывают stage decisions, correction plan и transport
  diagnostics.

Не следует сравнивать количество catalog items, annotation tracks и approved
metadata revisions как равные величины: это разные уровни данных. Source item
может существовать без версии разметки; track может быть незавершён; approved
metadata появляется только после прохождения соответствующей review boundary.

## 10. Дамп текущего состояния БД

Для получения фактического состояния PostgreSQL, включая schema и data:

```powershell
.\scripts\dump-current-db.ps1
```

Скрипт выполняет `pg_dump` внутри Compose-сервиса `postgres`, затем копирует
plain SQL в `exports/vinedetect-{db}-full-{timestamp}.sql`. В конце выводятся
абсолютный путь, размер и SHA-256. Пароль в командную строку и dump не
добавляется. Существующий файл скрипт не перезаписывает.

Только структура БД без строк:

```powershell
.\scripts\dump-current-db.ps1 -SchemaOnly
```

Явный путь назначения:

```powershell
.\scripts\dump-current-db.ps1 -OutputPath .\exports\before-llm-test.sql
```

Это снимок живой БД на момент запуска, в отличие от миграций, которые описывают
ожидаемую структуру, но не текущие данные и состояния jobs/runs/versions.
