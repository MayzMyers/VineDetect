# Label Annotation Workflow

Status: current implemented V2 annotation workflow; advanced review/training remain partial
Scope: user workflow for manual label ROI/OCR annotation and dataset export

## Card-level LLM session

**Implemented (migration 049):** одна annotation-карточка имеет одну открытую локальную `LLMSession`, а каждый stage-вызов — отдельный `LLMStageRun`. БД хранит авторитетный compact context, context events и диагностический input snapshot/decision/provider evidence. Qwen Conversation в Responses transport служит только continuity-слоем: новый stage всегда получает свежие изображения, актуальный helper output и разрешённые действия. `human_required` переводит сессию в `blocked`, а не `failed`. Provider conversation можно потерять или заменить без потери возможности восстановить workflow из БД.

**Implemented current-stage runtime:** `wizard-runtime-v1` задаёт на сервере словарь стадий, алгоритмов, разрешённых LLM-действий и переходов. LLM пока не управляет полным прогоном и не меняет порядок Wizard: он оценивает только текущую стадию. Сам helper может по промежуточному результату выполнить дополнительные внутренние проходы и вернуть до 32 `intermediateStates` с необязательной вложенностью `parentId`; migration `050` сохраняет их в конкретном track-level helper run, а Label-owned CV — в helper run соответствующего Label checkpoint. Эти состояния входят в `StageSampleV1`/экспорт и видны в UI Execution trace и LLM attempt evidence, но не являются новыми стадиями и не дают модели права создавать исполняемые команды. Для старых запусков значение — пустой массив, без реконструкции выдуманной истории.

**Implemented Edit Engine contract for Label and OCR (migrations 051-053):** `edit-engine-v1` задаёт общий словарь review-примитивов и требует финальный human approval. Ни UI, ни LLM не меняют исходный node на месте: трансформирующая операция создаёт derived node. Для Label LLM возвращает `accept | reject | edit | merge`. Для OCR действует строгий словарь `approve_region | approve_text | reject | edit_region | edit_text | merge_region | split_region | create_region | compose_string | decompose_string | set_status`; геометрия и transcription редактируются независимо, а физические merge/split не подменяют semantic composition. `compose_string` связывает два и более final approved OCR-region в ordered string, не удаляя их quad; `decompose_string` удаляет только эту связь. `split_region` принимает один quad, axis и 1-3 ordered fractions, создавая детерминированные children `op-N:1..K`. Каждый child проходит perspective crop, локальный `tesseract-cascade-v6` rerun и повторную Qwen-проверку. Связь одного helper candidate с несколькими canonical OCR сохраняется в `result_entity_ids`; двойной approve без настоящего split отклоняется. Migration 053 хранит Label-owned composition в canonical graph и преобразует временные Qwen node IDs в реальные OCR UUID внутри review transaction; ручной OCR-editor синхронизируется туда же. Geometry и выходные размеры crop сохраняются в system evidence; Qwen не может вызвать системную операцию напрямую. Допускаются максимум две correction-итерации и четыре изменённых региона за одну итерацию; дальнейшая нестабильность переводит карточку на human review. Финальная программа сохраняет LLM-операции, системные rerun nodes, helper evidence и связи с исходными candidate IDs, но остаётся unapplied correction plan до trusted apply. **Partially implemented:** reparent/role/order для LLM пока не включены; split ограничен прямыми horizontal/vertical cuts; созданный с нуля OCR можно включить в Qwen composition только следующим review после получения canonical UUID.

**Implemented operation dispatch registry:** общий словарь теперь содержит canonical cardinality входов каждого primitive (`merge = 2..20`, `create = 0`, остальные одиночные операции = 1). Исполнение выбирает deterministic handler по ключу `(stage, primitive)` и отклоняет объявленную, но ещё не реализованную комбинацию. Для Label зарегистрированы `accept | reject | edit | merge`; stage adapter больше не содержит собственный цикл исполнения этих операций и только переводит готовый accepted/rejected node graph в persisted Label review payload. В `StageObservation.editEngine.primitives` передаются только реально зарегистрированные handlers, а `declaredPrimitives` сохраняет целевой набор стадии для последующего переноса OCR/CV.

Текущий порядок стадий: `Package -> Label -> Object Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`. `Package` теперь является отдельным первым этапом и единственным местом редактирования рабочего crop. Полное изображение — валидное значение по умолчанию; crop остаётся helper input и не становится visual GT.

**Implemented Package LLM gate:** при старте автоматической card-session первой выполняется проверка количества физических Package в текущем source scope. `single` означает подтверждённый один Package и разрешает переход к Label; `multiple` сохраняет item-level Meta `package-multiplicity + multipackage` и завершает автоматический прогон со статусом `blocked_multipackage`. Напечатанные этикетки, логотипы и графика на одном объекте не считаются отдельными Package. Ручное создание второго canonical Package выставляет ту же отметку автоматически, поэтому повторный batch не создаёт LLM-сессию и останавливается до provider-вызова.

Начиная с migration `041` термин `Label` в domain означает универсальный `VisualRegion`, а не обязательно физическую наклейку. Любой локальный текст, печать на стекле, логотип, орнамент или смешанная композиция создаётся как Label; OCR всегда принадлежит выбранной Label. Ветка Direct/Package OCR удалена. Legacy Direct OCR мигрирует в минимальные synthetic Labels со статусом suggested/draft и не попадает в Label-detector GT до ручного review.

## Audited Current State

Last verified against code: 2026-09-02.

**Implemented canonical graph adapter:** wizard stages are editor operations, not the reviewed data schema. Migration `030` introduces `Item -> Package[] -> Label[] -> OCR[]` plus attachable Meta, and keeps helper runs/candidates as separate immutable Operation provenance. One legacy AnnotationTrack is linked to one Package. Saving Label, Bottle Context and OCR review synchronizes the graph without inventing missing historical geometry. Deletion is logical and cascades through graph children while preserving operation traces.

