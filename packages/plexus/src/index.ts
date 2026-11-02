/**
 * What PLexus promises.
 *
 * Everything reachable from here is API: a consumer may import it, and it
 * moves under semver. Everything else is behind `@evref-bl/plexus/internal`,
 * which promises nothing and may change in any release — it is there for this
 * repository's own scripts, and for a consumer that knowingly reaches past the
 * contract.
 *
 * The split is by module rather than by name, because a function is only
 * usable when the types in its signature can be named too. Narrowing further
 * means splitting those modules, not hiding names out of them.
 *
 * `packageExports.test.ts` holds the list. Adding a name to this surface is a
 * decision, so it fails until the list says so.
 */

export * from "./config/pharoMcpVersion.js";
export * from "./config/plexusHome.js";
export * from "./config/projectConfig.js";
export * from "./launcher/scopedPharoLauncherServer.js";
export * from "./lifecycle/projectClose.js";
export * from "./lifecycle/projectOpen.js";
export * from "./workspace/projectState.js";
