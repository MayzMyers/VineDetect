# Архитектура VineDetect Core

## 1. Назначение

**VineDetect Core** — сервис распознавания позиции вина по пользовательской фотографии.

На вход система получает изображение бутылки или этикетки, определяет целевой объект в кадре, формирует набор кандидатов из каталога, сравнивает кандидатов по визуальным, текстовым и геометрическим признакам и возвращает **один официальный `slug` позиции каталога**.

Архитектура построена по принципу:

```text
Target selection
→ multimodal retrieval
→ candidate verification
→ SEM reranking
→ official catalog slug
```

Зафиксированная логика распознавания — **SEM-ORG-FINAL-v3**. Для исполнения используется runtime **SEM-ORG-FINAL-v3-C4**, который сохраняет ту же логику распознавания и параллелит геометрическую проверку кандидатов.

---

## 2. Границы системы

Система разделена на четыре логических контура.

### 2.1. Offline reference preparation

Подготовка каталога и производных данных до запуска inference:

- каталог и отображение `catalog_id → slug`;
- активные reference images;
- visual embedding galleries;
- reference OCR/text;
- SIFT/RootSIFT descriptors;
- служебные metadata и bindings.

### 2.2. Online recognition

Обработка одного нового пользовательского изображения:

```text
Image
→ decode / EXIF
→ target bottle
→ label
→ retrieval
→ candidate pool
→ evidence
→ SEM
→ slug
```

### 2.3. Application integration

Внешний backend использует полученный `slug` для получения карточки вина и формирования пользовательского ответа.

### 2.4. Evaluation

Внешний evaluator вызывает тот же HTTP endpoint, который используется для inference. GT и evaluation labels не являются входами recognition runtime.

---

## 3. Offline-подготовка каталога

Каталог не обрабатывается полностью при каждом запросе.

Для каждой активной каталожной позиции заранее подготавливаются данные, необходимые для retrieval и verification.

### 3.1. Catalog metadata

Содержит идентичность каталожной позиции:

```text
catalog item ID
official slug
доступные текстовые атрибуты
```

### 3.2. Active reference images

Для каждого catalog item используется явно назначенное активное эталонное изображение.

Reference image и catalog identity являются разными сущностями: смена эталонного изображения не меняет `catalog ID` и `slug`.

### 3.3. Visual galleries

Предрассчитанные embeddings эталонов используются visual retrieval-каналами:

- SigLIP;
- DINOv3;
- Label-SigLIP.

### 3.4. Reference OCR / text

Для эталонов заранее сохраняются:

- OCR-строки;
- нормализованные текстовые представления;
- reference tokens / phrases;
- структурированные текстовые признаки.

### 3.5. Geometry descriptors

Для эталонов заранее подготовлены:

- SIFT keypoints/descriptors;
- RootSIFT descriptors;
- данные, необходимые для локального geometric matching.

Эти объекты загружаются runtime и используются read-only во время inference.

---

## 4. Приём изображения

Основной inference endpoint:

```http
POST /v1/eval/predict
Content-Type: multipart/form-data

image=<raw image>
```

Результат:

```json
{"slug":"official-organizer-slug"}
```

Recognition API возвращает одну каталожную идентичность. В публичный evaluation response не входят внутренний candidate pool, scores и diagnostic evidence.

---

## 5. Decode и ориентация изображения

Первый этап online pipeline формирует единое изображение для дальнейшей обработки:

```text
raw bytes
→ decode
→ EXIF orientation
→ canonical RGB image
```

EXIF correction определяет правильную ориентацию исходного изображения.

Этот этап не выполняет автоматическую коррекцию перспективы или распознавание вина — его задача состоит в получении согласованного pixel representation для последующих компонентов.

---

## 6. Детекция и выбор целевой бутылки

Локализация выполняется в два этапа.

### 6.1. Bottle detection

**GroundingDINO** используется в target/localization pipeline для поиска областей изображения, соответствующих бутылкам/этикеткам.

Результатом являются candidate bounding boxes.

### 6.2. Target bottle selection

