# Item Card UI Tabs

Status: current UI contract; implementation is uncommitted WIP
Scope: item card UI composition and tab responsibilities
Last verified against code: 2026-08-29

## Canonical graph UI boundary

**Implemented (graph v9):** selector represents canonical `Package` entities. Package owns crop/type/Object Context/Meta; every useful local marking is a nested `Label` (domain `VisualRegion`). The former Direct OCR card/action is removed, and OCR is available only for a selected Label. `visualRegionKind` remains part of the persisted graph contract, but its ontology selector is no longer shown as a mandatory top-level wizard control. Add Label performs a non-blocking overlap preflight with `Create anyway` / `Edit existing` choices.

**Implemented:** отдельный постоянно раскрытый entity constructor удалён из рабочего layout. В едином компактном stage/context bar находятся `1 Package` и `2 Label`: первый переключает/создаёт рабочий crop scope, второй переключает существующую Label или содержит единственный пункт `+ Add Label`. Дополнительные Label quad поддерживают draw/move/corner reshape, edit и logical delete. До фактического выбора/создания Label UI показывает `No Label selected`, не создавая ложную `Label #1`; зависимые стадии получают статус `blocked`, а не `N/A`. Package type и Package Meta показываются только на Package stage, Label Meta — только при выбранной Label.

**Implemented:** единый OCR quad editor работает в выбранной Label/VisualRegion. Helper создаёт её projectively rectified review crop, geometry хранится normalized в Label-space. Ручные OCR entities можно draw/move/corner-reshape/edit/delete; перенос возможен между Labels одного Package. Package-level OCR mode отсутствует.

**Implemented Label-scoped Auto OCR:** кнопка `Auto OCR` запускает helper в выбранной Label/VisualRegion. Один run сохраняет config и candidates; parent фиксирован текущей Label. Dedupe matcher при этом сравнивает geometry и normalized text со всеми OCR того же Package независимо от Label. Для возможного дубля UI требует `Merge`, `Keep separate`, `Changed` или `Reject`. Merge связывает candidate с существующим OCR id без создания дубля. Draft review и rectified Label viewer восстанавливаются после refresh.

Документ описывает вкладки внутри канонической карточки item:

```text
/admin/recognition/[source]/[sourceItemId]
```

Для рабочего режима разметки canonical URL дополняется стабильным track UUID:

```text
/admin/recognition/[source]/[sourceItemId]?section=annotation&track=[annotationTrackId]
```

Один item может иметь несколько полностью независимых Package/editor tracks. Компактный Package dropdown показывает текущий track и содержит `+ Add Package`; новый Package получает полный независимый wizard без копирования reviewed state существующего Package. Source asset при этом может быть общим.

## Общая Идея

Item UI разделен на два режима:

- основной рабочий режим разметки;
- developer tools.

Главный рабочий режим:

```text
Label Annotation
```

Developer tools:

```text
CV Lab
Saved Metadata
Text Metadata
Jobs
```

Дополнительный просмотр исходных данных:

```text
Catalog
```

## Header Карточки

Header показывает:

- source;
- sourceItemId;
- title;
- вкладки.

Текущие вкладки:

- `Label Annotation`;
- `Catalog`;
- `CV Lab`;
- `Saved Metadata`;
- `Text Metadata`;
- `Jobs`.

UI показывает вкладки и загружает detail только при наличии admin token в browser storage. Серверная граница слабее: BFF проверяет только наличие `Bearer` header и не валидирует JWT signature/expiry.

## Label Annotation

Целевое назначение:

```text
Ручная разметка label bbox и последовательная проверка автоматически полученного анализа.
```

Источник данных:

- generated proposal из `meta.detection_proposals`;
- fallback generated ROI из `visualFeatures.cvMeta.label.roi`;
- reviewed annotation из `meta.image_annotations`;
- compatibility cache из `meta.items.annotations.labelAnnotation`.

Фактическое содержимое сейчас:

