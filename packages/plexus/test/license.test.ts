import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(path.dirname(packageRoot));
const read = (file: string) => fs.readFileSync(file, "utf8");

// npm ships the package directory's LICENSE and GitHub reads the
// repository's; both find the licence by its text, not by package.json.
it("ships the full text of the licence it declares, in the package and the repository", () => {
  expect(JSON.parse(read(path.join(packageRoot, "package.json"))).license).toBe("Apache-2.0");
  const license = read(path.join(packageRoot, "LICENSE"));
  expect(license).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004/);
  expect(license).toContain("9. Accepting Warranty or Additional Liability.");
  expect(license).toContain("END OF TERMS AND CONDITIONS");
  expect(read(path.join(repositoryRoot, "LICENSE"))).toBe(license);
});
