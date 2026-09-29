# Manual / Semi-Automatic Annotation Pipeline

Status: partially implemented current workflow; planned iterative training loop
Scope: unified annotation, preset, dataset, training and client-inference workflow

## Текущий исполняемый вертикальный срез

**Implemented:** ручной reviewed `label-roi` может быть передан в item-only `ANALYZE_LABEL`. Job привязан к точным annotation id/revision, создаёт persisted crop, запускает существующий OpenCV pipeline внутри ручного ROI и сохраняет generated metadata вместе с config snapshot/hash и provenance. Label Annotation показывает те же OpenCV debug stages (маски, компоненты, кандидаты и контуры), которые доступны в CV tooling, и позволяет изменить item-level config и перегенерировать результат.

Контуры предназначены для визуальной диагностики. Ручного редактирования вершин/геометрии контуров нет и не планируется в текущем контракте: оператор исправляет параметры OpenCV и повторяет run. Reviewed bbox остаётся ground truth, а `labelAnalysis` — generated auxiliary metadata.

**Implemented:** результат можно сохранить отдельной immutable review revision со статусом `accepted`, `needs-tuning` или `rejected`; review строго привязан к annotation revision, completed job и config hash. Annotation queue показывает агрегированные analysis readiness counters.

**Implemented:** связка работает на одном item и checked-item batch. Перед созданием parent job сервер проверяет наличие reviewed ROI у всей выборки; каждый child получает собственные annotation id/revision. Доступны фильтры missing/needs review/accepted/needs tuning/rejected.

**Planned:** batch-run по reviewed ROI, общий durable job для OpenCV/OCR/source matching/aliases, layer-specific presets для OCR/matching/aliases и очереди проверки результатов.
Last verified against code: 2026-08-08

## Главный Контракт

```text
Label ROI задает человек.
OCR помогает извлечь текст внутри reviewed/draft crop.
Локальный source matching показывает подсказки относительно текущего item.
Reviewer отдельно сохраняет label ROI и reviewed OCR text.
Dataset export использует reviewed annotations.
```

## Целевой Единый Pipeline

Цель — один воспроизводимый контур, в котором первые `n` items размечаются вручную, затем используются для обучения модели, модель создаёт предложения для оставшихся items, а исправленные человеком результаты входят в следующую версию датасета.

```text
source item
  -> layer presets/config snapshots
  -> generated proposals
  -> human review/correction
  -> reviewed multilayer annotation
  -> versioned dataset
  -> model training/evaluation
  -> model candidate
  -> batch proposals for remaining items
  -> review/correction
  -> next dataset/model version
  -> published client vision bundle
```

Pipeline единый на уровне orchestration, provenance, очередей и dataset lineage. Данные разных стадий не объединяются в один изменяемый JSON-объект.

Целевые слои:

1. `label-roi` — область основной этикетки.
2. `ocr-region` — word/line/string regions внутри этикетки.
3. `ocr-text` — распознанный и проверенный текст регионов и этикетки целиком.
4. `source-association` — связь текста/региона с item и конкретным source field.
5. `string-alias` — нормализованные варианты source-data для matching и client index.

Для каждого слоя отдельно существуют:

- generated proposal/result;
- reviewed annotation;
- preset/config snapshot;
- engine/model version;
- quality metrics и review status.

Главный инвариант сохраняется для всех слоёв:

```text
preset/model output != reviewed ground truth
```

## Режимы Работы

### Manual seed

Reviewer размечает выбранную стартовую выборку из `n` items без обязательного использования модели:

- рисует `label-roi`;
- рисует, объединяет или разделяет `ocr-region`;
- вводит/исправляет текст;
- подтверждает source associations;
- проверяет предложенные aliases.

Размер `n` не является глобальной константой. Выборка должна фиксироваться как versioned annotation cohort с фильтром источника, списком item keys и назначением: `train`, `validation`, `test` или `calibration`.

### Assisted review

Выбранный preset или model version создаёт предложения. Reviewer принимает, исправляет или отклоняет их. Сохраняются как исходное предложение, так и итоговая reviewed annotation, чтобы измерять качество автоматизации и объём ручной коррекции.

### Batch propagation

Проверенная конфигурация или model candidate запускается по выборке оставшихся items через durable jobs. Batch run создаёт только generated proposals/results и никогда не перезаписывает reviewed annotations.

