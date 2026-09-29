# Хранение И Выгрузка Размеченных Данных

Status: current implemented contract  
Scope: persistence, JSON API, frozen dataset artifacts and CLI export  
Last verified against code: 2026-08-27

`StageSampleV1.execution.runs[]` хранит неизменяемый запуск helper-а: config, candidates, output, artifact и `intermediateStates`. Последнее поле — ограниченный execution trace внутренних проходов алгоритма (`id`, optional `parentId`, `sequence`, `status`, `algorithm`, compact `summary`). Оно экспортируется как evidence для анализа и обучения, но не является reviewed ground truth и не задаёт порядок Wizard stages. У исторических runs, записанных до migration `050`, массив пустой.

## Canonical annotation graph export (implemented)

Live manual export now uses schema v5 and carries schema-v6 annotation graphs. `items[]` is one nested `Item -> Package[] -> Label[] -> OCR[] + Meta[]` graph per catalog item. Current reviewed entities are kept separate from `operationTraces[]`, which retain helper/config/candidates/selection/review provenance even after logical entity deletion. `legacyTracks[]` temporarily preserves the previous track-scoped payload and `annotationTrackCount` during the additive migration. The endpoint remains read-only and does not create files.

The graph itself is available directly through `GET /management/items/:source/:sourceItemId/annotations` and through the Next BFF mirror `GET /api/admin/recognition/items/:source/:sourceItemId/annotations`. Graph add/edit/delete routes are documented in Swagger under `Annotation Graph`.

Annotation graph schema v7 requires every OCR to belong to one Label/VisualRegion and to declare its `label-rectified` coordinate space with `labelId`, `cropRevision`, `width` and `height`; nullable crop fields are reserved for migrated records whose exact historical crop cannot be reconstructed. `legacyManaged = true` marks an OCR projection owned by the wizard. Historical Package-owned OCR is converted by migration `041` into OCR under a synthetic, unreviewed VisualRegion rather than remaining a second parent mode.

Annotation graph schema v4 normalizes canonical OCR semantics. An OCR entity exposes independent `regionStatus`, `transcription { text, status }`, `layout { type, flow, baselineAngleDeg, baseline, characterOrientation }`, optional local `rectification`, `parentRelation`, operation provenance and nested `meta[]`. The detection quad remains ground truth in its original coordinate space; rectification describes only how to prepare its recognition crop. The public transcription vocabulary is `verified | partial | unreadable`; `unreadable` requires `text = null`, while `partial` retains the readable fragment but is excluded from recognition GT. The former `no_transcription` and direction/orientation fields remain deprecated compatibility storage and are not canonical output. Semantic annotations use `meta[] = { tags, note?, source: human | auto }`; deterministic warnings such as mixed-script are derived from text.

## Короткий Ответ

Разметка не записывается Job-ом сразу в dataset-файл.

Основной поток:

```text
Wizard / management API
  -> PostgreSQL meta.*
  -> optional generated assets in asset-store
  -> cohort with fixed item keys
  -> immutable dataset version snapshot in PostgreSQL
  -> explicit Export operation
  -> ./exports/<dataset-artifact>/
```

До явного `Export artifact` источником истины остаётся PostgreSQL. Job может создавать crop/debug assets, но это не считается выгрузкой датасета.

## Что Куда Сохраняется

| Операция | Основное хранилище | Создаёт training-файлы |
| --- | --- | --- |
| Save reviewed Label ROI | revisioned `meta.image_annotations` | нет |
| Save reviewed OCR regions/text | revisioned OCR annotation tables | нет |
| Save source associations / catalog identity | revisioned review tables | нет |
| Accept Bottle Context | `meta.items.visual_features.labelSourceAnalysis` | нет |
| Save CVJOB Components/Elements/Contours/Palette | `meta.items.visual_features.labelCvJob` | нет |
| `ANALYZE_LABEL` Job | job/result rows, OCR run/regions, `visual_features.labelAnalysis`, crop в `asset-store` | нет |
| Freeze dataset version | immutable snapshot rows в `meta.dataset_version_items` | нет |
| Export frozen dataset version | `./exports/...` и registry row в `meta.dataset_artifacts` | да |
| CLI live-export | `./exports/<name>/` | да, но без frozen cohort lineage |

