/**
 * Embed-consent tests.
 *
 * The point of these is that "essential only" has to be a *real* option. A
 * consent banner that records a choice nobody honours is worse than no banner,
 * so `hasEmbedConsent` is the gate the player consults before loading any
 * third-party frame, and it has to return false for both "essential" and
 * "never asked" -- declining and not-yet-asked are the same thing to the
 * embed, which is the conservative reading.
 */
import { beforeEach, describe, expect, it } from "vitest";
// Must be first: installs the `window` globals the modules below read at
// module scope.
import { clearStorage, stubStorage } from "@/lib/webStorageStub";
import { hasEmbedConsent, readEmbedConsent, setEmbedConsent } from "./lists";

const KEY = "freestream-consent-v1";

describe("embed consent", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("treats never-asked as undecided and blocks embeds", () => {
    expect(readEmbedConsent()).toBe("undecided");
    expect(hasEmbedConsent()).toBe(false);
  });

  it("blocks embeds after an explicit decline", () => {
    setEmbedConsent("essential");
    expect(readEmbedConsent()).toBe("essential");
    expect(hasEmbedConsent()).toBe(false);
  });

  it("allows embeds after acceptance", () => {
    setEmbedConsent("accepted");
    expect(readEmbedConsent()).toBe("accepted");
    expect(hasEmbedConsent()).toBe(true);
  });

  it("lets a decline revoke a previous acceptance", () => {
    // Without this a viewer who accepted once could never withdraw, which is
    // the whole point of persisting the choice at all.
    setEmbedConsent("accepted");
    expect(hasEmbedConsent()).toBe(true);
    setEmbedConsent("essential");
    expect(hasEmbedConsent()).toBe(false);
  });

  it("reads a value written directly to storage", () => {
    // The key is part of the on-disk contract, so a value set by an earlier
    // build (or by hand in devtools) has to be honoured rather than ignored.
    stubStorage.setItem(KEY, "accepted");
    expect(hasEmbedConsent()).toBe(true);
  });

  it("ignores an unrecognised stored value", () => {
    for (const raw of ["yes", "true", "1", "", "ACCEPTED"]) {
      stubStorage.setItem(KEY, raw);
      expect(readEmbedConsent(), `raw=${raw}`).toBe("undecided");
      expect(hasEmbedConsent(), `raw=${raw}`).toBe(false);
    }
  });
});