### Training iteration

После review создаётся новая неизменяемая версия датасета. Обучение и оценка ссылаются на dataset version, preset snapshots, code/model version и метрики. Модель публикуется для следующего batch run только после проверки на зафиксированном validation/test split.

## Preset Contract

Серверный registry версионированных presets частично реализован. Рабочий вертикальный срез покрывает `label-roi`: migration/table, list/create/history/create-revision API, BFF и CV Lab. Browser `localStorage` больше не является источником истины для CV presets.

Job с `presetId + presetRevision` загружает точную конфигурацию на стороне Recognize Service. Клиентский config snapshot игнорируется в пользу registry revision; сервер сохраняет собственные snapshot/hash и provenance предложения. Deprecated или несовместимый с job type preset отклоняется.

Для `ocr-region`, `source-matching` и `alias-generation` реализованы item-level reviewed revisions и ручной UI, но runtime preset schemas автоматических batch-генераторов пока отсутствуют. Для `ocr-recognition` и composite `pipeline` определены только layer names и общий storage contract; их runtime config schemas/UI не реализованы.

Preset относится к конкретному слою:

```text
label-roi preset
ocr-region preset
ocr-recognition preset
source-matching preset
alias-generation preset
```

Дополнительно pipeline preset может быть bundle, который только ссылается на конкретные revisions layer presets. Изменение layer preset создаёт новую revision и не меняет уже выполненные runs.

Минимальный preset contract:

```text
id
name
layer
revision
status: draft | validated | deprecated
engine/model kind and version
config
created_by / created_at
based_on_preset_revision (optional)
validation_dataset_version (optional)
validation_metrics (optional)
```

Применение preset имеет явный scope:

- `preview` — только интерактивный результат, без persistence;
- `item` — один item;
- `selection` — зафиксированный список item keys;
- `source` — текущий provider/source с сохранённым filter snapshot;
- `global` — все подходящие items обоих источников с сохранённым filter snapshot.

Для `item` разрешён прямой интерактивный запуск с последующим явным сохранением proposal. `selection`, `source` и `global` выполняются только через durable batch job. Каждый run хранит immutable preset snapshot, даже если registry preset позднее изменился или был deprecated.

Для `label-roi` эти scopes реализованы. Recognition inventory поддерживает estimate-then-run для выбранных items, текущего source и обоих sources. Parent job сохраняет resolved item keys и `resolvedAt`, поэтому выборка не меняется после старта. Batch записывает только `meta.detection_proposals`; canonical reviewed rows в `meta.image_annotations` не перезаписываются.

Ручная настройка слоя в annotator/CV Lab должна поддерживать:

- начать с существующего preset;
- изменить параметры как draft overrides;
- preview на текущем item;
- сохранить как новую preset revision;
- применить к текущему item;
- запустить на выбранной выборке;
- после validation пометить revision как доступную для source/global run.

Глобальный preset означает глобальную конфигурацию генерации предложений, а не глобальное изменение ground truth. Reviewed annotations защищены от такой операции.

## Целевой UI

Один annotation workspace должен использовать общие canvas, item queue и provenance, переключая панели слоёв:

```text
1 Label ROI
2 OCR Regions
3 OCR Text
4 Source Match
5 Review
```

Для каждого слоя UI показывает:

- активный preset/model и revision;
- generated overlay/result;
- reviewed overlay/result;
- confidence и причину предложения;
- `Accept`, `Edit`, `Reject`, `No object` где применимо;
- dirty/save state;
- переход к следующему item без потери несохранённых изменений.

Отдельный batch workspace должен отвечать за:

- создание annotation cohort;
- выбор layer/pipeline preset;
- preview на малой sample-выборке;
- запуск `selection/source/global` job;
- прогресс, ошибки, retry/cancel;
- очереди `needs review`, `low confidence`, `model disagreement`, `ready for dataset`.

CV Lab остаётся developer/tuning режимом, но сохраняет presets в тот же registry. Annotator применяет validated presets и может создавать draft overrides, не дублируя формат ROI-аннотаций.

## Целевой Server Contract

Логические сущности целевого контура поверх `meta.*`; реализованные части отмечены явно:

