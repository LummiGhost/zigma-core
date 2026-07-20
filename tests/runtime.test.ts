import { describe, expect, it } from "vitest";
import { stableHash } from "../src/application/runtime.js";

describe("stableHash", () => {
  it("is key-order independent and includes nested values", () => {
    const left = { actor: { id: "alice", type: "user" }, constraints: { repositories: ["a"] } };
    const reordered = { constraints: { repositories: ["a"] }, actor: { type: "user", id: "alice" } };
    const changed = { constraints: { repositories: ["b"] }, actor: { type: "user", id: "alice" } };

    expect(stableHash(left)).toBe(stableHash(reordered));
    expect(stableHash(left)).not.toBe(stableHash(changed));
  });
});