Изображения не дублируются внутрь JSONL. Записи содержат `imageRef`, который разрешается через общий `asset-store`. Поэтому для другой машины нужны и DB dump, и актуальный каталог изображений.

## 1. Read-Only JSON API Ручной Meta-Информации

Для просмотра текущего состояния без создания файлового artifact используется:

```http
GET /management/metadata/export/manual
GET /management/metadata/export/manual?source=svoe_vino
GET /management/metadata/export/manual?source=roskachestvo
```

Next BFF:

```http
GET /api/admin/recognition/metadata/export/manual
```

**Deprecated / superseded:** schema v3 строила одну запись `items[]` на каждый AnnotationTrack. Schema v4, описанная выше, заменила этот формат на item graphs, отдельные operation traces и compatibility-массив `legacyTracks[]`. Endpoint ничего не изменяет в БД и не создаёт файлы в `exports/`.

Track identity сохраняется в canonical Package через `legacyAnnotationTrackId` и отдельно в compatibility-массиве `legacyTracks[]`. Frozen cohort остаётся item-key based (`source + sourceItemId`) и не позволяет независимо включать/исключать Packages, но frozen snapshot schema v5 сохраняет все Package/Label/OCR текущего item.

Это operational JSON dump для диагностики/переноса, а не воспроизводимый training dataset.

## 2. Frozen Dataset Artifact — Основной Training-Путь

### Шаг 1 — Cohort

Cohort фиксирует набор item keys:

```text
source + sourceItemId
```

### Шаг 2 — Dataset Version

Создание версии замораживает reviewed revisions и фиксирует детерминированный split:

```text
train / validation / test
```

Snapshot хранится в PostgreSQL. Последующие изменения карточек не меняют уже созданную dataset version.

### Шаг 3 — Explicit Export

Recognize API:

```http
POST /management/datasets/versions/:datasetVersionId/export
```

Next BFF:

```http
POST /api/admin/recognition/datasets/versions/:datasetVersionId/export
```

Экспорт атомарно создаёт:

```text
exports/<dataset-artifact>/
  manifest.json
  annotations.jsonl
  splits.json
  tasks/
    label-roi.jsonl
    ocr-region.jsonl
    source-matching.jsonl
    alias-ranking.jsonl
    bottle-outline.jsonl
    label-elements.jsonl
    label-palette.jsonl
```

`annotations.jsonl` содержит универсальные frozen snapshots. В schema v5 каждый snapshot включает полный `annotationGraph`. `tasks/*.jsonl` — детерминированные adapter-v4 представления для конкретного trainer target; один item может дать несколько samples для разных Package/Label/OCR scopes. Adapter v4 переносит в Label `helperContext` полный semantic bridge review: multi-result operation ищется по `results[]`, `reviewOperations[]` остаётся совместимым кратким представлением merge, а `roiReviewGraph` содержит неизменяемые ROI nodes и операции `reject | edit | merge | approve`. Поэтому цепочки `ROI1 + ROI2 -> merge -> ROI3` и `ROI3 -> edit -> ROI4` не деградируют до неструктурированного before/after; исходные autodetect candidates никогда не перезаписываются.

Каждая новая операция `roiReviewGraph` также содержит `actor`: `human`, `llm`, `local_ml` или `system`; reject является отдельным training-сигналом, а не просто отсутствием candidate в финальном output. Actor трансформации и actor финального approval независимы: при применении LLM plan человеком `edit | merge | reject` сохраняют `llm`, а `approve` — `human`. Исторические графы без actor читаются как `unknown`, потому что достоверно восстановить инициатора из результата нельзя. Таким образом один export позволяет независимо строить targets для candidate validity, same-entity merge, необходимости коррекции, human correction поверх LLM proposal и финального `StageInput -> ReviewedOutput`.

Task adapter сохраняет:

- минимальный `input`;
- только reviewed `target`;
- фиксированный split;
- snapshot hash и schema version;
- явную coordinate space.

CV proposals/config из `vision.cvMeta` не копируются в visual ground-truth targets. Bottle geometry остаётся в source-image pixels, OCR regions — в normalized reviewed-label crop coordinates, Elements/Contours получают размер crop-mask coordinate space.