- `pipeline_presets` и immutable preset revisions;
- `pipeline_runs`/job linkage с config snapshots;
- revisioned reviewed OCR-region annotations (**implemented** as `meta.ocr_region_annotation_sets` + `meta.ocr_region_annotations`);
- OCR/source association proposals и reviewed associations (**reviewed storage implemented** as `meta.ocr_source_association_sets` + `meta.ocr_source_associations`; proposals are ephemeral);
- structured alias candidates/reviews (**implemented** as `meta.alias_annotation_sets` + `meta.alias_annotations`);
- reviewed cross-item catalog identity (**implemented** as immutable `meta.catalog_identity_reviews` revisions with `confirmed` / `corrected` / `no-match` / `ambiguous` outcomes);
- annotation cohorts и dataset versions (**implemented** as `meta.annotation_cohorts`, `meta.annotation_cohort_items`, `meta.dataset_versions`, `meta.dataset_version_items`);
- training runs, model versions и evaluation metrics (**implemented as external-run registry/control plane** via `meta.training_runs`, `meta.model_versions`, `meta.evaluation_results`);
- registered frozen dataset artifacts (**implemented** as `meta.dataset_artifacts`);
- published client bundles.

Имена уже реализованных таблиц выше закреплены migrations `009`-`021`. Migration `015` добавляет immutable label-analysis reviews, `018` — reviewed catalog identity, `019` — dataset snapshot schema v2, `020` — OCR region orientation, `021` — visual training task names. Новые frozen snapshots используют schema v5: schema v3 разделила reviewed visual annotations и CV metadata, v4 добавила канонические stage samples, а v5 замораживает полный annotation graph со всеми Package/Label/parent-scoped OCR. Отдельная migration структуры snapshot для этого не нужна, потому что snapshot хранится в JSONB, а `schema_version` уже является целым числом. Cohorts, immutable dataset snapshots, registered exports и training/model registry реализованы. Training workers, model inference и published bundles остаются planned.

Все автоматические стадии должны выполняться через единый job journal со stage-specific job types. Интерактивный preview может оставаться синхронным, но сохранённый результат обязан получить run identity и provenance.

Минимальная provenance-цепочка для любого предложения:

```text
source + sourceItemId + asset identity/hash
layer
preset id/revision + immutable config snapshot
engine/model id/version
run/job id
generated result
parent proposal/run where applicable
created_at
```

## Dataset И Обучение

Dataset version включает только reviewed ground truth и ссылки на исходные assets. Generated results прикладываются отдельно как auxiliary/provenance data и не становятся truth автоматически.

Для защиты оценки:

- splits фиксируются при создании dataset version;
- один и тот же item/asset не должен попадать одновременно в train и validation/test;
- test split не используется для подбора preset thresholds;
- экспорт хранит schema version, source hashes и annotation revisions;
- повторный экспорт с тем же manifest должен быть воспроизводимым.

Первый обучаемый контур логично разделить на две задачи:

1. label detector по reviewed `label-roi`;
2. text-region detector/segmenter по reviewed `ocr-region`.

OCR recognition, source matching и alias ranking могут сначала использовать deterministic/Tesseract/fuzzy pipelines с reviewed результатами для оценки. Их дообучение вводится отдельно, когда накопится достаточный датасет. Это не блокирует обучение ROI-моделей.

## Client Vision Bundle

Финальная поставка на клиент должна быть model-neutral bundle, а не прямой зависимостью UI от training framework:

```text
bundle manifest
label detector artifact
text-region artifact (when available)
OCR runtime/profile
normalization and alias index version
matching thresholds
supported schema/runtime versions
checksums and published_at
```

Клиентский flow:

```text
camera frame
  -> quality gate
  -> label ROI
  -> text regions
  -> OCR tokens
  -> normalized aliases/source matching
  -> ranked catalog candidates
  -> confidence decision or server fallback
```

Конкретный runtime (`ONNX`, TensorFlow.js, WASM или иной) пока не выбран и не считается реализованным решением. Контракт bundle должен позволять заменить runtime без изменения annotation/dataset модели.

## Порядок Реализации Целевого Контура

### Phase 1 — canonical annotation layers and presets

