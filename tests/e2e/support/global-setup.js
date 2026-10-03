// Playwright global setup: fill the temp root that the dev server (webServer in playwright.config.js) serves.
//
// Playwright starts the webServer BEFORE global setup. That is fine: the server reads every file from disk per
// request, and its readiness URL (/api/config) answers with defaults even while the root is still empty.

import { rmSync } from 'node:fs';
import path from 'node:path';
import { prepareRoot } from './root.js';

export default async function globalSetup() {
  const root = process.env.XW_E2E_ROOT;
  if (!root) throw new Error('XW_E2E_ROOT is not set (it is chosen in playwright.config.js)');
  // The root is wiped before and after the run: never accept a directory that was not made for this.
  if (!path.basename(root).startsWith('xw-e2e-')) throw new Error(`Refusing to use ${root} as the e2e root`);
  prepareRoot(root);
  // Returned function = global teardown. Set XW_E2E_KEEP=1 to keep the root for debugging.
  return async () => {
    if (process.env.XW_E2E_KEEP) console.log(`e2e root kept at ${root}`);
    else rmSync(root, { recursive: true, force: true });
  };
}