### Label-scoped CV state (implemented / partial trace boundary)

Migration `040` stores `revision`, `cv_crop` and `cv_job` on each canonical Label. Therefore two Labels of one Package no longer share Mask/Morphology/Components/Elements/Contours/Palette state. The live manual JSON and frozen schema-v5 `annotationGraph` include this state under the corresponding `packages[].labels[].cv` object.

Task adapter v3 emits `label-elements` and `label-palette` independently for every Label that has reviewed CV output. The record input keeps `packageId`, `labelId`, Label geometry, coordinate space and available checkpoint helper context; the target contains reviewed elements/contours or palette only. Changing Label geometry increments its revision and clears the derived crop/CV state, so stale pixels cannot be exported as current Label evidence.

**Partial boundary:** canonical Label CV execution snapshots currently live in `label.cv.job.workflow.checkpoints`. They are exported with the graph, but are not duplicated into `meta.wizard_stage_executions`, whose legacy uniqueness is track + stage and cannot safely represent several Label branches in one track.

### Parent-scoped Auto OCR operation trace (implemented)

Canonical graph v9 не разделяется на PackageOCR и LabelOCR: PackageOCR больше не существует. Каждый OCR entity обязательно имеет `packageId + labelId` и geometry в `label-rectified/normalized`. `packageId` остаётся денормализованной связью и проверяется против Package выбранной Label. Legacy direct OCR переносится в synthetic Label с `origin = migrated_from_direct_ocr` и `geometryReviewStatus = suggested`; OCR export остаётся валидным, но такой ROI не является Label/VisualRegion GT до review. `visualRegionKind` проверяется отдельно от геометрии. Generic `label-roi` экспортирует все reviewed VisualRegion, а `physical-label-roi` — только регионы с reviewed `visualRegionKind.value = physical-label`; старые snapshots без такой аттрибуции не получают выдуманный physical-label GT.

`run_ocr` Operation хранит `scope`, helper/config и полный исходный candidate set. Candidate хранит machine geometry/text, detection/recognition confidence, предложенные layout/rectification, `suggestedParent` и duplicate analysis. Review хранится отдельно как `accepted | edited | rejected | merged`, `finalParent`, reviewed geometry/transcription/status/layout/rectification и optional result entity reference. `operation.results[]` связывает один run со всеми созданными или подтверждёнными OCR entities. Поэтому export различает helper suggestion и человеческую коррекцию, включая локальный deskew, даже после logical delete результата. Manual OCR остаётся допустимым Operation без candidate selection.

Для повторного helper observation review дополнительно поддерживает `merged`. Candidate сохраняет список duplicate matches с geometry/text/total score и classification. `merged.resultEntityId` указывает на уже существующий OCR того же Package; несколько candidates из разных Operations могут ссылаться на один OCR id, и `UNIQUE(resultEntityId)` намеренно отсутствует. Nested canonical `items[].packages[].ocr/labels[].ocr` строится только из OCR entities и не содержит дублей. `operationTraces` сохраняет все повторные observations как положительные helper-training examples.

### Helper Config Contract v1

Конфигурации автодетект-хелперов являются воспроизводимым ML-контекстом, а не только состоянием UI. Frozen snapshot хранит их в `vision.cvMeta.helpers = { schemaVersion: 1, records: [...] }`. Каждый record содержит `helperId`, версионированный `algorithm`, `configSchemaVersion`, полный normalized `config`, `role = conditioning-input`, `provenance` и ссылку `review.targetRef` на проверенный результат. Реализованы отдельные records для всех этапов визарда: `label-roi-detection`, `bottle-outline`, `label-ocr-cascade`, `label-mask`, `label-morphology`, `label-components`, `label-elements`, `label-contours`, `label-palette` и `label-summary`. Конфиг каждого CV-этапа содержит только параметры собственного алгоритма; зависимости от результатов предыдущих этапов задаются последовательностью workflow, а не копированием upstream-конфигов.