- закрепить `meta.image_annotations` как единственный ground truth для `label-roi`;
- **Implemented:** reviewed `ocr-region` revisions, ручной editor и экспорт ground truth;
- **Implemented:** item-level deterministic source candidates, ручной accept/reject/correction, immutable reviewed association revisions и dataset export;
- **Implemented:** source/association-based alias candidates, ручной accept/reject/edit/add, immutable reviewed alias revisions и dataset export;
- **Implemented:** single-item cross-source catalog shortlist review с immutable identity revision и экспортом в optional `catalogIdentity` layer; schema v2 ввела этот слой, schema v3 добавила visual annotations/CV metadata, schema v4 добавила `StageSampleV1`, schema v5 — canonical annotation graph;
- **Planned:** batch/preset-driven matching и entity resolution;
- **Implemented for `label-roi`:** server-side layer preset registry с immutable revisions;
- **Implemented for `label-roi`:** CV Lab использует общий registry вместо `localStorage`;
- **Implemented for preset-backed jobs:** сервер сохраняет immutable config snapshot/hash и proposal provenance;
- **Planned:** runtime preset schemas/UI для остальных слоёв и composite pipeline.

Критерий готовности: один item можно полностью разметить по всем слоям, повторно открыть без потери provenance и экспортировать только reviewed данные.

### Phase 2 — manual seed cohort

- **Implemented:** создать фиксированную выборку `n-items` из checked rows annotation queue;
- **Implemented:** заморозить immutable DB snapshot reviewed layers с SHA-256 каждого item;
- **Implemented:** включать latest reviewed catalog identity в snapshot v2 без изменения старых frozen v1 versions;
- **Implemented:** детерминированно сохранить train/validation/test split 70/20/10 в dataset version;
- добавить очереди и hotkeys для быстрой multilayer-разметки;
- **Implemented for registered artifacts:** перед созданием external training run сервер заново читает immutable `manifest.json`/`annotations.jsonl`, проверяет зарегистрированный SHA-256 и показывает task-specific readiness по split для `label-roi`, `ocr-region`, `source-matching`, `alias-ranking`, `bottle-outline`, `label-elements` и `label-palette`; visual tasks читают только reviewed `vision.annotations`, а `vision.cvMeta` остаётся proposal/evidence;
- **Implemented for catalog identity:** readiness counters и server-side queues для missing/confirmed/corrected/no-match/ambiguous;
- **Implemented:** экспортировать выбранную frozen DB dataset version в атомарно создаваемый файловый artifact (`manifest.json`, `annotations.jsonl`, `splits.json`) с checksum и без чтения live annotations.
- **Implemented:** при том же атомарном экспорте materialize task-specific `tasks/<task>.jsonl` для всех registry tasks. Adapter v1 добавляет только необходимые `input`/reviewed `target`, фиксированный split, snapshot hash и явную coordinate space; CV proposals из `vision.cvMeta` в visual targets не копируются. Manifest хранит count/SHA-256/version каждого adapter-файла, а readiness сверяет файл одновременно с filesystem manifest и immutable manifest из БД.

Критерий готовности: стартовый датасет воспроизводимо экспортируется из конкретных annotation revisions.

### Phase 3 — batch proposals and assisted review

- **Implemented for `label-roi`:** durable proposal jobs для item/selection/source/global;
- **Implemented for `label-roi`:** frozen item keys в parent target и server-owned preset snapshot в child options;
- **Implemented:** estimate количества перед source/global run;
- **Planned:** визуальный non-persisting sample preview перед большим batch run;
- **Planned:** stage-specific durable jobs для OCR/matching;
- измерять acceptance/correction/rejection и model disagreement.

Критерий готовности: preset/model обрабатывает оставшиеся items, не меняя reviewed ground truth, а результаты появляются в review queues.

### Phase 4 — training and model registry

- **Implemented:** регистрировать training run против зарегистрированного artifact конкретной immutable dataset version;
- **Implemented:** не создавать run, если artifact отсутствует на диске, повреждён, имеет неподдерживаемую schema version, не совпадает по SHA-256 или не содержит ни одного reviewed sample для выбранной задачи;
- **Implemented:** сохранять lifecycle запуска, config/code provenance, split evaluation metrics и model artifacts с checksum;
- **Implemented in registry:** разрешать validation/promotion только при наличии model-linked validation result; при promotion предыдущая promoted-модель той же задачи становится deprecated;
- **Planned:** training worker, автоматический расчёт metrics, model-backed batch deployment и повтор цикла после review новых предложений.

