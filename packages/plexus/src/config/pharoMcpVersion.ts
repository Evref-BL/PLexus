/**
 * The Pharo MCP version PLexus loads into an image unless a project says
 * otherwise.
 *
 * It lives in a module of its own because it is the one thing a consumer
 * checks across the package boundary: `pharo-agent` pins the same version and
 * has a test that the two agree. The script generator that uses it is an
 * internal, and nothing about publishing this should drag that along.
 */
export const defaultPharoMcpVersion = "3.6.0";
