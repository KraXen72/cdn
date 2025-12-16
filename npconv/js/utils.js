// Utility helpers
export function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export function downloadFile(blob, filename, timestamp = null) {
  let finalFilename = filename;
  if (timestamp) {
    if (filename.endsWith('.zip')) {
      finalFilename = filename.replace('.zip', `-${timestamp}.zip`);
    } else if (filename.endsWith('.json')) {
      finalFilename = filename.replace('.json', `-${timestamp}.json`);
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = finalFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