**Implemented UI migration slice:** wizard остаётся одним линейным pipeline, а `selectedPackageId` и `selectedLabelId` задают его текущий spatial/entity context. В компактном stage bar `1 Package` переключает/создаёт рабочий crop scope, `2 Label` переключает выбранную Label или создаёт новую через единственный `+ Add Label`; отдельные branch cards и верхнеуровневый `Region semantics` отсутствуют. В каждом track `Package` является рабочим spatial scope/pre-crop: `geometry = null` означает весь source image, а `Adjust crop` сохраняет уточнённую область в координатах исходника. Scope визуально показан на Label canvas, ограничивает ручной Label ROI и фильтрует Auto Label/Bottle candidates. Контур Bottle Context является отдельным stage result и больше не перезаписывает Package geometry. Дополнительные Label используют тот же quad/crop подход и canonical graph OCR editor. Выбранная canonical Label имеет собственную цепочку Mask -> Morphology -> Components -> Elements -> Contours -> Palette. Пока Label не выбрана, эти стадии отображаются как `blocked`; `N/A` зарезервирован для семантически неприменимых операций.

**Implemented Label review merge:** при общем approve выбранные helper candidates с реально пересекающимися bbox сервер автоматически объединяет в одну canonical Label. Для фрагментов с небольшим зазором UI имеет отдельный manual merge selection; его `mergeGroupId` является указанием review, а не готовой геометрией. В том же основном viewer annotator может изменить отдельный candidate до merge либо итоговый merged ROI до approve; обе операции имеют локальный Undo/`Ctrl+Z`, а UI явно показывает `unchanged | edited`. Сервер сначала строит deterministic enclosing quad, затем отдельно принимает reviewed merge geometry. Каждый исходный candidate/review сохраняется в Operation trace и указывает на общий `finalLabelId`; `helper_output.labelMergeGroups` фиксирует candidate IDs, deterministic `mergeGeometry`, итоговую `geometry` и режим `automatic | manual | mixed`. `helper_output.roiReviewGraph` хранит неизменяемые ROI-узлы и явные `reject | edit | merge | approve`: helper output остаётся `origin=autodetect`, исправления и объединения создают новые `origin=derived` ROI, а ручное создание — `origin=manual`. Последующий Edit уже принятой Label записывается отдельным `canonical -> edit -> approve` графом, поэтому цепочка восстанавливается без подмены исходных candidates. Существующий `merged -> resultEntityId` по-прежнему означает dedupe с уже существующей Label и не изменяет её geometry.

Выбор Label запоминается отдельно для каждого Package в пределах открытой item-card: возврат к ранее выбранному Package восстанавливает его последнюю Label, сохраняя один wizard и меняя только текущий context.

**Implemented Package/Object Context split:** UI называет второй этап `Object Context`; внутренний ключ `bottle` и поля `bottleDetection` пока сохранены как compatibility API. `Package.scope` отвечает только на вопрос «где работают helper-операции» и не является visual GT. Подтверждённый smart-lasso contour записывается в `Package.objectContext` со статусом/source/review timestamp. В Package card отдельно выбирается reviewed coarse type: `bottle | tube | box | other | unknown`. Manual export не отдаёт deprecated `Package.geometry` как canonical target: scope остаётся helper trace, reviewed objectContext — segmentation GT, reviewed packageType — classification GT.

**Implemented graph Auto OCR boundary (v9):** `auto-ocr` runs only in the currently selected Label/VisualRegion and persists exact config plus every candidate. OCR-stage состоит из двух последовательных фаз: сначала один Label-wide editor `Perspective / Cylindrical` исправляет всю поверхность этикетки и сохраняет `Label.geometry + Label.rectification`, затем Auto OCR строит все боксы уже в полученном `label-rectified` crop. В первой фазе доступен `label-rectification / cv-label-rectification-v1`: CV-helper оставляет исходную reviewed-геометрию контрольным кандидатом, предлагает Perspective-кандидат как suggestion, а на perspective-normalized crop ищет согласованный изгиб нескольких горизонтальных границ. При достаточном сигнале появляется отдельный Cylindrical-кандидат с автоматически построенными guides; слабый или противоречивый сигнал не порождает кандидат. UI показывает confidence, retained-area/displacement, число строк-свидетельств и signed curvature. Выбор без изменений сохраняется как `accepted`, ручная правка выбранного варианта — как `edited`; без запуска helper результат остаётся manual. OCR viewer, auto candidates и ручные OCR regions несут текущий `Label.revision`; после изменения перспективы/цилиндрической сетки прежние регионы остаются в operation history, но не отображаются и не считаются завершённым текущим OCR-stage. Parent поэтому не является per-candidate UI choice. Разметчик принимает/исправляет/отклоняет/merge-ит candidates или рисует OCR вручную. Dedupe сравнивает canonical OCR во всех Labels одного Package; relation correction остаётся отдельной Label-to-Label `reparent_ocr` operation. Geometry review и VisualRegion semantics независимы: reviewed ROI может оставаться `unknown`, а `physical-label-roi` export требует явной reviewed-классификации `physical-label`.

**Implemented OCR layout/rectification slice:** основная perspective/cylindrical correction теперь выполняется один раз над целой Label в начале OCR-stage. OCR region geometry затем хранится в нормализованном пространстве этого исправленного Label crop. Region editor отдельно сохраняет только семантику reading baseline, character orientation и optional local rotation для исключительных строк; она не заменяет Label-wide dewarp. Horizontal/Vertical/Angled — UI presets, а не persisted orientation enums. Perspective/affine/curved варианты локального region transform зарезервированы validated API contract; глобальная surface correction принадлежит Label layer.

**Implemented OCR review-state split (migrations 051-053):** основной OCR editor ревьюит текущее состояние, а не заставляет выбирать единственного candidate. Физические `word/region` quad и логические `string` независимы. `Merge regions`/`Split region` меняют топологию геометрических регионов; `Compose string` создаёт семантическую строку со ссылками `memberIds` и не удаляет word boxes; `Decompose` удаляет только эту связь. Revision OCR review хранит `compositions[]` и автоматически выведенный `reviewOperations[]` (`approve_region`, `approve_text`, `reject`, `edit_region`, `edit_text`, `merge_region`, `split_region`, `create_region`, `compose_string`). Canonical graph публикует тот же reviewed результат как Label-owned `ocrCompositions[]` с provenance `human | llm | legacy`. Qwen physical split использует axis/fractions, создаёт несколько immutable outputs одного source candidate и повторно распознаёт каждый output; Qwen semantic compose/decompose работает независимо от geometry. Поэтому неизменённый OCR остаётся положительным sample, а исправление geometry, transcription и composition различимо в export. **Partially implemented:** ручной UI split пока делит прямоугольный bbox по пробелам; произвольная линия разреза ещё не подключена.