Текущий registry прослеживает model artifact до training run и frozen dataset artifact. Полный критерий ещё не достигнут: generated proposals пока не ссылаются на model version, потому что model-backed execution отсутствует.

### Phase 5 — client vision

- заменить mock catalog index на versioned live alias/source index;
- публиковать client bundle manifest и artifacts;
- подключить on-device pipeline к тем же normalization/matching contracts;
- сохранять или агрегировать client outcomes для оценки drift и следующей annotation cohort.

Критерий готовности: клиент возвращает ранжированные catalog candidates с версиями bundle/model/index и имеет явный low-confidence fallback.

## Миграции И Дампы

Разработка на двух машинах использует `.basedata` как data handoff, но dump не заменяет schema contract.

Для каждой новой pipeline-сущности порядок такой:

1. добавить и закоммитить idempotent migration;
2. применить migration на рабочей БД;
3. выполнить ручную разметку, генерацию metadata или training registry writes;
4. создать новый dump `.basedata` после изменения общих данных;
5. передать dump вместе с commit, содержащим миграцию и совместимый код.

Preset revisions, cohorts, reviewed annotations, dataset manifests и model registry rows являются общими данными. Если они должны быть доступны на второй машине, после их создания требуется новый dump. Большие model artifacts лучше хранить как внешние файлы с checksum/path в БД, а не внутри dump; конкретное общее artifact storage пока не определено.

## UI Workflow

Основной workspace:

```text
/admin/recognition/[source]/[sourceItemId]?section=annotation
```

Внутри `Label Annotation` используется stepper:

```text
1 Label -> 2 Text -> 3 Review
```

Canvas остается общим рабочим контекстом. Меняется правая панель и действия.

## Step 1: Label

Задача:

```text
Вручную выделить основной label bbox.
```

UI:

- source image canvas;
- editable bbox;
- floating zoom lens;
- right click reset;
- crop preview;
- `Edit bbox`;
- `Mark no label`;
- `Invalid image`;
- `Save annotation`;
- `Continue to text`.

Сохраняемая ground truth сущность:

```text
meta.image_annotations
annotation_type = label-bbox
status = reviewed
```

## Step 2: Text

Задача:

```text
Запустить OCR по label crop и проверить текстовые результаты.
```

Текущий вертикальный срез:

- `Run browser OCR`;
- crop создается в браузере из текущего bbox;
- используется существующий Tesseract helper;
- OCR result не создает job;
- OCR result не сохраняется в backend как persisted metadata;
- raw/normalized text можно править в UI;
- legacy text-level source matches считаются локально как preview; основной region-level workspace получает server candidates по source item fields, aliases и normalized tokens и сохраняет только human review;
- `Run backend OCR`;
- backend сохраняет `label_crops`, `ocr_runs` и word-level `ocr_regions`;
- текущий backend OCR engine - `tesseract.js`;
- backend OCR пишет `raw_text`, `normalized_text`, `confidence`, `engine`, `config_hash`, `runtime_ms`;
- `Save OCR review` создает новую revision в `meta.ocr_text_annotations`;
- `Save OCR review and next` сохраняет text review и переходит к следующему item очереди.

Текущий backend слой:

- `backend-standard`;
- generated OCR word regions;
- reviewed OCR text revisions;
- reviewed OCR-region revisions with normalized crop coordinates and generated-region provenance;
- crop/run provenance.

Планируется, но не реализовано:

- `backend-enhanced`;
- OCR batch/job flow.

## Step 3: Review

Задача:

```text
Проверить итоговую annotation-запись перед сохранением и переходом дальше.
```

UI показывает:

- label ROI status;
- OCR token count/confidence;
- suggested source matches;
- `Back to label`;
- `Back to text`;
- `Mark reviewed`;
- `Save and next`.

`Mark reviewed` и `Save and next` сохраняют label bbox. Они не сохраняют OCR text, OCR regions или source associations автоматически: для каждого слоя на Text step есть отдельное явное сохранение. Generated source candidates остаются ephemeral, reviewed associations сохраняются revisioned.

## Что Сейчас Не Persisted

Не сохраняются:

- browser OCR run;
- generated source match suggestions (они пересчитываются, а не сохраняются);
- выбранная связь OCR token с catalog field;
- backend-enhanced результат.