- canvas;
- один редактируемый `Label ROI` в canonical convex `quad[4]`; bbox вычисляется автоматически;
- `Crop preview`;
- компактный `Auto label helper`: low-res config sliders с debounce, overlays `Neutral bands / Canny evidence / Envelope / Candidates`, ranked candidates и `Reset defaults`; выбор candidate переносит его в full-res quad editor, а сохранение фиксирует run/config/candidate вместе с reviewed geometry;
- stepper `Label -> Bottle Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`;
- на Label существующий quad перемещается за внутреннюю область, а любой из четырёх углов перетаскивается независимо; concave/self-intersecting варианты не принимаются;
- отдельный Stage 2 `Bottle Context` после сохранения Label: `bottle-border-flood-v1` берёт multi-seed выборку со всех краёв дополненного neutral padding изображения, расширяет background region по визуальной близости в Lab, инвертирует её в foreground mask, закрывает небольшие разрывы и выбирает крупнейший связный компонент, содержащий reviewed label; preview работает на уменьшенном raster, но возвращает raw/simplified contour уже в source-image coordinates; Accept сохраняет ровно просмотренные contours и отредактированную palette без повторного анализа на другой raster; Canny оставлен только диагностическим fallback, Bézier на этой стадии не строится;
- detector-free `ANALYZE_LABEL` внутри сохранённого reviewed ROI;
- OCR text и generated line/word overlays;
- OCR cascade diagnostics: cheap/deep/rescue stop result, per-pass preprocessing/confidence/runtime, deskew и quadrilateral perspective confidence/application, valid/rejected raw observations, cross-pass consensus и semantic type/confidence (данные из `meta.ocr_runs.evidence`);
- один OCR region workspace вместо отдельного viewer/editor: canonical quad draw/move/corner editing на главном rectified crop canvas, derived bbox, inline text editing в связанном списке, hover-синхронизация с source/catalog matches и warning-подсветка токенов со смесью Cyrillic/Latin; viewer любого wizard stage можно вынести в перемещаемое fixed-окно и вернуть в исходный layout;
- source DB candidates включают full field values и отдельные field tokens; quick choices показывают тип (`title token`, `manufacturer token` и т.д.) и score;
- explainable cross-item catalog shortlist по обеим source DB: итоговый score, matched regions, lexical/semantic breakdown и позиция текущей карточки; `Confirm current item`, `Select as correction`, `No catalog match` и `Ambiguous` сохраняют immutable catalog-identity revision; Summary пересчитывает список по reviewed OCR regions и показывает human decision;
- двусторонняя hover-связь OCR box/list и вероятность source-data match для каждого OCR region;
- отдельные crop-only stages для mask, morphology, connected components, reviewed elements, contours и palette;
- Morphology Auto/Manual с before/after diff; Components с единым canvas/list selection, delete-крестами и `Ctrl+Z`; Elements с основными Element+OCR overlays, опциональными Components/Raw mask, OCR-first auto grouping, Merge/Ungroup, optional type и Accept/Reject; Contours с semantic shape-detail presets и raw/simplified overlays;
- bounded `CVJOB config` sliders с debounced preview без повторного OCR; Continue подтверждает и сохраняет checkpoint каждого CV-этапа в item Meta, refresh возобновляет первый missing/stale этап, а stepper явно показывает `saved/modified/stale/missing` также для локального OCR draft и Bottle Context относительно последнего persisted `savedAt`; Summary требует устранить проблемы либо явно подтвердить обход предупреждения и считается сохранённым только после актуального final analysis review;
- detected palette с удалением цветов и добавлением пипеткой;
- server-recalculated Summary по latest reviewed OCR regions/source associations и сохранённому `labelCvJob`;
- один OCR workspace из текущего `ANALYZE_LABEL`: revisioned OCR-region/source/catalog editors и отдельные collapsed read-only cascade diagnostics;
- annotation status;
- queue navigation;
- action buttons.

Старый отдельный `LabelAnalysisWorkspace` больше не рендерится. `CvStageDebugger`, detector masks/candidates, presets и OpenCV parameters остаются в CV Lab.

Действия:

