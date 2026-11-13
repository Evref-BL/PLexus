/**
 * The MCP release PLexus loads into an image that is created without a
 * script.
 *
 * It is a module of its own because `pharo-agent` pins the same version and
 * checks across the package boundary that the two agree, and because the
 * release workflows read and rewrite it here.
 */
export const defaultPharoMcpVersion = "3.8.0";
