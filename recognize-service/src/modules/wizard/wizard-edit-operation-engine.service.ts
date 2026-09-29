import { ConflictError } from "../../shared/errors.js";
import { editPrimitive, stageEditDefinition, type EditPrimitiveId } from "../../shared/editStageContract.js";
import type { WizardStageId } from "../../shared/helperConfigContract.js";
import type { LabelEditOperation, StageEditOperation } from "./wizard.schemas.js";

export type EditEngineNode<TPayload = Record<string, unknown>> = {
  id: string;
  payload: TPayload;
  sources: Map<string, TPayload>;
};

export type EditEnginePlanResult<TPayload = Record<string, unknown>> = {
  nodes: ReadonlyMap<string, EditEngineNode<TPayload>>;
  accepted: EditEngineNode<TPayload>[];
  rejectedSourceIds: ReadonlySet<string>;
};

export type OcrRerunOperation = {
  operationId: string;
  type: "rerun_ocr";
  actor: "system";
  inputIds: [string];
  helper: { id: "tesseract-cascade"; version: "v6"; config: Record<string, unknown> };
  result: { transcription: string | null; transcriptionStatus: "verified" | "partial" | "unreadable"; recognitionConfidence: number | null; evidence: Record<string, unknown> };
};

export type ExecutableEditOperation = StageEditOperation | OcrRerunOperation;
type SupportedOperation = ExecutableEditOperation;
type HandlerResult<TPayload> = {
  derived?: EditEngineNode<TPayload> | EditEngineNode<TPayload>[];
  accepted?: EditEngineNode<TPayload>;
  rejectedSourceIds?: Iterable<string>;
};
type Handler<TPayload> = (input: {
  operation: SupportedOperation;
  inputs: EditEngineNode<TPayload>[];
}) => HandlerResult<TPayload>;

const HANDLERS = new Map<string, Handler<Record<string, unknown>>>();

export function registerEditOperationHandler<TPayload extends Record<string, unknown>>(
  stage: WizardStageId,
  primitive: EditPrimitiveId,
  handler: Handler<TPayload>,
) {
  const definition = stageEditDefinition(stage);
  if (!definition.primitives.includes(primitive)) throw new Error(`${primitive} is not declared for ${stage}`);
  const key = handlerKey(stage, primitive);
  if (HANDLERS.has(key)) throw new Error(`Edit handler is already registered for ${stage}.${primitive}`);
  HANDLERS.set(key, handler as Handler<Record<string, unknown>>);
}

export function registeredEditOperationPrimitives(stage: WizardStageId) {
  return stageEditDefinition(stage).primitives.filter((primitive) => HANDLERS.has(handlerKey(stage, primitive)));
}

export function executeEditOperationPlan<TPayload extends Record<string, unknown>>(input: {
  stage: WizardStageId;
  initialNodes: EditEngineNode<TPayload>[];
  operations: SupportedOperation[];
}): EditEnginePlanResult<TPayload> {
  const declared = new Set(stageEditDefinition(input.stage).primitives);
  const nodes = new Map(input.initialNodes.map((node) => [node.id, node]));
  if (nodes.size !== input.initialNodes.length) throw new ConflictError("Edit Engine initial node IDs must be unique");
  const accepted: EditEngineNode<TPayload>[] = [];
  const rejectedSourceIds = new Set<string>();
  const operationIds = new Set<string>();

  for (const operation of input.operations) {
    if (!declared.has(operation.type)) throw new ConflictError(`${operation.type} is not declared for ${input.stage}`);
    if (operationIds.has(operation.operationId) || nodes.has(operation.operationId)) throw new ConflictError("Edit Engine operation IDs must be unique");
    operationIds.add(operation.operationId);
    const cardinality = editPrimitive(operation.type).inputCardinality;
    if (operation.inputIds.length < cardinality.min || operation.inputIds.length > cardinality.max) {
      throw new ConflictError(`${operation.type} requires ${cardinality.min === cardinality.max ? cardinality.min : `${cardinality.min}..${cardinality.max}`} input node(s)`);
    }
    const inputs = operation.inputIds.map((id) => nodes.get(id));
    if (inputs.some((node) => !node)) throw new ConflictError("Edit Engine operation references an unknown or forward node");
    const handler = HANDLERS.get(handlerKey(input.stage, operation.type)) as Handler<TPayload> | undefined;
    if (!handler) throw new ConflictError(`Edit Engine handler is not implemented for ${input.stage}.${operation.type}`);
    const result = handler({ operation, inputs: inputs as EditEngineNode<TPayload>[] });
    if (result.derived) {
      const derivedNodes = Array.isArray(result.derived) ? result.derived : [result.derived];
      for (const [index, derived] of derivedNodes.entries()) {
        const expectedId = derivedNodes.length === 1 ? operation.operationId : `${operation.operationId}:${index + 1}`;
        if (derived.id !== expectedId || nodes.has(derived.id)) throw new ConflictError("Derived node must use its deterministic operation output ID");
        nodes.set(derived.id, derived);
      }
    }
    if (result.accepted) accepted.push(result.accepted);
    for (const sourceId of result.rejectedSourceIds ?? []) rejectedSourceIds.add(sourceId);
  }
  return { nodes, accepted, rejectedSourceIds };
}