Repeated detections use a fourth review state, `merged`. A configurable package-scoped matcher enriches raw candidates with geometry/text duplicate analysis; it never silently merges. The annotator must explicitly link a repeated candidate to an existing canonical OCR or keep it separate. A merge preserves the existing OCR parent/text/geometry and stable identity, but adds the existing id to the new Operation results and records a positive candidate observation. Operations and candidates are never physically merged or removed.

**Implemented annotation tracks:** один catalog item содержит один или несколько независимых `AnnotationTrack`. Каждый track запускает полный wizard и имеет собственные ROI, helper runs/config/candidates, OCR/CV revisions, review и Summary. Общими могут быть item identity и source asset, но не результаты стадий. Рабочий URL всегда содержит `?section=annotation&track=<uuid>`; API стадий требует тот же `track`. При отсутствии track UI создаёт primary track, для двух показывает две явные кнопки, для трёх и более — selector.

**Implemented Label-scoped CV (migration 040):** внутри одного Package каждая canonical Label хранит собственные `revision`, `cv_crop` и `cv_job`. Все CV-запросы выбранной ветки используют пару `track + label`; Swagger показывает оба параметра. Редактирование quad инвалидирует только crop и CV checkpoints этой Label. GET workspace восстанавливает сохранённый config/review после refresh, а frozen/manual graph JSON переносит состояние вместе с Label. `label-elements` и `label-palette` экспортируются как отдельные samples для каждой Label. **Partially implemented:** execution trace canonical CV живёт в `label.cv.job.workflow`; legacy `wizard_stage_executions` остаётся track-scoped и пока не дублирует эти записи.

**Implemented stage-local Summary navigator:** полный состав item больше не занимает sidebar на всех стадиях. Интерактивный граф показывается только на `Summary`: для каждого Package доступны переходы в Scope и Object Context, а внутри каждой Label/VisualRegion — в ROI, OCR и Mask-to-Palette checkpoints. Direct OCR node отсутствует.

**Implemented:** `Package -> Label -> Object Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`, package-scoped reviewed/skipped Object Context, exact reviewed-Label binding for OCR/CV analysis, detector-free crop analysis, Tesseract OCR, linked line/word overlays and source matches, debounced stage-specific crop-only CV preview, editable component/element review, editable palettes, separate per-Label `labelCvJob` state, immutable analysis reviews, checked-item batches and queue filters.

**Boundary:** `ANALYZE_LABEL` uses a server-owned V2 orchestrator and never runs label detection. Subsequent Mask/Morphology/Components/Elements/Contours/Palette previews call a lightweight crop endpoint and do not rerun OCR. Each preview declares its terminal stage and computes only that stage plus prerequisites. All stages persist revisioned executions in `meta.wizard_stage_executions`; migration `025` stores every distinct reactive `config -> candidates/output` pass in `meta.wizard_helper_runs`, while identical replays are deduplicated. Approval/Continue records the selected run/candidate, `accepted | corrected | manual` mode and final reviewed evidence. Palette is closed by its final `cv-job` save as well as by the compatibility checkpoint route. Existing checkpoint persistence in `visual_features.labelCvJob` remains the UI resume mechanism. Label-detector presets are never accepted here.

**Implemented OCR cascade v6:** OCR внутри reviewed ROI выполняется несколькими server-owned Tesseract-профилями. Сначала запускаются четыре дешёвых full/top/bottom прохода с normalized/contrast preprocessing и PSM 6/7/11. Если quality gate не находит достаточно сильного повторяемого evidence, добавляются deep/rescue профили с threshold/invert, CLAHE, local adaptive threshold и glare suppression. Дополнительные deskew/perspective passes создаются при уверенной геометрической оценке. Orientation-группа выполняется независимо от horizontal quality gate: PSM 5 ищет vertically aligned text с upright glyphs, ещё два прохода распознают crop, повёрнутый на ±90°. Их bbox возвращаются в исходную систему координат и участвуют в общем consensus. Это OCR preprocessing через Sharp/typed pixel transforms, а не OpenCV detector.

Результаты проходов не смешиваются с source-data hypotheses. В `meta.ocr_runs.evidence` (migration `017`) отдельно сохраняются raw observations, bbox, confidence, validity/rejection reasons и итоговый cross-pass text/spatial consensus. Совместимый `meta.ocr_regions` содержит consensus line/word regions; пользовательская правка остаётся отдельной revisioned ground truth. OCR step показывает diagnostics/evidence, Summary — компактные показатели consensus.

**Implemented semantic/source-aware stage:** consensus regions получают объяснимый тип (`vintage`, `barcode`, `alcohol`, `volume`, `classification`, `color`, `region`, `producer`, `product-name`, `free-text`). При высокой уверенности source matcher отбрасывает несовместимые поля текущей карточки до lexical matching и возвращает breakdown из lexical score, semantic confidence и field compatibility.

**Implemented OCR workspace cleanup:** OCR step использует один основной editable crop canvas. Каждый region хранится как convex `quad[4]`: новый region рисуется прямоугольником, затем перемещается целиком или корректируется перетаскиванием любого из четырёх углов; enclosing bbox вычисляется автоматически. Их текст редактируется inline в том же списке. Рабочая семантика сведена к `word` и `string`; legacy `line` читается как `string`, а дефисные compound tokens вроде `КАБЕРНЕ-СОВИНЬОН` автоматически стартуют как `string`. Каждый reviewed region хранит независимые `textDirection` (`right/left/down/up/mixed`) и `glyphOrientation` (`upright/clockwise/counterclockwise/upside-down/mixed`), отображаемые знаком «стрелка + ориентированная A» и исправляемые в editor. Клик по строке списка выбирает тот же region, что клик по quad на canvas. Warning-проверка отмечает как настоящую смесь Unicode scripts Cyrillic/Latin, так и Latin-only homoglyph tokens; текст автоматически не заменяется. Source fields представлены как full-value и token candidates. Для reviewed `word` с exact `score=1` token match связь автоматически предвыбирается как unsaved draft; ground truth фиксируется только через `Save associations`.

