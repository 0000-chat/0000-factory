import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const VIEWER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROUTE_TREE = join(VIEWER_DIR, 'src', 'routeTree.gen.ts');

function generateRoutes() {
  const result = spawnSync('bun', ['x', 'tsr', 'generate'], {
    cwd: VIEWER_DIR,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error('could not run tsr generate: ' + result.error.message);
    process.exitCode = 1;
    return false;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }

  return true;
}

const mode = process.argv[2] ?? 'generate';
if (mode === 'generate') {
  generateRoutes();
} else if (mode === 'check') {
  const previous = existsSync(ROUTE_TREE) ? readFileSync(ROUTE_TREE) : null;
  if (!generateRoutes()) process.exit(process.exitCode ?? 1);
  const generated = readFileSync(ROUTE_TREE);
  if (previous === null || !previous.equals(generated)) {
    console.error('routeTree.gen.ts changed during generation; commit the generated tree and rerun the check.');
    process.exitCode = 1;
  } else {
    console.log('routeTree.gen.ts is current.');
  }
} else {
  console.error('unknown route command "' + mode + '"; expected "generate" or "check".');
  process.exitCode = 2;
}
