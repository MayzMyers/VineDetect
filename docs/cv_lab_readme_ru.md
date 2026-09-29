# CV Lab

Status: current developer document; shared preset lifecycle partially implemented
Scope: CV Lab preview/sweep/tuning workspace, not annotator workflow
Last verified against code: 2026-08-08

CV Lab - это developer workspace внутри карточки item для настройки image detection на одном source image.

Канонический URL:

```text
/admin/recognition/[source]/[sourceItemId]?section=cv-lab
```

## Назначение

CV Lab отвечает на вопрос:

```text
Как текущий draft pipeline config работает на этом изображении?
```

Это место для исследования, preview, sweep и подбора параметров. Это не основной интерфейс ручной разметки.

## Что Здесь Есть

- preset selection;
- draft pipeline config;
- direct HTTP preview;
- sweep;
- canvas playground;
- generated overlays;
- debug stages;
- candidate inspection;
- `Use top candidate as proposal`;
- `Save as preset`;
- `Save revision`.

`label-roi` presets сохраняются в shared server registry. `Save as preset` создаёт новый logical draft preset, а `Save revision` добавляет immutable revision с optimistic `baseRevision` conflict detection. Job передаёт preset id/revision; Recognize Service сам загружает точную revision и сохраняет server-owned config hash/snapshot в options.

Для multi-item запуска Recognition Inventory умеет оценить и создать один frozen batch со scope `selection`, `source` или `global`. CV Lab остаётся item-level workspace для настройки и preview.

## Чего Здесь Нет

- ручного сохранения reviewed ground truth;
- annotation queue;
- `Save and next`;
- dataset export;
- job history как основной рабочий контекст.

Это находится в:

- `Label Annotation`;
- `Jobs`;
- `Saved Metadata`.

## Граница С Label Analysis

CV Lab сохраняет ответственность за:

- label detector preview и proposals;
- masks/components/candidates/debug stages;
- detector presets и revisions;
- threshold/morphology/scoring controls;
- sweep и сравнение variants.

Реализованный V2 `label-analysis` не является вторым detector CV Lab. Он получает уже сохранённый reviewed ROI и автоматически извлекает OCR/text regions/source matches/palette/visual features. Annotation workflow имеет отдельные Mask/Morphology/Components/Contours/Palette stages с bounded crop-only controls и debounced preview; эти параметры не запускают detector, candidate scoring, sweep или presets. Вычисления реализованы через Sharp и typed pixel operations, а не Python OpenCV. Состояние хранится как item-local `visual_features.labelCvJob`.

Detector `PipelineControls`, candidates, presets и sweep сохранены в CV Lab. В annotation переиспользуются только crop/mask/contour visualizers, необходимые для проверки результата внутри ground-truth ROI.

## Preview

`Run preview` - прямой HTTP-запрос.

Он не:

- создает job;
- пишет в `meta.generation_jobs`;
- обновляет `meta.items`;
- создает reviewed annotation.

Preview живет только в состоянии текущей страницы.

## Sweep

Sweep сравнивает варианты параметров относительно текущего draft config.

Sweep:

- выполняет direct HTTP runs;
- показывает варианты и metrics;
- не создает jobs;
- не сохраняет metadata;
- не создает reviewed annotation.

## Proposal Из CV Lab

Если preview candidate выглядит полезно, его можно сохранить как proposal:

```text
Use top candidate as proposal
```

Это пишет в:

```text
meta.detection_proposals
```

Но это все еще не ground truth.

Ground truth создается только во вкладке:

```text
Label Annotation
```

## Правило

```text
CV Lab = debug/tuning/proposal candidates.
Label Annotation = reviewed ground truth.
Saved Metadata = persisted generated metadata.
Jobs = queued execution history.
```
