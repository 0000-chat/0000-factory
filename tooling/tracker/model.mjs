import { loadTrackerFromFiles } from './model-core.mjs';
import { readDataFiles } from '../instance/paths.mjs';

export * from './model-core.mjs';

/**
 * Load selected data-only inputs through the site path contract.  The model
 * receives canonical paths and therefore retains one domain shape for root
 * and nested data repositories.
 *
 * @param {{dataRepo:string,instance:Readonly<object>}} options
 */
export function loadTracker({ dataRepo, instance }) {
  return loadTrackerFromFiles(readDataFiles({ dataRepo, instance }));
}
