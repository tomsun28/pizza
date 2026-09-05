/**
 * Compatibility shim between the vendored pi-computer-use backend and Pizza.
 *
 * The vendored code (MIT, (c) injaneity/pi-computer-use contributors) was
 * written against the pi coding agent. Pizza shares the same extension type
 * vocabulary, so the only runtime difference is `getAgentDir`. Everything
 * else is satisfied by re-exporting Pizza's own types.
 */
export { getAgentDir } from "../../../config.js";
export type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "../../../core/extensions/types.js";
