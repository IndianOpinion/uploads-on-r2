/**
 * uploads-on-r2: serves the WordPress uploads path from an R2 bucket, with
 * origin fallback. The default export is the Worker; the named exports are
 * pure helpers, for tests and reuse.
 */

import type { Env } from "./config";
import { handleRequest } from "./handler";

export { parseConfig, getConfig, type Config, type Env, type Family } from "./config";
export { normaliseKey, extensionOf, isDenied, type KeyResult } from "./key";
export { contentTypeFor, cacheControlFor, familyOf } from "./content-type";
export {
  evaluatePreconditions,
  ifRangeMatches,
  parseRange,
  parseRangeSpec,
  resolveRange,
  parseHttpDate,
  formatHttpDate,
  type RangeResult,
  type RangeSpec,
} from "./http";
export { sliceStream } from "./stream";
export { handleRequest, denyResponse, type Deps, type Source } from "./handler";

export default {
  fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx, {
      fetch: (outbound) => fetch(outbound),
      cache: caches.default,
    });
  },
} satisfies ExportedHandler<Env>;
