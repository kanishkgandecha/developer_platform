import { describe, expect, it } from "vitest";
import { classifyFile } from "./classify.js";

function classify(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  return classifyFile(fileName, extension);
}

describe("classifyFile — source languages", () => {
  it.each([
    ["index.ts", "TypeScript"],
    ["component.tsx", "TypeScript"],
    ["script.js", "JavaScript"],
    ["app.jsx", "JavaScript"],
    ["main.py", "Python"],
    ["Main.java", "Java"],
    ["lib.cpp", "C++"],
    ["main.go", "Go"],
    ["lib.rs", "Rust"],
  ])("classifies %s as SOURCE (%s)", (fileName, language) => {
    const result = classify(fileName);
    expect(result.category).toBe("SOURCE");
    expect(result.isSource).toBe(true);
    expect(result.language).toBe(language);
  });
});

describe("classifyFile — non-source categories", () => {
  it("classifies README.md as DOCUMENTATION", () => {
    expect(classify("README.md").category).toBe("DOCUMENTATION");
  });

  it("classifies package.json as CONFIG, not generic DATA", () => {
    const result = classify("package.json");
    expect(result.category).toBe("CONFIG");
    expect(result.isSource).toBe(false);
  });

  it("classifies pnpm-lock.yaml as GENERATED", () => {
    expect(classify("pnpm-lock.yaml").category).toBe("GENERATED");
  });

  it("classifies a .png as BINARY", () => {
    const result = classify("logo.png");
    expect(result.category).toBe("BINARY");
    expect(result.isSource).toBe(false);
  });

  it("classifies a generic .json as DATA (not CONFIG, not matched by filename)", () => {
    expect(classify("data.json").category).toBe("DATA");
  });

  it("classifies bundle.min.js as GENERATED, not SOURCE", () => {
    expect(classify("bundle.min.js").category).toBe("GENERATED");
  });

  it("falls back to DATA (not SOURCE) for an unrecognized extension", () => {
    const result = classify("mystery.xyz123");
    expect(result.category).toBe("DATA");
    expect(result.isSource).toBe(false);
  });
});