Adapter v2 передаёт соответствующий record как `input.helperContext` для visual tasks. Config не копируется в geometry/classification `target` и поэтому не объявляется ground truth контура, элементов или палитры. Для будущего ML helper-config proposer этот же reviewed record может быть преобразован отдельным task-adapter в target «предсказать config»; model-generated предложения должны записывать `provenance.source = model-proposed` и `modelVersionId`, а ручное принятие сохраняет proposal и reviewed outcome раздельно.

В рабочих API визарда тот же контракт возвращается как `helperBinding`, дополненный `card.source`, `card.sourceItemId`, `wizardStage` и `persisted`. Aggregate `GET .../label-annotation/analysis` возвращает все десять записей в `helperBindings`. Swagger связывает operation с алгоритмом через `x-helper-id`; для CV preview конкретный helper определяется полем request body `stage`, а `persisted = false` явно отличает preview от сохранённого checkpoint.

OCR-region schema разделяет неизменяемый machine `prediction` и итоговый human `annotation`. Отсутствие annotation означает unreviewed candidate и не сохраняется как отдельный пользовательский статус; переход с OCR stage создаёт reviewed annotation revision. `annotation.transcriptionStatus` имеет только `verified`, `partial` и `unreadable`. У `unreadable` `annotation.text = null`, но bbox остаётся положительным text-detection GT. Recognition GT вычисляется только для `verified` с непустым text. `bboxEdited`, `textEdited`, `detectionGt`, `recognitionGt` и source (`manual | auto | partially-corrected | fully-corrected`) вычисляются сравнением prediction и annotation, а не редактируются оператором. Исходный prediction сохраняется отдельно для IoU/CER/WER и accepted-as-is аналитики.

Label ROI использует аналогичный schema-v2 contract. `prediction` содержит `helperRunId + candidateId`, выбранную proposal geometry, confidence и точный `algorithm { id, version, params, defaultParams? }`; `annotation` содержит итоговый human-reviewed ROI. `helperRunId` адресует immutable run с authoritative config и полным набором candidates, а algorithm params остаются self-contained snapshot того же конфига. Связь review с proposal фиксируется `meta.image_annotations.suggestion_id`, поэтому экспорт восстанавливает именно исходный выбранный proposal. `labelRoi` в manual export, CLI dataset и frozen dataset snapshot содержит оба слоя; visual GT берётся только из `annotation.roi`. `reviewed`, `labelRoiGt`, `roiEdited`, source и IoU являются производными. Raw `labelAnnotations` и `labelPredictions` сохраняются в manual export как revision/debug history.

### StageSampleV1 — каноническая domain-единица (adapter v1 и native capture implemented)

Текущий `Helper Config Contract v1` является **реализованным транспортным фундаментом**, но не полным execution trace. Он доказывает, что Swagger, API, PostgreSQL и final/manual JSON умеют передавать и восстанавливать stage-scoped helper metadata с привязкой к карточке. Наличие одного `config`, `provenance` и `review.targetRef` ещё не образует `StageSampleV1`.

Целевой domain-контракт:

```ts
type StageSampleV1 = {
  cardId: string;
  stage: WizardStage;
  stageInput: StageInput;
  helper: {
    id: string;
    algorithm?: string;
    version?: string;
  };
  execution: {
    runs: Array<{
      id: string;
      config: HelperParams;
      candidates: StageCandidate[];
      output: StageOutput;
    }>;
    selection: { runId: string; candidateId: string } | null;
    reviewMode: "accepted" | "corrected" | "manual" | null;
    initialParams: HelperParams;
    finalParams: HelperParams;
    autoOutput?: StageOutput;
    proposal?: {
      executor: "human" | "llm" | "local_ml" | "system";
      interactionMode?: "auto" | "manual" | "mixed";
      planId?: string;
      llmDecision?: {
        mode: "accepted_helper" | "modified_helper" | "manual_created";
        executor: "llm";
      };
      review?: {
        reviewedBy: "human" | "llm" | "local_ml";
        finalEditor: "helper" | "llm" | "human" | "local_ml";
        verdict: "llm_correct" | "llm_false_accept" | "llm_false_correction" | "llm_partially_correct";
        reviewedAt: string;
      };
    };
    reviewedOutput: StageOutput;
  };
  humanCorrection: {
    reviewed: boolean;
    paramsEdited: boolean;
    outputEdited?: boolean;
    changedFields?: string[];
    reviewedAt?: string;
  };
};
```

