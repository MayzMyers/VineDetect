import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";

export type DinoGeometry = {
  width_ratio: number;
  height_ratio: number;
  area_ratio: number;
  center_x: number;
  center_y: number;
};

export type DinoDetection = {
  _image_width: number;
  _image_height: number;
  model_score: number;
  box_xyxy: [number, number, number, number];
  box_xywh: [number, number, number, number];
  geometry: DinoGeometry;
  geometry_reject_reasons?: string[];
  support_count?: number;
  containment_bonus?: number;
  selection_score?: number;
};

export type DinoLabelResult = {
  model: string;
  revision: string | null;
  device: string;
  prompt: string;
  threshold: number;
  textThreshold: number;
  width: number;
  height: number;
  inferenceMs: number;
  selectionMethod:
    | "geometry-containment"
    | "white-label-fallback"
    | "compact-wordmark-fallback"
    | "cv-fallback-needed"
    | "no-detection";
  selected: DinoDetection | null;
  detections: DinoDetection[];
  attemptedPrompts?: string[];
};

export async function detectLabelWithDino(input: {
  imagePath: string;
  fetchImpl?: typeof fetch;
}): Promise<DinoLabelResult> {
  const imageBase64 = (await readFile(input.imagePath)).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    env.DINO_TIMEOUT_MS,
  );

  try {
    const response = await (input.fetchImpl ?? fetch)(
      `${env.DINO_SERVICE_URL}/v1/dino/detect-label`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(env.SIGLIP_SERVICE_TOKEN
            ? {
                authorization: `Bearer ${env.SIGLIP_SERVICE_TOKEN}`,
              }
            : {}),
        },
        body: JSON.stringify({
          imageBase64,
          prompt: env.DINO_PROMPT,
          threshold: env.DINO_THRESHOLD,
          textThreshold: env.DINO_TEXT_THRESHOLD,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `DINO service returned HTTP ${response.status}`,
      );
    }

    return validateDinoResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function validateDinoResponse(value: unknown): DinoLabelResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DINO response is not an object");
  }

  const item = value as Record<string, unknown>;

  if (item.model !== env.DINO_MODEL) {
    throw new Error("DINO model provenance mismatch");
  }

  if (item.revision !== env.DINO_MODEL_REVISION) {
    throw new Error("DINO revision provenance mismatch");
  }

  const width = finite(item.width);
  const height = finite(item.height);
  const inferenceMs = finite(item.inferenceMs);
  const threshold = finite(item.threshold);
  const textThreshold = finite(item.textThreshold);

  if (
    width === null ||
    height === null ||
    inferenceMs === null ||
    threshold === null ||
    textThreshold === null ||
    !Array.isArray(item.detections)
  ) {
    throw new Error("DINO response fields are invalid");
  }

  const selectionMethod = item.selectionMethod;

  if (
    selectionMethod !== "geometry-containment" &&
    selectionMethod !== "white-label-fallback" &&
    selectionMethod !== "compact-wordmark-fallback" &&
    selectionMethod !== "cv-fallback-needed" &&
    selectionMethod !== "no-detection"
  ) {
    throw new Error("DINO selection method is invalid");
  }

  const detections = item.detections.map(validateDetection);

  let selected: DinoDetection | null = null;

  if (item.selected !== null && item.selected !== undefined) {
    selected = validateDetection(item.selected);
  }

  const selectedMethod =
    selectionMethod === "geometry-containment" ||
    selectionMethod === "white-label-fallback" ||
    selectionMethod === "compact-wordmark-fallback";

  if (selectedMethod && selected === null) {
    throw new Error(
      "DINO selected response omitted selected candidate",
    );
  }

  if (!selectedMethod && selected !== null) {
    throw new Error(
      "DINO non-selected response unexpectedly selected a candidate",
    );
  }

  return {
    model: String(item.model),
    revision:
      typeof item.revision === "string"
        ? item.revision
        : null,
    device:
      typeof item.device === "string"
        ? item.device
        : "unknown",
    prompt:
      typeof item.prompt === "string"
        ? item.prompt
        : "",
    threshold,
    textThreshold,
    width,
    height,
    inferenceMs,
    selectionMethod,
    selected,
    detections,
    attemptedPrompts: Array.isArray(item.attemptedPrompts)
      ? item.attemptedPrompts.filter(
          (value): value is string =>
            typeof value === "string",
        )
      : undefined,
  };
}

function validateDetection(value: unknown): DinoDetection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DINO detection is invalid");
  }

  const item = value as Record<string, unknown>;

  const imageWidth = finite(item._image_width);
  const imageHeight = finite(item._image_height);
  const modelScore = finite(item.model_score);

  if (
    imageWidth === null ||
    imageHeight === null ||
    modelScore === null
  ) {
    throw new Error("DINO detection metadata is invalid");
  }

  const boxXyxy = numericTuple4(item.box_xyxy);
  const boxXywh = numericTuple4(item.box_xywh);

  if (
    boxXywh[2] <= 0 ||
    boxXywh[3] <= 0 ||
    boxXyxy[2] <= boxXyxy[0] ||
    boxXyxy[3] <= boxXyxy[1]
  ) {
    throw new Error("DINO detection bbox is invalid");
  }

  if (
    boxXywh[0] < 0 ||
    boxXywh[1] < 0 ||
    boxXywh[0] + boxXywh[2] > imageWidth + 1 ||
    boxXywh[1] + boxXywh[3] > imageHeight + 1
  ) {
    throw new Error("DINO detection bbox exceeds source dimensions");
  }

  const geometryRaw = item.geometry;

  if (
    !geometryRaw ||
    typeof geometryRaw !== "object" ||
    Array.isArray(geometryRaw)
  ) {
    throw new Error("DINO geometry is invalid");
  }

  const geometryItem = geometryRaw as Record<string, unknown>;

  const geometry: DinoGeometry = {
    width_ratio: requiredFinite(geometryItem.width_ratio),
    height_ratio: requiredFinite(geometryItem.height_ratio),
    area_ratio: requiredFinite(geometryItem.area_ratio),
    center_x: requiredFinite(geometryItem.center_x),
    center_y: requiredFinite(geometryItem.center_y),
  };

  return {
    _image_width: imageWidth,
    _image_height: imageHeight,
    model_score: modelScore,
    box_xyxy: boxXyxy,
    box_xywh: boxXywh,
    geometry,
    geometry_reject_reasons: Array.isArray(
      item.geometry_reject_reasons,
    )
      ? item.geometry_reject_reasons.filter(
          (value): value is string =>
            typeof value === "string",
        )
      : undefined,
    support_count:
      finite(item.support_count) ?? undefined,
    containment_bonus:
      finite(item.containment_bonus) ?? undefined,
    selection_score:
      finite(item.selection_score) ?? undefined,
  };
}

function numericTuple4(
  value: unknown,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("DINO bbox is invalid");
  }

  return [
    requiredFinite(value[0]),
    requiredFinite(value[1]),
    requiredFinite(value[2]),
    requiredFinite(value[3]),
  ];
}

function requiredFinite(value: unknown): number {
  const result = finite(value);

  if (result === null) {
    throw new Error("DINO numeric value is invalid");
  }

  return result;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}