**Implemented canonical OCR semantics:** graph/API/UI отдельно редактируют состояние региона (`reviewed | rejected`), transcription (`verified | partial | unreadable`) и layout (`word | string`, direction, glyph orientation). `verified` означает надёжный полный GT; `partial` сохраняет читаемый фрагмент для review, но исключается из recognition GT; `unreadable` сохраняет text ROI и требует `text = null`. Transient «ещё не заполнено» не является persisted annotation-status. Parent relation и provenance не копируются в свойства OCR. Semantic Meta добавляется к конкретному OCR отдельными `{ tags, note?, source }` записями; mixed-script остаётся вычисляемым warning.

**Implemented deskew boundary:** угол оценивается голосованием baseline соседних connected components. Angle/confidence/applied сохраняются в evidence; bbox deskew-прохода обратно проецируются в координаты исходного crop до consensus.

**Implemented perspective boundary:** четыре границы оцениваются по directional edges, после чего проверяются line fit, coverage, area и distortion. Projective warp применяется только при уверенном непрямоугольном quadrilateral; bbox результата возвращаются в исходную систему координат через ту же homography.

**Implemented cross-item catalog narrowing and identity review:** semantic phrases/year/barcode сначала выбирают до 250 строк из объединённых `svoe_vino`/`roskachestvo` source schemas и Meta aliases/tokens. Затем идёт explainable ranking по OCR regions и полям карточек с token-aware сравнением полей, кластеризацией перекрывающихся line/word evidence, semantic discriminative weights и Cyrillic/Latin variants. Вложенные line/word боксы одной надписи не увеличивают score дважды; исправленные human-reviewed regions считаются доверенным текстовым evidence, а не OCR с отсутствующей confidence. UI показывает top-10 и отдельно сохраняет текущую карточку в списке для аудита без искусственного score boost. Annotator фиксирует `confirmed`, `corrected`, `no-match` или `ambiguous`; immutable revision хранит analysis job, optional reviewed OCR-region set, выбранную catalog identity и snapshot candidate evidence. После сохранения исправленных Reviewed OCR regions UI без повторного OCR запрашивает заново current-item source matches и cross-item catalog shortlist. Решения source association и catalog identity, привязанные к прежнему набору регионов, сохраняются в истории, но считаются stale и не входят в актуальные fixed links до нового review. Summary использует тот же пересчитанный shortlist.

**Partially implemented:** semantic typing пока rule-based, а не обученный classifier. Rescue реализует local adaptive threshold и тональное подавление бликов, но не reflection inpainting или curved-surface dewarping. Single-item catalog identity review и его включение в immutable dataset snapshot/export реализованы; schema v3 добавила reviewed visual layers и отдельно сохраняет CV proposals/config, schema v4 добавляет ordered `StageSampleV1` для всех стадий. Native execution capture подключён ко всем десяти стадиям; исторические записи, полностью ручной Label без proposal и ручные OCR-регионы без OCR run сохраняют явный migration gap. Batch entity resolution, trainer и клиентский recognition endpoint остаются planned.

`Save annotation and continue to Bottle Context` сохраняет ground-truth label и открывает Stage 2. После `Accept` или `Skip` открывается OCR; `Accept, save and next` доступна только для актуального completed label-analysis result. `no-label` и `invalid-image` обходят Bottle Context и analysis.

## Implemented Main Workflow

```text
1. Open item from Annotation Queue
2. Label: optionally run the source-level auto-label helper and select one ranked candidate as immutable `prediction`; alternatively draw a completely manual ROI with `prediction = null`. Canonical geometry is one convex four-point quad. Drawing starts as a rectangle, then any corner can be moved; invalid concave/self-intersecting edits are rejected locally
3. Save/Continue creates `annotation.geometry`; `annotation.roi` is its derived enclosing bbox for compatibility. `auto`, `corrected`, `manual`, IoU and ROI ground-truth readiness are derived from prediction vs annotation and are not UI selectors
4. Bottle Context: run compressed previews of `bottle-border-flood-v1`; tune Lab tolerance, 4/8 connectivity and contour simplification while comparing flooded-background, inverted-foreground, closed-foreground, rejected-component and raw/smoothed-contour overlays. Canny remains diagnostic/fallback only. Candidate contours are emitted directly in source-image coordinates. Accept persists exactly the inspected raw/smoothed contours and curated palette without a second flood-fill or palette extraction on another raster. Bézier is absent from this stage. Curate the separate Bottle Context palette
5. OCR: inspect linked boxes/list, hover either side, and edit the local human annotation copied from the immutable machine prediction. Choose only `Verified`, `Partial` or `Unreadable`; unreadable regions keep text geometry but save `annotation.text = null`. Delete is available from the canvas cross and list row, while `Ctrl+Z` restores the latest deletion. `Continue` saves the annotation revision and advances to Mask
6. Mask: tune threshold, foreground polarity and raster size; dark artwork is foreground by default, and the switch selects light artwork
7. Morphology: use Auto topology scoring or Manual open/close/dilate/erode; inspect the before/after diff where green pixels were added, red removed and white remained foreground
8. Components: choose a semantic noise-filtering preset and review connected-region candidates in vertically stacked Accepted/Rejected lists. The linked canvas/list cross moves a region to Rejected without destroying its geometry; `Restore`, batch Accept/Reject and `Ctrl+Z` change the same review decision. The explicit `Show rejected on canvas` control is shown in this stage; rejected overlays are hidden by default. Continue persists the decision delta, and only accepted components enter Elements
9. Elements: review OCR-first and proximity-fallback semantic objects through the linked hover-only canvas and hierarchical list. Atomic components keep their own geometry. Every reviewed component must belong to exactly one object; singleton objects are valid, while ungrouped components are explicitly incomplete and block Continue. Moving/Ungroup changes only membership. The object owns canonical `type = text | graphic | separator | unknown` and optional `role = brand | logo | year | signature | description | other`; there is no per-component semantics or separate Accept/Reject action
10. Contours: compare raw cyan boundaries with green simplified geometry and select Precise/Balanced/Simplified detail; point limit remains Advanced only
11. Palette: tune Label Palette color count/minimum ratio, remove colors or add a crop pixel with the eyedropper; color removal in both Label Palette and Bottle Palette supports LIFO `Ctrl+Z`
12. Summary: finalize `labelCvJob`, including review delta, reload the aggregate, inspect combined CV/OCR overlays and Bottle Context status/telemetry, recalculate reviewed source relationships
13. Save review and next
```