Backend сохраняет OCR snapshot в `meta.ocr_runs`, generated word boxes в `meta.ocr_regions`, а reviewed/corrected text — revisioned rows в `meta.ocr_text_annotations`. Текущий `backend-standard` использует `tesseract.js` по crop, построенному из label bbox.

## Backend Contract

Реализованы таблицы:

```text
meta.label_crops
meta.ocr_runs
meta.ocr_regions
meta.ocr_text_annotations
meta.ocr_region_annotation_sets
meta.ocr_region_annotations
meta.ocr_source_association_sets
meta.ocr_source_associations
meta.alias_annotation_sets
meta.alias_annotations
```

Реализованные item-level endpoints Recognize Service:

```text
GET  /management/metadata/:source/:sourceItemId/label-annotation/ocr
POST /management/metadata/:source/:sourceItemId/label-annotation/ocr/run
GET  /management/metadata/:source/:sourceItemId/label-annotation/ocr/review
PUT  /management/metadata/:source/:sourceItemId/label-annotation/ocr/review
GET  /management/metadata/:source/:sourceItemId/label-annotation/ocr/regions/review
PUT  /management/metadata/:source/:sourceItemId/label-annotation/ocr/regions/review
GET  /management/metadata/:source/:sourceItemId/label-annotation/ocr/source-associations
PUT  /management/metadata/:source/:sourceItemId/label-annotation/ocr/source-associations
GET  /management/metadata/:source/:sourceItemId/label-annotation/aliases
PUT  /management/metadata/:source/:sourceItemId/label-annotation/aliases
```

Source association entities/endpoints реализованы для item-level review. Batch/job OCR и batch/preset-driven source matching остаются planned.

## Короткое Правило

```text
Label step = human bbox.
Text step = OCR/matching assistance.
Review step = final human decision.
CV Lab = detector developer tools.
Jobs = persisted background operations.
```

## Headless Wizard API parity audit (2026-08-31)

Update 2026-09-03: Package crop остаётся ручным техническим scope, но LLM orchestration теперь начинается с `llm-package-count-gate-v1`. `single` сохраняется как item-level Meta и разрешает переход к Label; `multiple` сохраняет `package-multiplicity + multipackage` и завершает автоматический прогон со статусом `blocked_multipackage`. Ручное создание второго canonical Package выводит ту же отметку из фактического graph state без provider-вызова. Более раннее утверждение ниже о полностью human-owned Package LLM policy superseded этим gate.

Цель аудита — проверить, может ли программный клиент пройти тот же annotation workflow, что и UI, не зная React state. Текущая граница: доменные мутации в основном уже серверные, но orchestration пока реализован лишь частично.

Новый headless-фундамент реализован:

```text
GET /management/annotation-workflow
GET /management/items/:source/:sourceItemId/annotations/:annotationId/stages/:stage/guide
GET /management/items/:source/:sourceItemId/annotations/:annotationId/stages/:stage?label=<labelId>
POST /management/items/:source/:sourceItemId/annotations/:annotationId/stages/:stage/commands?label=<labelId>
POST /management/items/:source/:sourceItemId/annotations/:annotationId/automation/run
POST /management/items/:source/:sourceItemId/annotations/:annotationId/automation/jobs
GET  /management/items/:source/:sourceItemId/annotations/:annotationId/automation/jobs
GET  /management/items/:source/:sourceItemId/annotations/:annotationId/automation/jobs/:jobId
POST /management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans
GET  /management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans/:planId
POST /management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans/:planId/apply
GET  /management/items/:source/:sourceItemId/annotations/:annotationId/vision-context
POST /management/items/:source/:sourceItemId/annotations/:annotationId/controllers/system/plan
POST /management/items/:source/:sourceItemId/annotations/:annotationId/visual-context/render
POST /management/items/:source/:sourceItemId/annotations/:annotationId/controllers/local-ml/plan
POST /management/items/:source/:sourceItemId/annotations/:annotationId/controllers/llm/plan
```

`annotationId` сейчас равен стабильному `annotationTrackId`. Stage state разрешает Package через backend-связь track → Package. Для Label-scoped стадий при нескольких Label требуется явный `label`; сервер не выбирает первый Label молча. Guide содержит goal, prerequisites, requirements, constraints, helper identity, canonical command vocabulary и ссылки на существующие stage-specific API. Command endpoint проверяет допустимость action для стадии, prerequisites, владение target текущим track и выбранной Label-веткой, затем вызывает существующий stage service; сам executor напрямую в annotation tables не пишет.

