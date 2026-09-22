import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'scripts']) for (const name of fs.readdirSync(directory)) {
  if (!/\.(m?js)$/.test(name)) continue;
  const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
