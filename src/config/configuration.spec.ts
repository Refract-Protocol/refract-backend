import { parseFrontendOrigins } from "./configuration";

describe("parseFrontendOrigins", () => {
  it("parses and deduplicates a comma-separated exact-origin allowlist", () => {
    expect(parseFrontendOrigins("https://app.example.com, https://staging.example.com,https://app.example.com")).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
    ]);
  });

  it.each([
    "",
    "https://app.example.com/path",
    "https://*.example.com",
    "ftp://app.example.com",
    "https://user:password@app.example.com",
  ])("rejects unsafe or malformed origin configuration: %s", (value) => {
    expect(() => parseFrontendOrigins(value)).toThrow();
  });
});