Каноническая обучающая запись остаётся двухточечной: `initialParams + autoOutput -> finalParams + reviewedOutput`. Полный controller `proposedOutput` хранится в операционном correction plan для валидации/replay, но не экспортируется как третье содержательное состояние StageSample. В StageSample остаётся только компактная proposal/review metadata. Поэтому retries, промежуточные bbox/OCR edits и ошибочная LLM-геометрия не образуют отдельную dataset history.

`VisionContextV1` является компактным входом controller-а, а не новым GT: source asset refs, coordinate spaces, Package/Label/OCR geometry, лёгкие CV artifact refs, stage state и execution evidence. Reference `wizard-system-controller-v1` использует его для выбора только текущего безопасного helper frontier. Он сохраняет ProposedOutput/correction plan, но не выполняет plan и не принимает helper candidates.

`VisualContextRenderV1` — производное представление для controller inference, а не persistence GT. Оно содержит base/overlay WebP assets, source viewport, точный `source-crop-scale` transform и OverlayModel. Source Package/Object/Label geometry сохраняется рядом с preview geometry; normalized Label OCR сначала проецируется через reviewed Label quad. По render-asset нельзя заменять canonical source geometry.

`local-ml-http-v1` передаёт `VisionContextV1 + VisualContextRenderV1 + overlay WebP` во внешний runtime, адрес которого задаётся только `LOCAL_ML_CONTROLLER_URL`. Runtime возвращает `controller`, `proposedOutput` и `operations[]` из canonical Wizard vocabulary. Ответ проходит schema validation и полный correction-plan preflight; прямой результат модели не является ReviewedOutput и автоматически не применяется.

Controller response имеет два явных исхода: `planned` с непустым `operations[]` или `no_action` с причиной и пустым списком. Compose reference runtime использует второй вариант на human-review boundaries, поэтому транспортный контракт не вынуждает модель генерировать фиктивную mutation.

`wizard-llm-http-v1` использует тот же строгий correction-plan contract, но сохраняет `executor = llm`. На вход внешнему контроллеру передаются глобальный Wizard contract, `VisionContextV1`, ограниченные по размеру clean/overlay WebP и непрозрачный `input`. Recognize остаётся provider-neutral; Compose runtime за endpoint `LLM_WIZARD_CONTROLLER_URL` выбирает OpenAI Responses либо Qwen Model Studio OpenAI-compatible Chat Completions через `LLM_CONTROLLER_BACKEND`. Оба адаптера используют общий prompt/output schema и canonical normalizer. `controller.id`, `controller.model`, `controller.promptVersion`, provider response id и usage сохраняют provenance конкретного запуска. LLM не имеет отдельного mutation path и не может автоматически применить plan.

`executor` и `interactionMode` являются независимыми осями. Первый принимает `human | llm | local_ml | system`, второй — `auto | manual | mixed`. Migration `046` сохраняет `interactionMode` в correction plan и после replay переносит его в `StageSample.execution.proposal` вместе с executor/planId.

Для `executor = llm` `interactionMode` детерминированно проецируется в `llmDecision.mode`: `auto -> accepted_helper`, `mixed -> modified_helper`, `manual -> manual_created`. После применения plan и завершения canonical stage человек может записать оценку через `PUT .../correction-plans/{planId}/review`. Migration `047` хранит только `reviewedBy`, `reviewerSubject`, `finalEditor`, `verdict`, `reviewedAt` на финальной reviewed execution. `reviewedBy` выводится из доверенных auth headers и не принимается из body. `finalEditor` отделён от reviewer: подтверждение человеком корректной LLM-правки сохраняет `reviewedBy = human`, `finalEditor = llm`.

Два критических исхода не выводятся сравнением геометрий, а задаются явным verdict: `accepted_helper + llm_false_accept` означает, что LLM пропустила ошибку helper; `modified_helper + llm_false_correction` означает, что LLM испортила корректный helper result. `llm_partially_correct` фиксирует полезную, но незавершённую LLM-коррекцию. Так метрики LLM не меняют source of truth: GT по-прежнему только `reviewedOutput`.

