# CV Pipeline Tuning Guide

Status: current tuning guide; implemented and planned steps are separated
Scope: detector tuning and sweep strategy, not annotator workflow
Last verified against code: 2026-08-08

Документ описывает developer workflow для подбора параметров label ROI detector.

Сейчас реализованы item preview, independent sweeps, shared immutable `label-roi` preset revisions, proposal jobs и human review. Detector-free V2 label analysis использует отдельный server-owned profile и не принимает detector presets. Отдельный sample-validation run и automatic quality gate пока planned.

Это не инструкция для разметчика. Для ручной разметки использовать:

```text
label_annotation_workflow_ru.md
```

## Цель

Цель tuning-процесса:

```text
найти reusable pipeline config, который дает хорошие proposals
```

Не цель:

- вручную размечать датасэт внутри CV Lab;
- превращать preview result в ground truth;
- подбирать параметры на всем каталоге без sample validation.
- настраивать обязательный этап обычной ручной разметки;
- запускать label detector внутри уже подтверждённого reviewed ROI.

## Основной Flow

```text
1. Выбрать representative sample items
2. Открыть item -> CV Lab
3. Выбрать preset или draft config
4. Run preview
5. Проверить overlay/debug stages/candidates
6. Run sweep по одному параметру или группе параметров
7. Применить удачный variant в draft
8. Повторить preview
9. Save as preset
10. Проверить preset на других sample items
11. Запустить proposal jobs
12. Проверить proposals через Label Annotation
```

## Preview

Preview - direct HTTP operation.

Preview не пишет:

- `meta.generation_jobs`;
- `meta.items`;
- `meta.image_annotations`.

Preview нужен для быстрой визуальной проверки.

## Sweep

Sweep нужен для сравнения параметров.

Каждый sweep должен иметь baseline config snapshot.

Результаты sweep не являются persisted metadata и не являются reviewed annotation.

## Preset

Preset хранит reusable pipeline parameters:

- thresholds;
- morphology;
- candidate filters;
- scoring parameters.

Preset не должен хранить абсолютную ручную bbox-разметку конкретного изображения.

Preset хранится в shared server registry. `Save as preset` создаёт новый logical draft, `Save revision` добавляет immutable revision с `baseRevision` conflict detection. Item job передаёт preset id/revision, а Recognize Service загружает и сохраняет trusted config hash/snapshot.

## Proposal

Хороший CV Lab candidate можно сохранить как proposal:

```text
Use top candidate as proposal
```

Он попадет в:

```text
meta.detection_proposals
```

Proposal ускоряет разметку, но не является ground truth.

## Validation

После tuning нужно проверять качество через human review:

```text
Annotation Queue -> Label Annotation
```

Только сохраненная reviewed annotation попадает в dataset export.

## Production Jobs

Для массового запуска использовать:

```text
/admin/recognition
/admin/recognition/jobs
```

Job type:

```text
GENERATE_DETECTION_PROPOSAL
```

Jobs отслеживаются в:

```text
meta.generation_jobs
```

## Правило

```text
CV Lab tunes detector behavior.
Jobs generate proposals.
Label Annotation creates ground truth.
Dataset export uses reviewed annotations only.
```

Дополнение для целевого workflow:

```text
OpenCV detector is optional for annotation.
Label analysis starts from reviewed ROI and skips label detection.
Detector tuning remains in CV Lab.
OCR/feature troubleshooting may reuse low-level image controls only as Advanced diagnostics.
Per-item Mask/Morphology/Components/Contours/Palette stages use a separate bounded crop-only config and lightweight debounced stage preview. This config is persisted as `visual_features.labelCvJob`; it is not a detector preset and is not promoted globally.
```
