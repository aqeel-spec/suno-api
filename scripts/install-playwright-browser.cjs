const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  return result.status === 0;
}

function findSystemBrowserExecutable() {
  if (process.platform !== 'win32') {
    return undefined;
  }

  for (const candidate of WINDOWS_BROWSER_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

const systemBrowser = findSystemBrowserExecutable();
if (systemBrowser) {
  console.log(`[postinstall] Found system browser at ${systemBrowser}; skipping Playwright Chromium download.`);
  process.exit(0);
}

try {
  const ok = run('npx', ['playwright', 'install', 'chromium']);
  if (!ok) {
    console.warn('[postinstall] Playwright Chromium download did not complete.');
  }
} catch (error) {
  console.warn('[postinstall] Skipping Playwright browser install:', error?.message || error);
}
