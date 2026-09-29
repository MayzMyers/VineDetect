export async function requestEnvironmentCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API is not available");
  }

  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
}

export function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}