`paramsEdited` является производным значением `diff(initialParams, finalParams)`, а `outputEdited` — сравнением доступного `autoOutput` с `reviewedOutput`. Эти флаги не должны становиться независимыми источниками истины.

Три набора параметров имеют разную семантику и не подменяют друг друга:

- `defaultParams` — встроенные или рекомендованные значения версии алгоритма;
- `initialParams` — параметры конкретного фактически выполненного автоматического запуска;
- `finalParams` — параметры запуска, результат которого принял человек.

Для legacy-записи отсутствие исторического auto-run должно экспортироваться как явный migration gap (`unknown`/`unavailable` в будущей формальной schema), а не заполняться `defaultParams`, пустым объектом или текущим `finalParams`.

Физическое хранение остаётся отделено от domain-представления:

```text
existing stage tables / JSON metadata
                -> stage adapters
                -> StageSampleV1
                -> final raw JSON / dataset export / ML training
```

Реализованный adapter-слой преобразует текущие Label, Bottle, OCR, Mask, Morphology, Components, Elements, Contours, Palette и Summary records в единый контракт. Для новых проходов все десять стадий нативно пишут revisioned execution. Migration `025` сохраняет каждый различающийся reactive helper run как `config + candidates + output`, а review ссылается на выбранные `runId/candidateId` и фиксирует `accepted | corrected | manual`. `initialParams/autoOutput` остаются совместимой проекцией первого run; `finalParams/reviewedOutput` — итоговой границей. Label без detector proposal и ручные OCR-регионы без OCR run корректно остаются без выдуманного machine input; старые записи продолжают читаться через adapters с `runs = []` и явным `unavailable`.

Таким образом, весь wizard концептуально становится `StageSampleV1[]`. Один и тот же deterministic helper может управляться Human Controller или будущим ML Controller без изменения UI/API/DB-границы. Из одного reviewed trace можно строить отдельные training targets: `input -> reviewedOutput`, `input -> finalParams`, `input + initialParams + autoOutput -> correctedParams` и выбор лучшего candidate result.

Статус на 2026-08-25:

- **implemented:** общий `StageSampleV1`, adapters и revisioned native execution persistence для всех стадий, card/stage/helper binding, Swagger stage response, aggregate stage samples, manual/CLI/frozen exports, schema-v4 execution snapshots и schema-v5 canonical graph snapshots;
- **partially implemented:** исторические записи, полностью ручной Label без proposal и ручные OCR-регионы без OCR run не имеют восстановимого auto-run и поэтому экспортируются с честным migration gap;
- **planned:** trainer/runtime, который будет потреблять эти execution traces; расширять отдельные stage-контракты для этого не требуется;
- **forbidden compatibility shortcut:** считать `defaultParams` историческими `initialParams`.

Manifest фиксирует count, adapter version и SHA-256 каждого task-файла. Artifact регистрируется в `meta.dataset_artifacts`. Readiness перед созданием training run повторно проверяет основной JSONL и выбранный task JSONL по filesystem manifest и manifest из БД.

Каталог `./exports` примонтирован в Recognize container как `/exports` через `DATASET_EXPORT_ROOT`, поэтому artifact переживает пересоздание контейнера.

## Canonical Elements/Contours Contract

`vision.annotations.elements` stores semantic objects, not physically merged pixels. An Element owns one or more `sourceComponentIds`; there is no additional required Group entity. Its union `bbox` is derived, while the atomic component geometry remains canonical. `type` describes visual nature (`text | graphic | separator | shape | unknown`), independently from semantic `role` (`brand | product_name | variety | producer | year | description | logo | signature | ornament | separator | unknown | other`). A one-component Element is valid. An accepted component without an Element is incomplete review and is not contour ground truth.

New schema-v4 Element records use `provenance.source`, optional `provenance.sourceRef`, and a separate `provenance.grouping` object. Sources are `manual | ocr | geometry | model | imported`; grouping methods are independently extensible (`manual | ocr-overlap | proximity | containment | alignment | model`). For OCR-derived Elements, `sourceRef = { kind: "ocr-region", id }` links to the source OCR region, while `grouping.confidence` measures component-to-region grouping quality. OCR recognition confidence remains on that OCR region and is not duplicated on Element. Legacy `textRegionId`, element-level `confidence`, `groupingMeta`, top-level `provenance.confidence`, and the short-lived `provenance.method` form are accepted on read and converted or omitted on the next save; new UI saves emit only the canonical structure.

