import assert from "node:assert/strict";
import test from "node:test";
import { slugify } from "../dist/fs-utils.js";

test("slugify preserves naming semantics for separator runs and long input", () => {
  assert.equal(slugify(" --- Hello / WORLD ___ "), "hello-world");
  assert.equal(slugify("---"), "item");
  assert.equal(slugify("", "fallback"), "fallback");
  assert.equal(slugify("a".repeat(100)), "a".repeat(64));
  assert.equal(slugify(`a${"-".repeat(1_000_000)}b`), "a-b");
  assert.equal(slugify("-".repeat(1_000_000)), "item");
});
