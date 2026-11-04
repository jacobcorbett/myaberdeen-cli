// Gate scripts that need the supported Node line and installed packages.
// runtime-policy.js has no dependencies, so this runs before anything that imports them.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertSupportedRuntime } from '../src/runtime-policy.js';

function fail(message) {
  console.error(message);
  process.exit(1);
}

export function checkRuntime({ dev = false } = {}) {
  try {
    assertSupportedRuntime();
  } catch (error) {
    fail(error.message);
  }
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...(dev ? pkg.devDependencies : {}) });
  const missing = names.filter(name => !fs.existsSync(new URL(`../node_modules/${name}/package.json`, import.meta.url)));
  if (missing.length) fail(`Missing installed packages: ${missing.join(', ')}. Run npm ci from the repository root first.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkRuntime({ dev: process.argv.includes('--dev') });
}