No-label and invalid-image bypass analysis and can save-and-next immediately.

Каждый CV-шаг имеет persisted checkpoint в `labelCvJob.workflow`. После refresh визард открывает первый отсутствующий или устаревший шаг; при этом stepper остаётся свободным и позволяет открыть любой этап. Stepper показывает `saved`, `modified`, `stale` и `missing`, сравнивая локальный draft с отдельным последним approved snapshot, а не с реактивным preview. OCR editor передаёт наружу состояние несохранённого region draft. Bottle Context сравнивает config, candidate, annotation и palette с последним действительно сохранённым `labelSourceAnalysis` snapshot (`savedAt`); preview/recalculate не считаются сохранением. Изменение Mask сразу помечает Morphology/Components/Elements/Contours как `stale`; аналогично пересчитываются зависимости последующих этапов. Palette считается независимой от бинарной маски. Summary сначала показывает список незакрытых этапов и требует исправить их либо явно выбрать `Continue anyway`, а статус `saved` получает только при актуальном immutable analysis review и неизменённых review notes. React preview не считается подтверждением: только успешный persist API является границей сохранения.

Расчёт зависимостей и статусов вынесен в чистый модуль `components/admin/labelWorkflowState.ts`. Его regression-сценарии запускаются командой `npm run test:workflow` и проверяют refresh hydration, локальную инвалидацию CV-цепочки, server-side stale/missing checkpoints, OCR/Bottle drafts и final Summary review.

Client workspace сохраняет persisted `labelCvJob.config/workflow` отдельно от реактивного preview. Открытие или возврат на CV stage только отображает уже загруженный workspace и само по себе не отправляет `POST cv-preview`; debounced preview запускается только после реального изменения config/review пользователем и обновляет только `previewStage/preview`. Начало checkpoint/final save инвалидирует незавершённые preview-запросы. Поэтому поздний ответ предыдущего stage не может вернуть Mask или другой CV config к старому значению после `Approve & continue`.

При загрузке item обязательный `GET .../label-annotation/analysis` возвращает весь workspace вместе с persisted `cvJob`. Ошибка этого GET не считается optional и не заменяется молча на default config: страница показывает ошибку загрузки вместо запуска визарда с вымышленным состоянием.

Stages 5-10 keep proposal and review distinct. `Mask` and `Morphology` are CV-derived preprocessing; Components are atomic geometric proposals; reviewed Elements are semantic objects formed from one or more component ids. Automatic grouping first covers components with the same reviewed OCR line (falling back to generated OCR when no region review exists), then clusters the remainder by proximity/alignment, including singleton proposals. OCR-backed objects retain `textRegionId`, text, confidence and grouping provenance. UI operations change only component membership. The stable base ontology is `text | graphic | separator | unknown`; optional role carries `brand | logo | year | signature | description | other`. Old detailed type values are compatibility input and normalize to this split. Every reviewed component belongs to exactly one semantic object; ungrouped means unfinished review. Contours are generated per component and linked by `elementId`, so a logical object may expose multiple disconnected polygons without inventing an enclosing polygon. `labelCvJob.review` stores component decisions and reviewed semantic objects alongside generated preview/config. Dataset schema v3 introduced reviewed objects and faithful member contours under `vision.annotations`, while proposals/config/raw evidence remain under `vision.cvMeta`; schema v4 additionally exports the corresponding stage execution adapters.

Detector proposals may still prefill a draft bbox, but they are optional. A user must be able to begin with a blank manual canvas without running OpenCV detection.

**Implemented source-helper boundary:** Auto Detect creates only ephemeral label candidates. Label является collection-stage текущего Package: при `Labels: 0` UI не создаёт пустую псевдосущность, а предлагает `Auto detect` или `Draw Label`. Один запуск `label-multi-family-consensus-v4` возвращает набор candidates; разметчик выбирает `0..N`, после чего `POST .../packages/:packageId/labels/review` сохраняет review каждого candidate (`accepted | edited | rejected | merged`) и одну operation с `resultEntityIds[]`. Пересечение с существующим Label проходит через dedupe/merge. Ручной quad создаёт ту же Label entity с manual provenance. После review все Label ROI остаются видимыми в общем viewer, active Label выбирается отдельно от overlay visibility и задаёт ветку OCR → Palette. Helper отдельно агрегирует семейства `EDGE`, `COLOR` и низковесный `TEXT`-envelope: несколько preset одной family повышают устойчивость её candidate, но дают только один независимый голос. Межсемейный matcher учитывает IoU и containment, а итоговый Top-K хранит explainable score, confidence и точных contributors. Вложенные text/logo/illustration boxes используются как evidence и не выдаются как самостоятельные Label ROI. `AutoLabelConfigV1` передаётся в run endpoint. Package-level Object Context запускает `bottle-border-flood-v1` внутри `Package.scope` без привязки к выбранной Label branch: multi-seed flood fill расширяет фон от padded border, инвертирует mask, закрывает малые разрывы, выбирает внешний foreground component, строит и упрощает contour. Canny остаётся diagnostic/fallback. Accept сохраняет именно просмотренные source-space contour и palette без второго вычисления на другом raster. Bézier на этой стадии отсутствует. Editable RGB/Lab Object Context palette не смешивается с Label Palette.

