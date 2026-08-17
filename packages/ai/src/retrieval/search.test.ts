import { describe, expect, it } from "vitest";
import { lexicalScoreFor } from "./search.js";

describe("lexicalScoreFor", () => {
  it("returns null for a query with no scoreable tokens", () => {
    expect(lexicalScoreFor("???", "some content", null)).toBeNull();
    expect(lexicalScoreFor("", "some content", null)).toBeNull();
  });

  it("returns a high score (pinned >= 0.95) for an exact symbol name match", () => {
    const score = lexicalScoreFor("PatientDashboard", "export function unrelated() {}", "PatientDashboard");
    expect(score).toBeGreaterThanOrEqual(0.95);
  });

  it("returns partial coverage when only some query tokens are found", () => {
    const score = lexicalScoreFor("validate OAuth totallyMissingToken", "function validateOAuthState() {}", "validateOAuthState");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 when no tokens are found anywhere", () => {
    expect(lexicalScoreFor("zzzznotfound", "function widget() {}", "widget")).toBe(0);
  });

  it("matches on content even without a symbol name", () => {
    const score = lexicalScoreFor("session token", "const sessionToken = hashToken(raw);", null);
    expect(score).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    const score = lexicalScoreFor("PATIENTDASHBOARD", "function PatientDashboard() {}", "PatientDashboard");
    expect(score).toBeGreaterThanOrEqual(0.95);
  });
});