registerEditOperationHandler("label", "accept", ({ inputs }) => ({ accepted: inputs[0] }));
registerEditOperationHandler("label", "reject", ({ inputs }) => ({ rejectedSourceIds: inputs[0]!.sources.keys() }));
registerEditOperationHandler("label", "edit", ({ operation, inputs }) => {
  const input = inputs[0]!;
  if (!("adjustment" in operation) || !operation.adjustment) throw new ConflictError("Label edit adjustment is missing");
  const payload = adjustLabelGeometry(input.payload, operation.adjustment);
  const sources = input.sources.size === 1
    ? new Map<string, Record<string, unknown>>([[[...input.sources.keys()][0]!, payload]])
    : new Map(input.sources);
  return { derived: { id: operation.operationId, payload, sources } };
});
registerEditOperationHandler("label", "merge", ({ operation, inputs }) => {
  const sources = new Map<string, Record<string, unknown>>();
  for (const input of inputs) for (const [sourceId, payload] of input.sources) {
    if (sources.has(sourceId)) throw new ConflictError("Label merge cannot consume the same source candidate twice");
    sources.set(sourceId, payload);
  }
  return { derived: { id: operation.operationId, payload: enclosingLabelGeometry(inputs.map((node) => node.payload)), sources } };
});

registerEditOperationHandler("ocr", "approve_region", ({ inputs }) => ({ accepted: inputs[0] }));
registerEditOperationHandler("ocr", "approve_text", ({ inputs }) => ({ accepted: inputs[0] }));
registerEditOperationHandler("ocr", "reject", ({ inputs }) => ({ rejectedSourceIds: inputs[0]!.sources.keys() }));
registerEditOperationHandler("ocr", "edit_region", ({ operation, inputs }) => {
  const input = inputs[0]!;
  const directGeometry = "geometry" in operation ? operation.geometry : null;
  const payload = directGeometry
    ? { ...input.payload, geometry: directGeometry,
      ...("layout" in operation && operation.layout ? { layout: operation.layout } : {}),
      ...("rectification" in operation ? { rectification: operation.rectification } : {}) }
    : adjustOcrGeometry(input.payload, "adjustment" in operation ? operation.adjustment : null);
  return { derived: { id: operation.operationId, payload, sources: new Map([...input.sources.keys()].map((id) => [id, payload])) } };
});
registerEditOperationHandler("ocr", "edit_text", ({ operation, inputs }) => {
  const input = inputs[0]!;
  if (!("text" in operation) || !("transcriptionStatus" in operation)) throw new ConflictError("OCR edit_text payload is missing");
  const payload = { ...input.payload, transcription: operation.transcriptionStatus === "unreadable" ? null : operation.text, transcriptionStatus: operation.transcriptionStatus };
  return { derived: { id: operation.operationId, payload, sources: new Map([...input.sources.keys()].map((id) => [id, payload])) } };
});
registerEditOperationHandler("ocr", "set_status", ({ operation, inputs }) => {
  const input = inputs[0]!;
  if (!("transcriptionStatus" in operation)) throw new ConflictError("OCR set_status payload is missing");
  const payload = { ...input.payload, transcriptionStatus: operation.transcriptionStatus, ...(operation.transcriptionStatus === "unreadable" ? { transcription: null } : {}) };
  return { derived: { id: operation.operationId, payload, sources: new Map([...input.sources.keys()].map((id) => [id, payload])) } };
});
registerEditOperationHandler("ocr", "merge_region", ({ operation, inputs }) => {
  const sources = new Map<string, Record<string, unknown>>();
  for (const input of inputs) for (const [sourceId, payload] of input.sources) {
    if (sources.has(sourceId)) throw new ConflictError("OCR merge_region cannot consume the same auto node twice");
    sources.set(sourceId, payload);
  }
  const payload = enclosingOcrPayload(inputs.map((input) => input.payload));
  return { derived: { id: operation.operationId, payload, sources } };
});
registerEditOperationHandler("ocr", "split_region", ({ operation, inputs }) => {
  if (!("split" in operation) || !operation.split) throw new ConflictError("OCR split parameters are missing");
  const input = inputs[0]!;
  return { derived: splitOcrPayload(input, operation.operationId, operation.split.axis, operation.split.fractions) };
});
registerEditOperationHandler("ocr", "create_region", ({ operation }) => {
  if (!("geometry" in operation) || !operation.geometry || !("transcriptionStatus" in operation) || !operation.transcriptionStatus) {
    throw new ConflictError("OCR create_region payload is missing");
  }
  const payload = {
    geometry: operation.geometry,
    transcription: operation.transcriptionStatus === "unreadable" ? null : operation.text,
    transcriptionStatus: operation.transcriptionStatus,
    regionStatus: "reviewed",
    recognitionConfidence: null,
    detectionConfidence: null,
    layout: { type: "word", flow: "linear", baselineAngleDeg: 0, baseline: null, characterOrientation: "aligned" },
    rectification: null,
  };
  return { derived: { id: operation.operationId, payload, sources: new Map() } };
});
registerEditOperationHandler("ocr", "compose_string", ({ operation, inputs }) => {
  if (!("composition" in operation) || !operation.composition) throw new ConflictError("OCR composition metadata is missing");
  if (inputs.some((input) => input.payload.kind === "string-composition")) throw new ConflictError("OCR composition members must be physical regions");
  return { derived: { id: operation.operationId, payload: {
    kind: "string-composition",
    memberNodeIds: operation.inputIds,
    text: operation.composition.text,
    transcriptionStatus: operation.composition.transcriptionStatus,
    sortOrder: operation.composition.sortOrder,
  }, sources: new Map() } };
});
registerEditOperationHandler("ocr", "decompose_string", ({ inputs }) => {
  if (inputs[0]!.payload.kind !== "string-composition") throw new ConflictError("OCR decompose_string requires a composition node");
  return {};
});
registerEditOperationHandler("ocr", "rerun_ocr", ({ operation, inputs }) => {
  if (!("result" in operation)) throw new ConflictError("OCR rerun result is missing");
  const input = inputs[0]!;
  const payload = { ...input.payload, ...operation.result };
  return { derived: { id: operation.operationId, payload, sources: new Map(input.sources) } };
});

