import { describe, expect, it } from "vitest";
import { INPUT_EXAMPLES } from "./examples";
import { parseGitHubInput } from "../sources/github";

describe("input examples", () => {
  it("each parses as the kind it claims to demonstrate", () => {
    for (const example of INPUT_EXAMPLES) {
      const parsed = parseGitHubInput(example.value);
      expect(parsed, `${example.value} should parse at all`).not.toBeNull();
      expect(parsed?.kind, `${example.value} should be a ${example.demonstrates}`).toBe(
        example.demonstrates,
      );
    }
  });

  it("teaches both readings of the single field", () => {
    const kinds = new Set(INPUT_EXAMPLES.map((example) => example.demonstrates));
    expect(kinds).toEqual(new Set(["repo", "user"]));
  });
});
