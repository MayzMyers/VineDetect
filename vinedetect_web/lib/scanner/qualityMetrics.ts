export function estimateBrightness(imageData: ImageData) {
  const luminance = collectLuminance(imageData);
  return clamp01(mean(luminance) / 255);
}

export function estimateContrast(imageData: ImageData) {
  const luminance = collectLuminance(imageData);
  const avg = mean(luminance);
  const variance = mean(luminance.map((value) => (value - avg) ** 2));
  return clamp01(Math.sqrt(variance) / 80);
}

export function estimateSharpness(imageData: ImageData) {
  const gray = toGray(imageData);
  const { width, height } = imageData;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const center = gray[y * width + x] ?? 0;
      const laplacian =
        (gray[(y - 1) * width + x] ?? 0) +
        (gray[(y + 1) * width + x] ?? 0) +
        (gray[y * width + x - 1] ?? 0) +
        (gray[y * width + x + 1] ?? 0) -
        4 * center;

      sum += laplacian;
      sumSq += laplacian * laplacian;
      count++;
    }
  }

  const avg = sum / Math.max(count, 1);
  const variance = sumSq / Math.max(count, 1) - avg * avg;
  return clamp01(variance / 900);
}

export function estimateTextDensity(imageData: ImageData) {
  const gray = toGray(imageData);
  const { width, height } = imageData;
  let edgeCount = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const current = gray[y * width + x] ?? 0;
      const gradient =
        Math.abs(current - (gray[y * width + x + 1] ?? 0)) +
        Math.abs(current - (gray[(y + 1) * width + x] ?? 0));

      if (gradient > 34) edgeCount++;
      count++;
    }
  }

  return clamp01(edgeCount / Math.max(count, 1) / 0.24);
}

function collectLuminance(imageData: ImageData) {
  const values: number[] = [];
  const { data } = imageData;

  for (let i = 0; i < data.length; i += 4) {
    values.push(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0));
  }

  return values;
}

function toGray(imageData: ImageData) {
  return Uint8ClampedArray.from(collectLuminance(imageData));
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
