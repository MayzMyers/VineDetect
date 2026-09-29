export const RECOGNITION_LIST_TAG_MARKER = "recognition-list";

export const RECOGNITION_LIST_TAGS = [
  { value: "needs-manual-review", label: "Needs manual review" },
  { value: "nonstandard-package", label: "Nonstandard package" },
  { value: "nonstandard-label", label: "Nonstandard label" },
  { value: "low-image-quality", label: "Low image quality" },
  { value: "exclude-from-training", label: "Exclude from training" },
] as const;

export function formatRecognitionTag(value: string) {
  return RECOGNITION_LIST_TAGS.find((tag) => tag.value === value)?.label
    ?? value.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
