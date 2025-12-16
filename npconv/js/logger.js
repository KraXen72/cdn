// Logging helper that writes to the debug console element
export function log(msg, type = "info") {
  const consoleDiv = document.getElementById('debug-console');
  if (!consoleDiv) return; // graceful fallback
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (type === 'err') line.className = 'log-err';
  else if (type === 'warn') line.className = 'log-warn';
  else if (type === 'schema') line.className = 'log-schema';
  else line.className = 'log-info';

  consoleDiv.appendChild(line);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;
}