`vision.annotations.contours` preserves real member geometry: each record remains attached to its `componentId` and `elementId`, with raw and simplified points. Multiple records with one `elementId` are the canonical MultiPolygon-like representation. A single enclosing polygon, convex hull or composite mask may be derived by a task exporter, but is not stored as reviewed ground truth. Legacy detailed element types are normalized to canonical type/role when a saved review is loaded or recalculated.

Heavy `rle-u8` mask layers are debug lifecycle data, not reviewed annotation. On a new checkpoint/save they are written to `asset-store/label-analysis/.../*-cv-debug.json`; `meta.items.visual_features.labelCvJob.debugArtifact` stores the reference and persisted `preview.cvDebug` retains only lightweight metadata. The analysis workspace hydrates the artifact for the viewer, while Raw metadata and dataset snapshots remain compact. Existing schema-v3 rows with inline layers stay readable and are compacted when that item is saved again.

## 3. CLI Live-Export

Команда:

```powershell
cd recognize-service
npm run export:annotation-dataset -- --name annotation-dataset-v4 --source all
```

Допустимые source filters:

```text
all
svoe_vino
roskachestvo
```

CLI читает latest reviewed данные непосредственно из текущей БД и пишет standalone JSONL export. Это удобно для диагностики и раннего эксперимента, но результат не привязан к immutable cohort/dataset version и не регистрируется как основной frozen artifact.

Для воспроизводимого обучения следует использовать frozen export.

## Что Job Делает И Чего Не Делает

`ANALYZE_LABEL`:

- использует точную reviewed Label ROI revision;
- сохраняет crop в `asset-store`;
- запускает OCR и сохраняет generated regions/evidence;
- сохраняет analysis metadata в PostgreSQL;
- не создаёт cohort;
- не замораживает dataset version;
- не пишет `tasks/*.jsonl`;
- не запускает trainer.

CV preview также не персистентен. Только явный Save/Accept записывает reviewed состояние, а только отдельный Export создаёт dataset-файлы.

## Правило Выбора Способа Выгрузки

```text
Нужно посмотреть/передать всю текущую meta history
  -> GET metadata/export/manual

Нужен быстрый live JSONL для диагностики
  -> npm run export:annotation-dataset

Нужен воспроизводимый вход для обучения
  -> cohort -> dataset version -> Export artifact -> tasks/*.jsonl
```

## Текущая Граница Реализации

- **Implemented:** сохранение ручных/reviewed слоёв в БД.
- **Implemented:** JSON API полного manual metadata state.
- **Implemented:** immutable cohort/dataset snapshots.
- **Implemented:** frozen artifact и task-specific JSONL adapters.
- **Implemented:** checksum/readiness validation перед training run.
- **Planned:** trainer worker, автоматическое обучение/evaluation и model-backed proposal jobs.

## OCR relation fields and export filtering

Canonical graph JSON includes for every OCR:

```json
{
  "parentRelation": {
    "packageId": "uuid",
    "labelId": null,
    "source": "auto",
    "status": "suggested",
    "suggestedLabelId": "uuid"
  }
}
```

Identity conflicts are represented by unresolved draft OCR operations/candidates and reported in `validation.unresolvedIdentityConflicts`; they block canonical export readiness. A suggested parent does not block detection/recognition exports. A parent-classifier adapter must include only `parentRelation.status = reviewed`. Operation history retains `merged`, `edit_ocr` and `reparent_ocr` as distinct facts.
# Label rectification в выходных данных

В `labelRoi.prediction.rectification` находится предложение helper-а, если оно существовало. В `labelRoi.annotation.rectification` находится принятая разметчиком версия. Для ручного cylindrical unwrap prediction может отсутствовать, а annotation содержит `guides` и `guided-grid-v1 transform`. В canonical `items[].packages[].labels[].rectification` экспортируется только reviewed версия; исходная helper suggestion остаётся в execution/proposal trace.
