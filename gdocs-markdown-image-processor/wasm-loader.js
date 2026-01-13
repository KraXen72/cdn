// Simple wasm loader used to satisfy the "#wasm-loader" specifier
// Return a path the package's `.wasm` asset hosted on the CDN so the
// formatter module can fetch it with the correct MIME type.
export async function loadWasmBuffer() {
  // Point at the hosted wasm file on jsDelivr for the matching package version.
  // This avoids the browser trying to resolve a bare `#wasm-loader` specifier
  // to the local origin and hitting the wrong MIME type.
  return 'https://cdn.jsdelivr.net/npm/@hongdown/wasm@0.2.1/dist/hongdown_bg.wasm';
}
