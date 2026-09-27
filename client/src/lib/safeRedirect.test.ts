import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_AUTH_PATH,
  nextPathFromSearch,
  safeRedirectPath,
} from "./safeRedirect";

describe("safeRedirectPath", () => {
  it("keeps an internal path", () => {
    expect(safeRedirectPath("/list/share/abc123")).toBe("/list/share/abc123");
    expect(safeRedirectPath("/my-list")).toBe("/my-list");
    // Query and fragment are legitimate parts of a same-origin target.
    expect(safeRedirectPath("/watch/22980?type=movie")).toBe(
      "/watch/22980?type=movie"
    );
  });

  it("falls back when nothing was requested", () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeRedirectPath("")).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeRedirectPath("   ")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("refuses an absolute URL", () => {
    expect(safeRedirectPath("https://evil.test/steal")).toBe(
      DEFAULT_POST_AUTH_PATH
    );
    expect(safeRedirectPath("http://evil.test")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("refuses a javascript: payload", () => {
    expect(safeRedirectPath("javascript:alert(1)")).toBe(
      DEFAULT_POST_AUTH_PATH
    );
    // A leading slash does not make a scheme relative-looking string safe if
    // the scheme is smuggled in after it.
    expect(safeRedirectPath("/javascript:alert(1)")).toBe(
      "/javascript:alert(1)"
    );
  });

  it("refuses protocol-relative paths that would leave the origin", () => {
    // `//evil.test` and `/\evil.test` are both read as `https://evil.test`.
    expect(safeRedirectPath("//evil.test/steal")).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeRedirectPath("/\\evil.test/steal")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("refuses control characters used to smuggle a target past a check", () => {
    expect(safeRedirectPath("/\u0000/evil.test")).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeRedirectPath("/my-list\n//evil.test")).toBe(
      DEFAULT_POST_AUTH_PATH
    );
    expect(safeRedirectPath("/my-list\u007f")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("refuses a backslash that would normalise into a protocol-relative path", () => {
    expect(safeRedirectPath("/\\//evil.test")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("honours a custom fallback", () => {
    expect(safeRedirectPath("https://evil.test", "/")).toBe("/");
    expect(safeRedirectPath("/ok", "/")).toBe("/ok");
  });
});

describe("nextPathFromSearch", () => {
  it("reads next with or without the leading question mark", () => {
    expect(nextPathFromSearch("?next=/list/share/tok")).toBe("/list/share/tok");
    expect(nextPathFromSearch("next=/list/share/tok")).toBe("/list/share/tok");
  });

  it("returns the fallback for an absent or empty query", () => {
    expect(nextPathFromSearch("")).toBe(DEFAULT_POST_AUTH_PATH);
    expect(nextPathFromSearch("?")).toBe(DEFAULT_POST_AUTH_PATH);
    expect(nextPathFromSearch("?other=1")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("validates the decoded value", () => {
    // %2f%2fevil.test decodes to //evil.test, which must be rejected after
    // decoding rather than before it.
    expect(nextPathFromSearch("?next=%2F%2Fevil.test")).toBe(
      DEFAULT_POST_AUTH_PATH
    );
    expect(nextPathFromSearch("?next=https%3A%2F%2Fevil.test")).toBe(
      DEFAULT_POST_AUTH_PATH
    );
  });

  it("preserves a share token containing URL-significant characters", () => {
    // Tokens are `secrets.token_urlsafe`, so `-` and `_` must survive.
    expect(nextPathFromSearch("?next=/list/share/tPr-RbqKEq6C9pBV0")).toBe(
      "/list/share/tPr-RbqKEq6C9pBV0"
    );
  });
});
