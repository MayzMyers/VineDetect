export type OcrSemanticType =
  | "vintage"
  | "barcode"
  | "alcohol"
  | "volume"
  | "classification"
  | "color"
  | "region"
  | "producer"
  | "product-name"
  | "free-text"
  | "unknown";

export type OcrSemanticClassification = {
  type: OcrSemanticType;
  confidence: number;
  reasons: string[];
};

type SemanticBox = { x: number; y: number; width: number; height: number };

export function classifyOcrSemantic(text: string, level: "line" | "word", bbox?: SemanticBox): OcrSemanticClassification {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim();
  const compact = value.replace(/[\s-]/g, "");
  if (!value) return semantic("unknown", 0, "EMPTY_TEXT");
  if (/^(?:19|20)\d{2}$/.test(compact)) return semantic("vintage", 0.99, "FOUR_DIGIT_YEAR");
  if (/^\d{8,14}$/.test(compact)) return semantic("barcode", 0.98, "BARCODE_DIGITS");
  if (/(?:\d{1,2}(?:[.,]\d+)?)\s*%|\b(?:alc|alcohol|vol|\u0430\u043b\u043a|\u043e\u0431)\b/i.test(value)) {
    return semantic("alcohol", 0.94, "ALCOHOL_PATTERN");
  }
  if (/(?:\d+(?:[.,]\d+)?)\s*(?:ml|cl|l|\u043c\u043b|\u0441\u043b|\u043b)\b/i.test(value)) {
    return semantic("volume", 0.94, "VOLUME_PATTERN");
  }
  if (/\b(?:docg?|aoc|igp|igt|dop|pdo|pg[i]?|\u0437\u0433\u0443|\u0437\u043d\u043c\u043f|\u043a\u0441|\u043a\u0432|\u0432\u044b\u0434\u0435\u0440\u0436\u0430\u043d\u043d\u043e\u0435|\u0440\u0435\u0437\u0435\u0440\u0432)\b/i.test(value)) {
    return semantic("classification", 0.88, "CLASSIFICATION_TERM");
  }
  if (/\b(?:red|white|rose|ros[e\u00e9]|\u043a\u0440\u0430\u0441\u043d\u043e\u0435|\u0431\u0435\u043b\u043e\u0435|\u0440\u043e\u0437\u043e\u0432\u043e\u0435)\b/i.test(value)) {
    return semantic("color", 0.86, "WINE_COLOR_TERM");
  }
  if (/\b(?:region|valley|terroir|estate|\u043e\u0431\u043b\u0430\u0441\u0442\u044c|\u043a\u0440\u0430\u0439|\u0434\u043e\u043b\u0438\u043d\u0430|\u043a\u0440\u044b\u043c|\u043a\u0443\u0431\u0430\u043d\u044c|\u043a\u0430\u0432\u043a\u0430\u0437|bordeaux|burgundy|rioja|toscana)\b/i.test(value)) {
    return semantic("region", 0.76, "REGION_TERM");
  }
  if (/\b(?:winery|cellars?|chateau|domaine|bodega|cantina|\u0432\u0438\u043d\u043e\u0434\u0435\u043b\u044c\u043d\u044f|\u0432\u0438\u043d\u043d\u044b\u0439 \u0434\u043e\u043c|\u0437\u0430\u0432\u043e\u0434)\b/i.test(value)) {
    return semantic("producer", 0.8, "PRODUCER_TERM");
  }
  const tokenCount = value.split(/\s+/).length;
  if (level === "line" && (value.length >= 28 || tokenCount >= 6)) return semantic("free-text", 0.68, "LONG_LINE");
  if (level === "line" && bbox && bbox.y <= 0.55 && value.length >= 3) return semantic("product-name", 0.58, "PROMINENT_UPPER_LABEL_LINE");
  return semantic("unknown", 0.35, "NO_STRONG_SEMANTIC_PATTERN");
}

export function sourceFieldSemanticType(field: string): OcrSemanticType {
  if (field === "year") return "vintage";
  if (field === "barcode") return "barcode";
  if (field === "color") return "color";
  if (field === "region") return "region";
  if (field === "manufacturer") return "producer";
  if (field === "category") return "classification";
  if (field === "title" || field === "alias") return "product-name";
  if (field === "description") return "free-text";
  return "unknown";
}

export function semanticSourceCompatibility(region: OcrSemanticClassification, sourceField: string) {
  const sourceType = sourceFieldSemanticType(sourceField);
  if (region.type === "unknown" || sourceType === "unknown") return 0.65;
  if (region.type === sourceType) return 1;
  if (region.type === "product-name" && sourceType === "producer") return 0.78;
  if (region.type === "producer" && sourceType === "product-name") return 0.72;
  if (region.type === "classification" && sourceType === "product-name") return 0.68;
  if (region.type === "region" && sourceType === "free-text") return 0.58;
  if (region.type === "free-text" && (sourceType === "product-name" || sourceType === "producer" || sourceType === "region")) return 0.55;
  return 0.18;
}

function semantic(type: OcrSemanticType, confidence: number, reason: string): OcrSemanticClassification {
  return { type, confidence, reasons: [reason] };
}
