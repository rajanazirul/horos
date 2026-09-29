import { describe, expect, test } from "vitest";
import { identityKeys, normaliseDomain, normaliseName } from "./identity.js";

describe("identity normalisation", () => {
  test.each([
    ["Acme Data, Inc.", "acme data"],
    ["  ACME   data  LLC ", "acme data"],
    ["Acme Data Corp. Ltd", "acme data"],
    ["Ａｃｍｅ GmbH", "acme"],
    ["Inc.", ""],
    ["Incorporated Things", "incorporated things"],
    ["Acme Data L.L.C.", "acme data"],
    ["Acme Co.", "acme"],
    ["Acme Data Company", "acme data"],
    ["Acme Corporation", "acme"],
    ["Acme Data Incorporated", "acme data"],
    ["Acme Limited", "acme"],
    ["Acme PLC", "acme"],
    ["Acme & Co", "acme"],
  ])("name %j → %j", (raw, want) => {
    expect(normaliseName(raw)).toBe(want);
  });

  test.each([
    ["WWW.Acme.Example.", "acme.example"],
    [" acme.example ", "acme.example"],
    ["sub.www.acme.example", "sub.www.acme.example"],
    ["https://www.acme.example/", "acme.example"],
    ["HTTP://Acme.Example:8443/path?q=1#frag", "acme.example"],
    ["acme.example/", "acme.example"],
    ["www.acme.example.:443", "acme.example"],
    ["acme.example?x=1", "acme.example"],
    ["acme.example#top", "acme.example"],
  ])("domain %j → %j", (raw, want) => {
    expect(normaliseDomain(raw)).toBe(want);
  });

  test("keys", () => {
    expect(identityKeys(undefined)).toEqual([]);
    expect(identityKeys({ name: "Acme, Inc.", domain: "www.acme.example", purpose: "x" })).toEqual([
      "name:acme",
      "domain:acme.example",
    ]);
    expect(identityKeys({ name: "LLC" })).toEqual([]);
  });
});