Selected Stage 1 candidates are persisted through the Label ROI schema-v2 contract, not as mutable canvas state. `prediction.helperRunId + candidateId` points to the exact helper run and candidate; `runs[runId].config` is the authoritative execution config, while `prediction.algorithm.params` retains the same config as a self-contained snapshot. The linked human revision stores only the final `annotation.roi/geometry`. Strong corrections retain the original prediction instead of converting it to manual, so detector error remains measurable. A fully manual ROI has no helper selection. The minimal UI intentionally has no operator-controlled `Reviewed`, `Auto`, `Edited`, `Manual` or `GT` fields.

The main workflow must not expose **label-detector** thresholds, detector presets, sweep or candidate scoring. Crop-mask morphology and connected-component filtering are exposed because they operate only inside the reviewed ROI and produce item-local metadata. CV Lab retains full-image detector/debug controls. OCR regions and their source/catalog relations are edited directly in the single main OCR workspace; only read-only cascade diagnostics remain collapsed.

## Implemented Data Flow

```text
load workspace
  -> draft bbox is local UI state
  -> PUT reviewed label annotation
  -> receive canonical annotation id/revision
  -> run bottle-border-flood-v1 preview inside Package scope
  -> tune/select candidate -> PUT verified or skipped Bottle Context state
  -> POST analysis/run with that identity
  -> poll existing job journal (queued/running/failed/completed)
  -> GET aggregate analysis workspace
  -> render crop + OCR/regions/matches/features/warnings
  -> optional Advanced corrections use existing revisioned review APIs
  -> PUT analysis/review for the current job/result
  -> navigate to queue nextHref
```

Staleness определяется не временем, а identity chain:

```text
source + sourceItemId
annotationId + annotationRevision
analysis jobId + analysisProfileVersion/config hashes
ocrRunId
review revision
```

Изменение reviewed ROI делает analysis и review stale. Повторный analysis делает stale предыдущий analysis review. Исправления OCR regions немедленно запускают server-side rematch по сохранённым строкам (без Tesseract/CV rerun) и делают stale связанные source associations и catalog identity по уже существующим revision links. Исторические immutable alias reviews также сохраняют старую provenance-связь, но их редактор больше не входит в wizard.

Основная кнопка `Save and next` доступна только когда текущий результат успешно завершён и review сохранён. Ошибка job остаётся на текущем item с Retry/Advanced; она не должна теряться через `.catch(() => null)`.

## Операции, Которые Становятся Лишними В Main Flow

- обязательный generated proposal перед ручной bbox;
- `Save bbox and run backend OCR` как отдельная пользовательская операция;
- отдельные `Run browser OCR` и `Run backend OCR` в обычном сценарии;
- client-only `buildSourceMatches` рядом с server matcher;
- отдельный ранний `Save OCR review and next` до итогового analysis review;
- `CvStageDebugger`, detector candidates и `PipelineControls` внутри Label Annotation;
- одновременный показ всех `OcrRegionEditor` / source association / alias editors для каждого нормального item.

Эти legacy UI-операции удалены из Label Annotation: browser OCR, standalone/backend source switch, aggregate textarea и Direct Package OCR больше не используются. OCR работает только в выбранной Label/VisualRegion-ветке. Сохранение reviewed OCR-region revision в одной DB-транзакции также создаёт агрегированную OCR-text revision из актуальных регионов, поэтому отдельный textarea/save не нужен. Detector debug полностью сохраняется в CV Lab.

## Главный Принцип

В системе есть две разные сущности:

```text
generated proposal != reviewed annotation
```

`generated proposal` - это предложение detector-а: OpenCV, CV Lab или будущая ML-модель нашли возможную область этикетки.

`reviewed annotation` - это проверенная человеком разметка. Только она считается ground truth и попадает в training dataset.

Detector может ошибаться. Его задача - ускорить ручную разметку, а не быть источником истины.

## Где Что Хранится

Detection proposals:

```text
meta.detection_proposals
```

Reviewed annotations:

```text
meta.image_annotations
```

Generated metadata:

```text
meta.items
```

Job history:

```text
meta.generation_jobs
```

## Текущий UI-Контракт

Основная ручная разметка происходит во вкладке:

```text
/admin/recognition/[source]/[sourceItemId]?section=annotation
```

В `Label Annotation` сейчас есть stepper `Package -> Label -> Object Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`. Viewer каждого шага можно временно перевести в fixed floating window, перемещать за отдельный заголовок поверх страницы и вернуть в layout через `Dock viewer`; события canvas при этом остаются внутри самого редактора. Source-image canvas используется на первых трёх шагах: Package задаёт технический crop, Label редактирует visual-region quad, Object Context показывает background flood, foreground masks и raw/smoothed external contour без Bézier-редактора. OCR и последующие CV-шаги работают только с сохранённым Label crop.

Branch-aware navigator встроен непосредственно в stepper. `1 Package` и `2 Label` являются split controls: основная часть открывает соответствующий stage, dropdown переключает существующую ветку или создаёт новую. Далее линейно идут package-level `3 Object Context`, Label-owned `4 OCR -> 10 Palette` и `11 Summary`. Переключение Label меняет весь downstream OCR/CV context, но не Object Context выбранного Package. Без выбранной Label OCR и raster stages недоступны; Package и Object Context остаются валидными. Primary legacy-managed Label использует существующие reviewed editors, дополнительные Labels — canonical quad/OCR workspaces. Полный graph/состав Package показывается только на Summary, где stage badges работают как навигация назад в нужную ветку.

- canvas;
- один редактируемый `Label bbox`;
- `Crop preview`;
- `Edit bbox`;
- `Mark no label`;
- `Invalid image`;
- `Save annotation`;
- `Save annotation and continue to Bottle Context`;
- Bottle `Run`, candidate select, overlay toggles, cloned contour edit, `Accept` / `Skip`;
- автоматический backend OCR и generated line/word boxes в Analysis;
- browser/direct OCR controls и переключение analysis/standalone отсутствуют; compatibility endpoints не удалены;
- OCR-region editor: draw/move/resize, merge/split/delete and revision save on `Continue`; the operator edits bbox/text and selects only `Verified`, `Partial` or `Unreadable`, while review/source/edited/GT fields are derived;
- OCR-to-source association editor with server suggestions, manual source-value selection and accept/reject review;
- alias review editor with generated candidates, accept/reject/edit and manual additions;
- revision save исправленных OCR regions с автоматическим server-side rematch;
- `Save and next`;
- queue navigation: `Previous`, `Next`, позиция в очереди.