Из найденных бутылок выбирается один **target bottle**.

Target selection учитывает геометрические характеристики обнаруженных объектов и позволяет корректно обрабатывать сцены, где в кадр попадает несколько бутылок.

Логически:

```text
все найденные bottle regions
              ↓
      Target selector
              ↓
     одна target bottle
```

Все последующие подробные признаки должны быть связаны именно с выбранной бутылкой.

---

## 7. Target-aligned label selection

После выбора бутылки определяется область её этикетки.

```text
target bottle
     ↓
label proposals
     ↓
selected label ROI
```

Target crop и label crop имеют разные назначения.

В системе используются:

- target-level visual features;
- label-level visual features;
- label OCR;
- label/local geometry.

Таким образом, OCR или локальная геометрия соседней бутылки не должны участвовать в идентификации выбранного target.

---

## 8. Multimodal retrieval

После формирования target/label representations запускаются несколько retrieval-каналов.

### 8.1. SigLIP

**SigLIP** используется для visual-semantic retrieval по выбранной бутылке.

```text
target crop
→ SigLIP encoder
→ query embedding
→ similarity with reference gallery
→ ranked catalog candidates
```

Задача канала — найти визуально и семантически близкие позиции каталога.

### 8.2. DINOv3

**DINOv3** является дополнительным target-aligned visual retrieval/evidence channel.

```text
target-aligned image region
→ DINOv3
→ embedding
→ comparison with reference gallery
```

DINO не является detector-ом и не выдаёт финальную классификацию самостоятельно.

### 8.3. Label-SigLIP

Отдельный SigLIP retrieval выполняется для выбранной этикетки:

```text
label crop
→ SigLIP
→ label-level similarity
→ candidates
```

Этот канал повышает чувствительность к оформлению непосредственно этикетки.

---

## 9. OCR pipeline

Текстовый канал использует query OCR в двух ориентациях:

```text
label OCR input
   ├─ OCR 0°
   └─ OCR R90_CW
```

R90 — это фиксированный поворот OCR input на 90° по часовой стрелке. Он не означает поворот всей основной image-processing pipeline.

### 9.1. Base OCR state

На основе OCR0 строится базовое текстовое состояние:

```text
OCR0
→ text normalization
→ catalog text retrieval
→ B candidate context
```

### 9.2. R90 support gate

OCR R90 используется через support gate.

Новые распознанные R90 spans проверяются относительно уже существующего candidate context и reference/catalog text.

```text
OCR0 → B state ─────────────┐
                            │
OCR R90 → new text spans → support gate
                            │
                    ┌───────┴───────┐
                    ↓               ↓
                 Q state         B state
                    └───────┬───────┘
                            ↓
                  selected text state
```

Gate определяет, какое целое downstream text state использовать. Он не выбирает готовый Top-1 candidate.

---

## 10. Candidate pool

Кандидаты поступают из нескольких retrieval sources:

```text
SigLIP target
DINOv3 target-aligned
OCR catalog retrieval
Label-SigLIP
```

Списки объединяются по `catalog item ID`.

```text
retrieval sources
       ↓
union + deduplication
       ↓
final candidate pool
```

Candidate pool содержит ограниченный набор позиций каталога, для которых далее выполняется более дорогая детальная verification.

Retrieval отвечает на вопрос: какие каталожные позиции необходимо проверить. Он не определяет окончательный Top-1.

---

## 11. Text evidence

Для каждого кандидата рассчитываются текстовые признаки двух типов.

### 11.1. Query ↔ catalog

Сопоставляется текст query с каталогом:

- название;
- производитель / винодельня;
- поддерживаемые идентификационные атрибуты.

### 11.2. Query ↔ reference text

Query OCR сравнивается с OCR/text, извлечённым непосредственно из active reference image кандидата.

Это позволяет использовать текст, реально присутствующий на этикетке, отдельно от catalog metadata.

Результат преобразуется в набор candidate-level contributions для итогового scorer.

---

## 12. Local geometry — SIFT / RootSIFT

