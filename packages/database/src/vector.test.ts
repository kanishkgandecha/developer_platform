import { describe, expect, it } from "vitest";
import { toVectorLiteral } from "./vector.js";

describe("toVectorLiteral", () => {
  it("formats a vector as pgvector's bracketed comma-separated literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });

  it("formats an empty vector", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });

  it("rejects NaN", () => {
    expect(() => toVectorLiteral([0.1, Number.NaN])).toThrow();
  });

  it("rejects Infinity", () => {
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow();
    expect(() => toVectorLiteral([Number.NEGATIVE_INFINITY])).toThrow();
  });
});