| Stage | UI action | Existing API | Missing API | Validation location | Helper | Output |
|---|---|---|---|---|---|---|
| Package | full-image/crop, type, add/delete | graph API + Wizard Commands | создание нового track/package остаётся отдельной structural operation | command ownership + schema + graph repository | `package-scope` | `Package.scope`, `packageType`, operation trace |
| Label | auto detect, multi-select review, draw/edit/delete | source-analysis/graph API + Wizard Commands | full automatic controller | command prerequisites + helper/schema/repository | `label-roi-detection` | candidates, reviewed `Label[]`, operation trace |
| Object Context (`bottle`) | preview/tune/select/accept/skip | source-analysis API + Wizard Commands | full automatic controller | command prerequisites + source-analysis service + graph projection | `bottle-outline` | reviewed object contour/palette |
| OCR | auto/manual, edit, dedupe/merge/reparent | graph OCR API + Wizard Commands | `ProposedOutput` controller boundary | command branch ownership + server schemas/services/repository | `label-ocr-cascade` | canonical Label-owned OCR + candidate/review trace |
| Mask | preview params, commit | CV preview/checkpoint + Wizard Commands | full automatic controller | command stage/branch validation + backend CV schema/service | `label-mask` | Label checkpoint + StageSample evidence |
| Morphology | preview params, commit | CV preview/checkpoint + Wizard Commands | full automatic controller | command stage/branch validation + backend CV schema/service | `label-morphology` | Label checkpoint + StageSample evidence |
| Components | preview, accept/reject regions, commit | CV preview/checkpoint + Wizard Commands | typed controller proposal | backend review schema through command executor | `label-components` | reviewed component decisions |
| Elements | group/ungroup, semantic type, commit | CV preview/checkpoint + Wizard Commands | typed controller proposal | backend review schema through command executor | `label-elements` | reviewed semantic Elements |
| Contours | preview/commit | CV preview/checkpoint + Wizard Commands | full automatic controller | backend CV service through command executor | `label-contours` | reviewed contours |
| Palette | remove/add colour, commit | CV preview/checkpoint + Wizard Commands | typed controller proposal | backend palette schema through command executor | `label-palette` | reviewed palette |
| Summary | inspect graph, resolve warnings, final review | graph/review/export API + Wizard `commit` | graph-native final review superseding legacy payload | graph validation + legacy summary review | `label-summary` | final review/export readiness |

### Реально реализовано

- canonical Package/Label/OCR/Meta graph со стабильными IDs;
- server-side create/edit/delete, Label candidate review, OCR merge/dedupe/reparent;
- helper configs, immutable helper runs/candidates и reviewed outputs;
- `StageSampleV1` adapters/native evidence для всех стадий;
- Label-owned CV checkpoints;
- trusted actor boundary `human | ml-agent | hybrid` отдельно от stage automation `auto | mixed | manual`;
- единый workflow/stage guide/state contract для UI, LLM и local ML клиентов;
- единый Wizard Command endpoint, делегирующий `run_helper/select_candidate/update_params/create_region/edit_region/delete_region/merge/reparent/set_semantic/commit` существующим canonical services;
- manual OCR `create_region` обязательно проходит server-side dedupe-preflight: при найденном дубле executor возвращает `decisionRequired`, а create/merge применяется только явным решением.
- `runFullAutomaticPipeline()` и `/automation/run` выполняют helper-only прогон до `through`, возвращают один `pipelineRunId`, общие `stages`, Label-scoped `labelStages`, `warnings`, `failures` и `requiresReview`;
- агрегированный прогон не принимает candidates как ground truth: свежая карточка останавливается после Label AutoOutput, а OCR/CV продолжаются только для уже reviewed canonical Label/OCR; при нескольких Label для Object Context требуется явный `objectContextLabelId`.
- `ANNOTATION_HELPER_PIPELINE` использует существующие `generation_jobs` и recognize worker: job хранит automation input, `pipelineRunId`, stage outputs, warnings/failures и `requiresReview`; config hash участвует в idempotency;
- persisted job пока поддерживает один item + обязательный `annotationTrackId`. Batch намеренно запрещён, пока target contract не хранит отдельный track для каждого item.