function handlerKey(stage: WizardStageId, primitive: EditPrimitiveId) { return `${stage}:${primitive}`; }

function adjustLabelGeometry(geometry: Record<string, unknown>, adjustment: NonNullable<LabelEditOperation["adjustment"]>) {
  const bbox = box(geometry.bbox);
  const magnitude = adjustment.strength === "medium" ? 0.06 : 0.025;
  const dx = Math.max(1, bbox.width * magnitude), dy = Math.max(1, bbox.height * magnitude);
  let { x, y, width, height } = bbox;
  const direction = adjustment.direction === "expand" ? 1 : -1;
  if (adjustment.edge === "all" || adjustment.edge === "left") { x -= direction * dx; width += direction * dx; }
  if (adjustment.edge === "all" || adjustment.edge === "right") width += direction * dx;
  if (adjustment.edge === "all" || adjustment.edge === "top") { y -= direction * dy; height += direction * dy; }
  if (adjustment.edge === "all" || adjustment.edge === "bottom") height += direction * dy;
  if (width <= 1 || height <= 1) throw new ConflictError("Label edit adjustment collapses the ROI");
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (width <= 1 || height <= 1) throw new ConflictError("Label edit adjustment collapses the ROI");
  return rectangleGeometry(x, y, width, height);
}

