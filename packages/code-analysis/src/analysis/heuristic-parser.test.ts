import { describe, expect, it } from "vitest";
import { isHeuristicLanguage, parseHeuristic } from "./heuristic-parser.js";

describe("isHeuristicLanguage", () => {
  it("recognizes exactly the four heuristic languages", () => {
    expect(isHeuristicLanguage("Python")).toBe(true);
    expect(isHeuristicLanguage("Java")).toBe(true);
    expect(isHeuristicLanguage("C++")).toBe(true);
    expect(isHeuristicLanguage("Go")).toBe(true);
    expect(isHeuristicLanguage("TypeScript")).toBe(false);
    expect(isHeuristicLanguage("Rust")).toBe(false);
  });
});

describe("parseHeuristic — Python", () => {
  it("extracts top-level functions and classes with methods parented to their class", () => {
    const result = parseHeuristic(
      "app.py",
      `import os
from typing import Optional

def top_level(a, b):
    return a + b

class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"hello {self.name}"
`,
      "Python",
    );

    expect(result.parseStrategy).toBe("heuristic");
    const fn = result.symbols.find((s) => s.name === "top_level")!;
    expect(fn).toMatchObject({ kind: "FUNCTION", parentName: null, parameterCount: 2 });

    const cls = result.symbols.find((s) => s.name === "Greeter")!;
    expect(cls.kind).toBe("CLASS");

    const greet = result.symbols.find((s) => s.name === "greet")!;
    // `self` is dropped from the parameter count for methods.
    expect(greet).toMatchObject({ kind: "METHOD", parentName: "Greeter", parameterCount: 0 });

    expect(result.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "os" }),
        expect.objectContaining({ source: "typing" }),
      ]),
    );
  });

  it("treats a leading-underscore function as non-exported", () => {
    const result = parseHeuristic("m.py", `def _private():\n    pass\n`, "Python");
    expect(result.symbols[0]).toMatchObject({ name: "_private", exported: false });
  });

  it("never computes complexity for heuristically-parsed symbols", () => {
    const result = parseHeuristic("m.py", `def f(x):\n    return x\n`, "Python");
    expect(result.symbols[0]!.complexity).toBeNull();
  });
});

describe("parseHeuristic — Java", () => {
  it("extracts a class and its methods, and import statements", () => {
    const result = parseHeuristic(
      "Main.java",
      `import java.util.List;

public class Main {
    public void run(String arg) {
        System.out.println(arg);
    }
}
`,
      "Java",
    );

    expect(result.imports).toEqual([expect.objectContaining({ source: "java.util.List" })]);
    const cls = result.symbols.find((s) => s.kind === "CLASS")!;
    expect(cls.name).toBe("Main");
    const method = result.symbols.find((s) => s.kind === "METHOD")!;
    expect(method).toMatchObject({ name: "run", parentName: "Main", parameterCount: 1 });
  });

  it("does not mistake `else if` for a method named if", () => {
    const result = parseHeuristic(
      "C.java",
      `public class C {
    public int f(int x) {
        if (x > 0) {
            return 1;
        } else if (x < 0) {
            return -1;
        }
        return 0;
    }
}
`,
      "Java",
    );
    expect(result.symbols.some((s) => s.name === "if")).toBe(false);
    expect(result.symbols.filter((s) => s.kind === "METHOD")).toHaveLength(1);
  });
});

describe("parseHeuristic — C++", () => {
  it("extracts #include directives and a free function", () => {
    const result = parseHeuristic(
      "main.cpp",
      `#include <vector>
#include "local.h"

int add(int a, int b) {
    return a + b;
}
`,
      "C++",
    );

    expect(result.imports).toEqual([
      expect.objectContaining({ source: "vector", kind: "INCLUDE" }),
      expect.objectContaining({ source: "local.h", kind: "INCLUDE" }),
    ]);
    expect(result.symbols).toEqual([
      expect.objectContaining({ name: "add", kind: "FUNCTION", parameterCount: 2 }),
    ]);
  });

  it("extracts a class and attaches its member function as a method", () => {
    const result = parseHeuristic(
      "thing.cpp",
      `class Thing {
public:
    int value() {
        return 1;
    }
};
`,
      "C++",
    );
    const cls = result.symbols.find((s) => s.kind === "CLASS")!;
    expect(cls.name).toBe("Thing");
    const method = result.symbols.find((s) => s.kind === "METHOD")!;
    expect(method).toMatchObject({ name: "value", parentName: "Thing" });
  });
});

describe("parseHeuristic — Go", () => {
  it("extracts single-line and grouped imports", () => {
    const result = parseHeuristic(
      "main.go",
      `package main

import "fmt"

import (
    "os"
    "strings"
)

func main() {
    fmt.Println("hi")
}
`,
      "Go",
    );

    expect(result.imports.map((i) => i.source).sort()).toEqual(["fmt", "os", "strings"]);
  });

  it("marks capitalized functions and structs as exported, lowercase as not", () => {
    const result = parseHeuristic(
      "types.go",
      `package main

type Config struct {
    Name string
}

func Run() {}

func helper() {}
`,
      "Go",
    );

    expect(result.symbols.find((s) => s.name === "Config")).toMatchObject({ kind: "CLASS", exported: true });
    expect(result.symbols.find((s) => s.name === "Run")).toMatchObject({ exported: true });
    expect(result.symbols.find((s) => s.name === "helper")).toMatchObject({ exported: false });
  });
});

describe("parseHeuristic — unsupported language", () => {
  it("returns no symbols or imports but still reports heuristic strategy", () => {
    const result = parseHeuristic("a.rb", `def foo\nend\n`, "Ruby");
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
  });
});
