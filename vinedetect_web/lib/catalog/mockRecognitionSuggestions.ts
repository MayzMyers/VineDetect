import bootstrapAsset from "@/public/mock/recognition-bootstrap.v1.json";
import {
  buildRecognitionBootstrapIndex,
  suggestRecognitionBootstrap,
  type RecognitionBootstrap,
} from "./recognitionBootstrap";

const bootstrap = bootstrapAsset as unknown as RecognitionBootstrap;
const index = buildRecognitionBootstrapIndex(bootstrap);

export function getMockRecognitionSuggestions(options: {
  ocrText?: string;
  seedCatalogKey?: string;
  excludeCatalogKeys?: string[];
  limit?: number;
}) {
  return {
    version: index.version,
    suggestions: suggestRecognitionBootstrap(index, options),
  };
}