После формирования final candidate pool выполняется детальная локальная визуальная проверка.

Используются:

- **SIFT**;
- **RootSIFT**.

Query label region проходит:

```text
label region
→ resize для geometry
→ grayscale / CLAHE
→ SIFT keypoints + descriptors
→ RootSIFT transformation
```

Для каждого candidate descriptors query сопоставляются с заранее подготовленными reference descriptors.

Geometry evidence включает характеристики локальных совпадений и их пространственной согласованности:

- good/mutual matches;
- inliers;
- inlier ratio;
- coverage;
- spatial consistency.

SIFT и RootSIFT не являются отдельными классификаторами. Это два представления одних локальных признаков, используемых в geometry verification.

---

## 13. C4 geometry execution

В runtime используется исполнение **C4**.

После того как сформирован точный final candidate pool, geometry calculations для разных кандидатов могут выполняться параллельно:

```text
Final candidate pool
        ↓
Geometry dispatcher
        ↓
 ┌──────┬──────┬──────┬──────┐
 │      │      │      │
GEO1   GEO2   GEO3   GEO4
 │      │      │      │
 └──────┴──────┴──────┴──────┘
        ↓
    Ordered join
        ↓
   SEM scorer
```

Одновременно выполняется не более четырёх candidate geometry jobs.

Каждый worker использует ту же SIFT/RootSIFT verification logic.

После завершения результаты собираются в исходном deterministic candidate order.

C4 изменяет execution scheduling, но не меняет:

- входные pixels;
- target/label selection;
- retrieval;
- candidate pool;
- descriptors;
- geometry algorithms;
- candidate evidence;
- SEM scorer;
- ranking;
- output slug.

---

## 14. SEM reranker

Все candidates final pool оцениваются одной структурой scorer.

Основные группы evidence:

```text
visual semantic evidence
OCR / catalog identity evidence
reference OCR/text evidence
local geometry evidence
quality / missing evidence
```

Далее рассчитывается набор contribution-компонент.

Особенность текущего scorer:

```text
semantic contribution × λ
```

где:

```text
λ = 0.75
```

После этого semantic contribution складывается с остальными активными contributions.

Упрощённо:

```text
candidate evidence
       ↓
feature normalization
       ↓
contributions
       ↓
semantic × 0.75
       ↓
sum
       ↓
candidate score
```

SEM — это scorer/reranker, а не отдельная neural network и не вероятность правильности ответа.

DQ2 reliability prior и historical scoring overrides в текущем runtime не используются.

---

## 15. Ranking и формирование ответа

После получения score для каждого candidate выполняется deterministic ranking:

```text
candidate scores
      ↓
sorting
      ↓
Top-1 catalog ID
      ↓
ID → official slug
      ↓
JSON response
```

Итоговый recognition contract:

```json
{"slug":"..."}
```

Внутренний score или margin не используются как open-set rejection threshold.

---

## 16. Работа с вином вне каталога

Текущий VineDetect Core является **closed-set recognizer**.

`NOT_IN_CATALOG` rejection в recognition runtime отсутствует.

Поэтому для любого успешно обработанного изображения система выбирает наиболее подходящую позицию среди доступного candidate pool и возвращает catalog slug.

Сценарии:

- «вино не найдено»;
- показать похожие вина;
- предложить российский аналог;

относятся к **application/product layer** и не являются частью текущего алгоритма VineDetect Core.

---

## 17. Интеграция с приложением

VineDetect Core является отдельным сервисом.

Общая системная граница:

```text
Frontend
   │
   │ photo
   ▼
Application Backend
   │
   │ image
   ▼
VineDetect Core
SEM-ORG-FINAL-v3-C4
   │
   │ {"slug":"..."}
   ▼
Catalog / Database
   │
   │ wine data
   ▼
Application Backend
   │
   ▼
Frontend
```

Recognition Core не формирует пользовательскую карточку вина.

Его ответственность заканчивается на выдаче **официального slug**.

По slug внешний application layer получает:

