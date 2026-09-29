import { createTrainingRun as createTrainingRunRecord, type TrainingTask } from "../../db/training.repository.js";
import { ConflictError } from "../../shared/errors.js";
import { inspectDatasetArtifact } from "./datasetArtifactConsumer.js";

export async function createValidatedTrainingRun(input: {
  datasetArtifactId: string;
  task: TrainingTask;
  name: string;
  framework: string;
  runtime?: string;
  configSnapshot: Record<string, unknown>;
  codeVersion?: string;
  createdBy?: string;
}) {
  const readiness = await inspectDatasetArtifact(input.datasetArtifactId, input.task);
  if (!readiness.ready) throw new ConflictError(`Dataset artifact has no trainable ${input.task} samples`);
  return createTrainingRunRecord(input);
}
