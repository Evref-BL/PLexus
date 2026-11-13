import fs from "node:fs";

// The manifest is outside the compiled root, so it is read, not imported.
// Source and build both sit one directory below it.
export const plexusVersion: string = (
  JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