- название;
- изображение;
- винодельню;
- регион;
- описание;
- гастрономические сочетания;
- другие данные продукта.

---

## 18. Runtime и deployment

Runtime запускается в контейнеризированном окружении.

Основные компоненты:

```text
Linux
Docker
NVIDIA GPU
frozen Python/model environment
read-only model/reference assets
VineDetect Core HTTP service
```

При startup launcher:

1. запускает контейнер;
2. ожидает readiness;
3. выполняет обязательный warmup;
4. после этого переводит сервис в рабочее состояние.

Для контроля lifecycle используются отдельные endpoint'ы:

```text
/health
/ready
```

---

## 19. Поставка

Текущая структура поставки разделяет три слоя.

### 19.1. Recognition specification

**SEM-ORG-FINAL-v3** определяет:

- preprocessing;
- target/label semantics;
- models;
- reference data;
- candidate policy;
- OCR gate;
- geometry;
- scorer;
- output mapping.

### 19.2. Execution runtime

**SEM-ORG-FINAL-v3-C4** реализует ту же recognition specification с C4 geometry scheduling.

### 19.3. Application

Отдельный слой:

- frontend;
- application backend;
- catalog access;
- wine-card UI;
- дополнительный пользовательский функционал.

---

## 20. Технологический стек ядра

| Компонент | Назначение |
|---|---|
| **GroundingDINO** | Детекция bottle/label regions |
| **SigLIP** | Semantic visual retrieval по target и label |
| **DINOv3** | Дополнительный target-aligned visual retrieval |
| **OCR engine** | Извлечение текста query и reference images |
| **OCR 0° + R90_CW gate** | Работа с обычным и повернутым текстом |
| **SIFT / RootSIFT** | Local feature matching и geometric verification |
| **SEM scorer** | Объединение candidate evidence и final reranking |
| **C4 dispatcher** | Параллельное выполнение geometry для ≤4 candidates |
| **HTTP API** | Интеграция recognition Core с evaluator/application |
| **Docker** | Фиксированное runtime-окружение |
| **Precomputed galleries / assets** | Быстрый доступ к reference embeddings/text/descriptors |

Роли моделей в системе разделены: detector локализует объект, embedding models выполняют retrieval, OCR извлекает текст, SIFT/RootSIFT проверяет локальное соответствие, SEM выполняет итоговое ранжирование.

---

## 21. Архитектура одного запроса

```text
RAW IMAGE
    │
    ▼
Decode + EXIF
    │
    ▼
GroundingDINO
    │
    ▼
Target bottle selection
    │
    ▼
Target-aligned label selection
    │
    ├──────────────┬──────────────┬──────────────┐
    │              │              │              │
    ▼              ▼              ▼              ▼
SigLIP          DINOv3          OCR0         Label-SigLIP
                                   │
                                OCR R90
                                   │
                              Support gate
    │              │              │              │
    └──────────────┴──────────────┴──────────────┘
                          │
                          ▼
                 Union candidate pool
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
     Semantic         OCR / text       Geometry
      evidence          evidence       SIFT/RootSIFT
                                           │
                                    C4 ≤4 workers
                                           │
                                      Ordered join
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                 SEM scorer λ=0.75
                          │
                          ▼
                   Final ranking
                          │
                          ▼
                  Top-1 catalog ID
                          │
                          ▼
                    Official slug
```

---

## Краткое описание

**VineDetect Core** реализует target-first multimodal retrieval-and-reranking pipeline. После декодирования изображения и выбора целевой бутылки система формирует target- и label-level representations. SigLIP, DINOv3, OCR и Label-SigLIP используются для retrieval кандидатов из подготовленного каталога. Query OCR обрабатывается в ориентациях 0° и R90_CW с support gate. Для final candidate pool рассчитываются textual/reference evidence и SIFT/RootSIFT geometry; в C4 geometry до четырёх кандидатов выполняется параллельно с deterministic ordered join. Единый SEM scorer с `λ = 0.75` формирует итоговый ranking. Сервис возвращает один официальный catalog slug через `POST /v1/eval/predict`.