### Частично реализовано

- Package context устойчиво определяется annotation track, но active Label остаётся клиентским выбором; headless API требует явный `labelId`, не хранит UI cursor как ground truth;
- stage validation объединена на уровне command boundary, но часть `commit` всё ещё адаптирует legacy stage payloads; отдельного graph-native final review пока нет;
- CV стадии обёрнуты общим executor, но payload пока сохраняет существующую stage-specific форму preview/checkpoint;
- track-level actor provenance пока агрегирует машинные вызовы как `ml-agent`, но correction plan и stage proposal уже сохраняют точный executor `llm | local_ml | system`;
- `AutoOutput`, отдельный controller `ProposedOutput` и `ReviewedOutput` существуют как три разные границы. Migration `044` хранит план, validation и replay result.
- correction plan создаётся только после dry validation текущих prerequisites, branch/track ownership и stage payload schemas. Apply однократно claims plan и последовательно исполняет операции через Wizard Command Executor; межсервисная операция честно возвращает `partially_applied`, а не изображает атомарный rollback.

### Planned / отсутствует

- batch PipelineRun orchestration с `{source, sourceItemId, annotationTrackId}` для каждого item;
- обученный local model; provider-neutral LLM runtime уже реализован для OpenAI Responses и Qwen Model Studio OpenAI-compatible API, но реальный запуск требует ключа/endpoint выбранного provider и отдельного API billing;
- дополнительные stage-specific crop/overlay render modes поверх уже реализованных bounded preview и OverlayModel;
- LLM/local-ML/helper-only annotation jobs, batch orchestration и cost/correction metrics;
- тонкий MCP/agent adapter поверх Wizard API.

Главный invariant закреплён кодом: controller не получает отдельного mutation path в БД. Compose поднимает deterministic `annotation-controller` и отдельный provider-selectable `llm-controller`. Основной LLM-контракт — `StageObservation -> StageLLMDecision`; модель не генерирует Wizard commands. **Implemented:** stage-scoped review для Label, Object Context, OCR, Mask, Morphology, Components, Elements, Contours и Palette; Recognize сам запускает или переиспользует helper, формирует bounded observation и overlay, проверяет `accept | review | rerun | human_required` и создаёт только неприменённый correction plan. Для стадий с реальным регулируемым config `rerun` принимает только semantic adjustment, который сервер переводит в bounded параметры; разрешено максимум два повтора, а configs/решения всех попыток сохраняются в iteration trace. Granular `review` работает только по известным ID: исправление/отклонение OCR, accept/reject Components, классификация/reject Elements и перемещение известных Components между существующими либо bounded новыми группами Elements. Persisted ID и provenance новой группы создаёт Recognize; подмена identity, двойное владение компонентом и cross-domain поля отбрасываются сервером. Package остаётся ручным техническим scope, Summary — advisory. Ошибка provider превращается в `no-action`, поэтому ручная разметка остаётся доступной. **Partially implemented:** decision trace пока хранится в correction-plan ProposedOutput, а не в отдельном append-only поле StageSample. **Planned:** cache, quality/cost metrics и batch execution. Старый whole-Wizard prompt/plan normalizer остаётся compatibility-кодом, но не является целевой LLM-архитектурой.

Для последовательной работы по карточке добавлены `LLMSession` и `LLMStageRun`. Сессия принадлежит одному annotation track и хранит канонический контекст в БД; каждый запуск текущей стадии создаёт отдельную запись со статусом, input artifacts, числом итераций, decisions и ссылкой на correction plan. Потеря provider chat history не влияет на воспроизводимость: нужный `StageContext` заново собирается из persisted Wizard state и session context. В UI отдельно показаны `Auto result`, `LLM decision`, `Human result` и раскрываемый transition trace. Jobs принимает frozen список `(source, sourceItemId, annotationTrackId)` и создаёт `ANNOTATION_LLM_PIPELINE`: worker выполняет те же stage runners, автоматически применяет validated plans и при `human_required` останавливает только зависимую ветку конкретной карточки. Ссылка из Jobs возвращает в обычный Wizard. **Implemented:** одиночная карточка, resume после reload, завершение сессии и explicit-card batch. **Planned:** pause/resume, per-job concurrency, cost/latency и quality aggregates; отдельного Jobs-редактора разметки быть не должно.