- `Edit bbox`;
- `Mark no label`;
- `Invalid image`;
- `Save annotation`;
- `Save annotation and continue to Bottle Context`;
- Bottle Context `Run`, candidate selection, overlay toggles, cloned contour edit, `Accept` / `Skip`;
- `Run browser OCR` / `Run backend OCR` и переключатель analysis/standalone (удалены из wizard; direct API сохранён для compatibility);
- `Save OCR review` / `Save OCR review and next`;
- `Save and next`;
- `Previous`;
- `Next`.

Hotkeys:

```text
E      Edit bbox
N      Mark no label
Enter  Save and next
```

Чего здесь не должно быть в целевом основном flow:

- preset;
- OpenCV preview;
- sweep;
- morphology/threshold sliders;
- candidates;
- confidence/score;
- JSON metadata;
- jobs;
- generated metadata viewer.

Detector/debug controls логически отделены и доступны в CV Lab. OCR-region/source/catalog editors находятся в основном OCR step, поскольку это ручная разметка; advanced-секция содержит только read-only cascade diagnostics. `Reviewed aliases` из wizard удалён: operational aliases/tokens редактируются в `Metadata`, а immutable alias-review API остаётся compatibility layer до отдельного curation workflow.

Граница:

```text
generated proposal != reviewed annotation
```

Ground truth появляется только после сохранения reviewed annotation.

Label bbox и reviewed OCR text сохраняются раздельно. `Mark reviewed` на Review step сохраняет label annotation, но не заменяет явное `Save OCR review`.

## Catalog

Назначение:

```text
Показать исходную каталожную информацию item.
```

Содержимое:

- producer;
- region;
- category;
- year;
- barcode;
- source updated date;
- description;
- source image preview.

Здесь не должно быть CV controls, jobs или ручной разметки.

## CV Lab

Назначение:

```text
Developer workspace для OpenCV/debug/tuning на текущем изображении.
```

URL:

```text
?section=cv-lab
```

Содержимое:

- preset selector;
- draft pipeline config controls;
- `Run preview`;
- sweep controls;
- canvas playground;
- overlays/debug stages;
- candidate inspection;
- preview result panel;
- `Use top candidate as proposal`;
- `Save as preset`.

Что не делает:

- не создает reviewed annotation;
- не является рабочим экраном разметчика;
- не сохраняет `visualFeatures` через preview/sweep.

## Saved Metadata

Назначение:

```text
Просмотр persisted generated metadata.
```

URL:

```text
?section=metadata
```

Содержимое:

- saved CV image workspace;
- saved image metadata viewer;
- saved source text metadata;
- metadata status panel;
- raw metadata JSON;
- запуск persisted regeneration с preset.

Граница:

```text
visualFeatures.cvMeta.label.roi != ground truth
```

Это generated metadata, а не human-reviewed annotation.

## Text Metadata

Назначение:

```text
Работа с source-derived aliases и normalized tokens.
```

Содержимое:

- editable aliases;
- editable normalized tokens;
- saved aliases;
- saved normalized tokens;
- metadata status panel.

Действия:

- `Generate text`;
- `Save text metadata`.

Здесь нет CV controls и ручной image annotation.

## Jobs

Назначение:

```text
История фоновых операций по item.
```

URL:

```text
?section=jobs
```

Job types:

- `GENERATE_ALIASES`;
- `GENERATE_CV_META`;
- `GENERATE_DETECTION_PROPOSAL`;
- `GENERATE_ALL_META`;
- `REGENERATE_ALL_META`.

Completed job не означает reviewed annotation.

## Annotation Queue

Очередь:

```text
/admin/recognition/annotations
```

Верхний блок `Dataset readiness` показывает:

- total items;
- with proposal;
- missing proposal;
- needs review;
- reviewed bbox;
- no label;
- invalid image;
- no annotation;
- ready for export;
- backend OCR;
- reviewed OCR;
- text export ready;
- needs OCR;
- needs OCR review.

Фильтры:

- `Needs review`;
- `Missing proposal`;
- `No annotation`;
- `Reviewed`;
- `No label`;
- `Invalid image`;
- `Needs OCR`;
- `Needs OCR review`;
- `Ready for text export`.