В `/admin/recognition/annotations` сверху есть `Dataset readiness` summary:

- total items;
- with proposal;
- missing proposal;
- needs review;
- reviewed bbox;
- no label;
- invalid image;
- no annotation;
- ready for export percent;
- backend OCR / reviewed OCR / text export ready;
- needs OCR / needs OCR review.
- checked-row cohort creation and immutable dataset-version freeze controls.
- frozen dataset-version artifact export with manifest, JSONL, fixed splits and checksum.
- catalog identity readiness: reviewed/missing и отдельные `confirmed`, `corrected`, `no-match`, `ambiguous` counters; те же состояния доступны как server-side queue filters для осознанного набора cohort.

В `Label Annotation` не должно быть:

- preset;
- OpenCV preview;
- sweep;
- morphology/threshold sliders;
- candidates;
- confidence/score;
- JSON metadata;
- jobs;
- generated metadata viewer.

Эти вещи живут в других режимах:

- `CV Lab` - OpenCV/debug/tuning/proposal candidates;
- `Saved Metadata` - просмотр persisted generated metadata;
- `Jobs` - фоновые операции;
- `Text Metadata` - aliases/tokens.

## Annotation Queue

Открыть:

```text
/admin/recognition/annotations
```

Очередь поддерживает фильтры:

- `Needs review`;
- `Missing proposal`;
- `No annotation`;
- `Reviewed`;
- `No label`;
- `Invalid image`;
- `Needs OCR`;
- `Needs OCR review`;
- `Ready for text export`.

При клике на item очередь передает в карточку:

- `prev`;
- `next`;
- `pos`;
- `total`;
- `queue`.

Поэтому внутри карточки можно идти вперед/назад без возврата в список.

## Основной Flow Разметки

```text
1. Open /admin/recognition/annotations
2. Select queue filter, usually Needs review
3. Open item
4. Check or draw one label bbox
5. Check Crop preview: preview выполняет projective rectification текущего рабочего quad, а не показывает его enclosing bbox. Тот же quad после сохранения используется label-analysis и standalone backend OCR; созданный crop сохраняет `geometry` и передаёт её в OCR snapshot/StageSample.
6. Save the reviewed ROI and run label analysis
7. Review/correct OCR regions in the single canvas/list; `Continue` saves the region revision and advances to Mask
8. Inspect the automatic source/catalog rematch and save human decisions where needed
9. Tune crop-local CV stages only where needed
10. Review Summary, save and next
11. Repeat
12. Export reviewed dataset
```

Label-only export не требует reviewed OCR. Метрика `Text export ready` требует и reviewed bbox, и reviewed OCR text.

Если этикетки нет:

```text
Mark no label -> Save and next
```

Если изображение непригодно:

```text
Invalid image -> Save and next
```

## Как Работает Label Bbox

Если у item есть generated proposal, он используется как стартовый bbox.

Разметчик может:

- оставить bbox как есть и сохранить;
- нажать `Edit bbox` и перерисовать bbox;
- отметить `No label`;
- отметить `Invalid image`.

После сохранения reviewed annotation становится ground truth.

## Hotkeys

В `Label Annotation`:

```text
E      Edit bbox
N      Mark no label
Enter  Save and next
```

Hotkeys не работают, если фокус находится в input/textarea/select.

## Detector Proposal Jobs

Proposals можно генерировать из:

- `/admin/recognition` group action `Generate proposal`;
- `/admin/recognition/jobs` job type `Detection proposals`;
- `CV Lab` кнопкой `Use top candidate as proposal`.

Job type:

```text
GENERATE_DETECTION_PROPOSAL
```

Этот job пишет proposal в:

```text
meta.detection_proposals
```

Он не создает reviewed annotation.

## CV Lab

CV Lab открывается так:

```text
/admin/recognition/[source]/[sourceItemId]?section=cv-lab
```

CV Lab нужен для:

- preview;
- sweep;
- debug overlays;
- tuning pipeline config;
- сохранения preview candidate как proposal.

CV Lab не является экраном ручной ground-truth разметки.

## Saved Metadata

Saved Metadata открывается так:

```text
/admin/recognition/[source]/[sourceItemId]?section=metadata
```

Там можно смотреть persisted generated metadata.

Важно:

```text
visualFeatures.cvMeta.label.roi != ground truth
```

Это generated output, а не reviewed annotation.

## Jobs

Jobs открывается так:

```text
/admin/recognition/[source]/[sourceItemId]?section=jobs
```

Jobs показывает историю фоновых операций по item.

Completed job означает, что worker завершил задачу. Это не значит, что proposal стал reviewed annotation.

## Dataset Export

Перед экспортом должны быть reviewed annotations.

Готовность к экспорту смотреть в:

```text
/admin/recognition/annotations
```

Метрика `Ready for export` считает reviewed bbox, которые попадут в dataset export.

Команда:

```powershell
cd .\recognize-service
cmd /c npm run export:label-dataset -- --name label-detector-v1
```

### Current annotation dataset export

```powershell
cd .\recognize-service
cmd /c npm run export:annotation-dataset -- --name annotation-dataset-v1 --source all
```

Команда экспортирует:

```text
reviewed label ROI from meta.image_annotations
latest OCR text annotation from meta.ocr_text_annotations when available, with its status
generated OCR word boxes from meta.ocr_regions when available
latest reviewed OCR region set from meta.ocr_region_annotation_sets/meta.ocr_region_annotations when available
latest reviewed OCR-to-source association set for that same OCR-region revision when available
latest reviewed alias set for that same source-association revision when available
```

Ground truth:

```text
reviewed label ROI
OCR text только когда exported `ocr.review.status = reviewed`
```

Generated OCR word boxes are exported as an auxiliary layer, not as reviewed region ground truth. Only regions from the latest set with set/region status `reviewed` are exported under `ocr.regionsReview` as region ground truth.

Результат:

```text
exports/
  annotation-dataset-v1/
    manifest.json
    annotations.jsonl
    splits.json
```

