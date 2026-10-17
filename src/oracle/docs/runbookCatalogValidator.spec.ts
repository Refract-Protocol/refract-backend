import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRunbookMarkdownContent } from "./runbookCatalogValidator.ts";

test("docs/oracle-trust-architecture-and-runbooks.md contains all required runbooks and source inventory feeds", () => {
  const md = readFileSync(
    new URL(
      "../../../docs/oracle-trust-architecture-and-runbooks.md",
      import.meta.url
    ),
    "utf8"
  );

  const check = validateRunbookMarkdownContent(md);
  assert.equal(check.valid, true);
  assert.deepEqual(check.missingScenarios, []);
  assert.deepEqual(check.missingFeeds, []);
});