function adjustOcrGeometry(payload: Record<string, unknown>, adjustment: { direction: "expand" | "contract"; edge: "all" | "top" | "right" | "bottom" | "left"; strength: "small" | "medium" } | null) {
  if (!adjustment) throw new ConflictError("OCR edit_region requires a bounded adjustment");
  const geometry = record(payload.geometry);
  const bbox = box(geometry.bbox);
  const magnitude = adjustment.strength === "medium" ? 0.06 : 0.025;
  const dx = bbox.width * magnitude, dy = bbox.height * magnitude;
  let { x, y, width, height } = bbox;
  const direction = adjustment.direction === "expand" ? 1 : -1;
  if (adjustment.edge === "all" || adjustment.edge === "left") { x -= direction * dx; width += direction * dx; }
  if (adjustment.edge === "all" || adjustment.edge === "right") width += direction * dx;
  if (adjustment.edge === "all" || adjustment.edge === "top") { y -= direction * dy; height += direction * dy; }
  if (adjustment.edge === "all" || adjustment.edge === "bottom") height += direction * dy;
  x = Math.max(0, x); y = Math.max(0, y); width = Math.min(1 - x, width); height = Math.min(1 - y, height);
  if (width <= 0.001 || height <= 0.001) throw new ConflictError("OCR edit_region collapses the region");
  return { ...payload, geometry: rectangleGeometry(x, y, width, height) };
}

function enclosingOcrPayload(values: Array<Record<string, unknown>>) {
  const geometry = enclosingLabelGeometry(values.map((value) => record(value.geometry)));
  const transcriptions = values.map((value) => typeof value.transcription === "string" ? value.transcription.trim() : "").filter(Boolean);
  return {
    ...values[0], geometry,
    transcription: transcriptions.length ? transcriptions.join(" ") : null,
    transcriptionStatus: values.every((value) => value.transcriptionStatus === "verified") ? "verified" : transcriptions.length ? "partial" : "unreadable",
    recognitionConfidence: null,
  };
}

function splitOcrPayload(input: EditEngineNode<Record<string, unknown>>, operationId: string, axis: "horizontal" | "vertical", fractions: number[]) {
  const geometry = record(input.payload.geometry) as unknown as QuadGeometryLike;
  if (!Array.isArray(geometry.points) || geometry.points.length !== 4) throw new ConflictError("OCR split requires quad geometry");
  const boundaries = [0, ...fractions, 1];
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const points = axis === "vertical"
      ? [mix(geometry.points[0], geometry.points[1], start), mix(geometry.points[0], geometry.points[1], end), mix(geometry.points[3], geometry.points[2], end), mix(geometry.points[3], geometry.points[2], start)]
      : [mix(geometry.points[0], geometry.points[3], start), mix(geometry.points[1], geometry.points[2], start), mix(geometry.points[1], geometry.points[2], end), mix(geometry.points[0], geometry.points[3], end)];
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    return {
      id: `${operationId}:${index + 1}`,
      payload: { ...input.payload, geometry: { type: "quad", points, bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } }, transcription: null, transcriptionStatus: "unreadable", recognitionConfidence: null },
      sources: new Map(input.sources),
    };
  });
}

type QuadGeometryLike = { points: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] };
function mix(left: { x: number; y: number }, right: { x: number; y: number }, amount: number) { return { x: left.x + (right.x - left.x) * amount, y: left.y + (right.y - left.y) * amount }; }

export function enclosingLabelGeometry(values: Array<Record<string, unknown>>) {
  const boxes = values.map((value) => box(value.bbox));
  if (!boxes.length) throw new ConflictError("Label merge requires geometry inputs");
  const x = Math.min(...boxes.map((item) => item.x)), y = Math.min(...boxes.map((item) => item.y));
  const right = Math.max(...boxes.map((item) => item.x + item.width)), bottom = Math.max(...boxes.map((item) => item.y + item.height));
  return rectangleGeometry(x, y, right - x, bottom - y);
}

function rectangleGeometry(x: number, y: number, width: number, height: number) {
  return { type: "quad", points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], bbox: { x, y, width, height } };
}

function box(value: unknown) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const x = Number(item.x), y = Number(item.y), width = Number(item.width), height = Number(item.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new ConflictError("Edit Engine requires valid bbox geometry");
  return { x, y, width, height };
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