Label ROI ground truth берется только из:

```text
meta.image_annotations
annotation_type = label-bbox
status = reviewed
```

Detection proposals не экспортируются как ground truth.

Экспорт прикладывает последнюю revision `meta.ocr_text_annotations` вместе со status. Текущий SQL не фильтрует `status = reviewed`, поэтому `empty`/`rejected` также могут попасть в `ocr.review`; считать OCR ground truth можно только запись со status `reviewed`. Последний `meta.ocr_runs` и его `meta.ocr_regions` прикладываются как generated auxiliary layer.

## После Обновления Дампа

Применить миграции:

```powershell
cd .\recognize-service
cmd /c npm run migrate
```

Перенести legacy cvMeta/annotations в новые таблицы:

```powershell
cd .\recognize-service
cmd /c npm run backfill:annotations
```

Экспортировать dataset:

```powershell
cd .\recognize-service
cmd /c npm run export:annotation-dataset -- --name annotation-dataset-v1 --source all
```

## Что Нельзя Считать Ground Truth

Не использовать для обучения как истину:

- `visualFeatures.cvMeta.label.roi`;
- `meta.detection_proposals`;
- CV Lab preview result;
- sweep variants;
- raw generated metadata.

Ground truth:

```text
meta.image_annotations.status = reviewed
meta.ocr_text_annotations.status = reviewed (consumer-side requirement in the current export)
meta.ocr_region_annotation_sets.status = reviewed
meta.ocr_region_annotations.status = reviewed
meta.ocr_source_association_sets.status = reviewed
meta.ocr_source_associations.status = reviewed
meta.alias_annotation_sets.status = reviewed
meta.alias_annotations.status = reviewed
```

## Частично Реализовано

- Frozen dataset export теперь регистрируется в `meta.dataset_artifacts`; экран Training позволяет вручную вести внешний training run, метрики и model artifact lifecycle. Сам trainer, вычисление метрик и применение модели к items не реализованы.

- Source candidates вычисляются на сервере для reviewed OCR regions по полям текущего item, aliases и normalized tokens. Reviewer может выбрать другое текущее source value, принять/отклонить связь и сохранить immutable revision; batch/preset matching пока отсутствует.
- `Reviewed aliases` editor удалён из Label Annotation: generated candidates были автоматически предвыбраны и создавали неясный обязательный шаг. Alias review API/tables/export остаются compatibility contracts; рабочие `meta.items.aliases` и normalized tokens редактируются во вкладке `Metadata`.
- Browser OCR больше не вызывается из Label Annotation. Backend cascade сохраняется как часть `ANALYZE_LABEL`; direct endpoint остаётся API compatibility path без wizard controls.
- Label save и OCR review save — разные операции. `Mark reviewed` на Review step сохраняет bbox, но не OCR text.
- OCR является частью item-level `ANALYZE_LABEL` job; direct endpoint сохранён только для API compatibility и не представлен в annotation UI. Отдельный standalone batch OCR job пока отсутствует.
- Export/readiness SQL считает наличие любой последней OCR text annotation и пока не отфильтровывает `empty`/`rejected`; это известное несоответствие имени `Reviewed OCR` фактическому запросу.

## Короткое Правило

```text
Label Annotation = ручная ground-truth разметка.
CV Lab = debug/tuning/proposal candidates.
Saved Metadata = persisted generated metadata.
Jobs = queued execution history.
Dataset ground truth = reviewed label/OCR annotations only.
```

## Identity review и parent review OCR

При ручном создании и при Auto OCR сначала сохраняется observation/candidate и выполняется один domain-level dedupe matcher. Возможный дубль требует явного решения `Merge` или `Keep separate`; до решения отдельная canonical OCR entity не создаётся. Summary/graph validation показывает оставшиеся identity conflicts как обязательные проблемы перед canonical export.

Parent проверяется отдельно:

```text
merge       = тот же физический OCR
edit_ocr    = изменено содержимое OCR
reparent_ocr = уточнена связь Package/Label
```

Перед созданием новой Label UI сравнивает её ROI с существующими VisualRegion того же Package. При покрытии не менее 75% меньшей области показывается только предупреждение `Possible overlapping Label`: разметчик может создать регион всё равно либо открыть существующий. Auto-merge Label не выполняется. OCR identity по-прежнему дедуплицируется независимо, а `reparent_ocr` перемещает canonical OCR только между Labels одного Package.
# Label-level rectification

Статус: **implemented для manual review и CV helper; расширенные mesh/conical модели planned**.

После задания source-space `Label ROI` разметчик может отдельно задать способ нормализации поверхности:

- `None` — дополнительная коррекция поверхности не сохраняется; старые записи остаются совместимыми с базовым quad crop;
- `Perspective` — явно фиксируется базовая quad/homography-нормализация;
- `Cylindrical unwrap` — сохраняются редактируемые направляющие и воспроизводимый `guided-grid-v1` transform.

`label.geometry` при этом не меняется. Направляющие хранятся в `label-perspective-normalized`, а не в пикселях preview. `label-rectification / cv-label-rectification-v1` формирует независимые `Original`, `Perspective` и, только при достаточном сигнале кривизны, `Cylindrical` candidates. Downstream label-analysis, standalone OCR и parent-scoped Auto OCR строят crop из исходного изображения, quad и reviewed rectification. Preview bitmap не является ground truth.

Реализовано в первой фазе:

- выбор режима в Label stage;
- редактирование center/left/right/horizontal guide points на основном viewer;
- добавление и удаление горизонтальных направляющих;
- live crop preview;
- сохранение rectification в immutable Label review, canonical annotation graph и exports;
- серверный `guided-grid-v1` warp перед OCR/CV-анализом.
- bounded AutoDetect helper с диагностикой confidence/retained area/displacement/distortion и evidence rows для cylindrical candidate;
- LLM OCR-stage сначала получает отдельный normalization observation и превью candidates; выбранная нормализация сохраняется через canonical Label `edit_region`, после чего тем же orchestrator запускается собственно Auto OCR.

Запланировано:

- свободная mesh/conical rectification для форм, которые не описываются цилиндрической моделью.