При открытии item из очереди карточка получает:

- `prev`;
- `next`;
- `pos`;
- `total`;
- `queue`.

Поэтому во вкладке `Label Annotation` показываются `Previous`, `Next` и позиция в очереди.

## Рекомендуемые Пути

Ручная разметка:

```text
Annotation Queue -> Label -> Bottle Context (Accept/Skip) -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary / Save and next

В Recognition Inventory реализована очистка operational Meta: `Del` для одной строки и `Del meta` для отмеченных строк. Удаляются item-local annotations/OCR/analysis/proposals/jobs; source-data, media, presets и immutable dataset/cohort snapshots не удаляются. Активный queued/running job блокирует всю массовую операцию.
```

Annotation Queue также фильтрует items по catalog identity: `missing` только среди уже проанализированных reviewed-label items, а также `confirmed`, `corrected`, `no-match` и `ambiguous`. Dataset readiness показывает покрытие identity относительно числа items с label analysis.

Detector tuning:

```text
CV Lab -> preview/sweep -> Use top candidate as proposal -> Label Annotation
```

Проверка результата:

```text
Saved Metadata -> Jobs
```

## Короткое Правило

```text
Label Annotation = ручная ground truth разметка.
Catalog = исходные данные.
CV Lab = debug/tuning/proposal candidates.
Saved Metadata = persisted generated metadata.
Text Metadata = aliases/tokens.
Jobs = queued execution history.
```

## Partially Implemented

- Shared immutable `label-roi` preset registry реализован; утверждение про `localStorage` superseded.
- V2 `ANALYZE_LABEL` автоматически создаёт backend Tesseract cascade run, semantic consensus line/word regions и source-aware match candidates с lexical/semantic score breakdown; raw per-pass observations/validity/consensus сохраняются отдельно как evidence, а ручные OCR/source/alias corrections по-прежнему используют отдельные revisioned API.
- Direct backend OCR сохранён только как API compatibility path; browser/direct OCR controls и standalone source удалены из Label Annotation UI.

## Target Component Tree

```text
AdminRecognitionDetailPage (route shell)
└─ LabelAnnotationWorkspace (workflow controller)
   ├─ AnnotationStepper: Label | OCR | Mask | Morphology | Components | Contours | Palette | Summary
   ├─ LabelStep
   │  ├─ ManualLabelCanvas -> existing ImageWorkspace
   │  ├─ existing CropPreview
   │  └─ Save / No label / Invalid image
   ├─ OcrStep -> crop overlay + linked region/source-match list + review editors
   ├─ Mask/Morphology/Components/Elements/Contours -> preprocessing, proposal review, semantic grouping and shape preview
   ├─ PaletteStep -> detected colors + remove/eyedropper + palette-only sliders
   ├─ Summary -> shared viewer with switchable CV/OCR overlays
   ├─ SummaryStep
   │  ├─ AnalysisWarnings
   │  ├─ FinalResultSummary
   │  └─ SaveAndNext
   └─ AdvancedProblemTools (collapsed/separate)
      ├─ existing OcrRegionEditor
      ├─ existing SourceAssociationEditor
      ├─ existing AliasReviewEditor (если нужен текущему dataset flow)
      └─ link to CV Lab; no inline detector controls

CVLabWorkspace
├─ PresetInlineSelector
├─ PipelineExecutionPanel
├─ PipelineControls
├─ ParameterSweepGallery
├─ PreviewResultPanel
├─ CvStageDebugger
└─ existing AdminRecognitionEditor

SavedMetadataWorkspace
├─ PresetRunPanel
├─ SavedCvImageWorkspace
├─ AdminCvMetaViewer
├─ MetadataStatusPanel
└─ RawMetadataDetails
```

`AdminRecognitionDetailPage.tsx` сейчас содержит почти всё дерево и orchestration. Целевой refactor должен извлекать контейнеры по вкладкам и workflow-step components, не менять route и не переписывать `ImageWorkspace`.
