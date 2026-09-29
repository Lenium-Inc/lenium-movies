/**
 * Embed-consent storage tests.
 *
 * These cover the *record* of the viewer's choice, not its effect on playback.
 * The player no longer consults this value: an embed is a normal way to play a
 * title, so gating it behind consent meant declining produced a dead stream.
 * What still has to hold is that the banner is honest about asking -- it needs
 * to distinguish "never asked" from "declined" to avoid nagging forever or
 * silently treating silence as a yes.
 *
 * The key stays part of the on-disk contract so an earlier build's stored value
 * is honoured rather than prompting again.
 */
import { beforeEach, describe, expect, it } from "vitest";
// Must be first: installs the `window` globals the modules below read at
// module scope.
import { clearStorage, stubStorage } from "@/lib/webStorageStub";
import { readEmbedConsent, setEmbedConsent } from "./lists";

const KEY = "freestream-consent-v1";

describe("embed consent record", () => {
  beforeEach(() => {
    clearStorage();
  });

  it("treats never-asked as undecided so the banner still appears", () => {
    expect(readEmbedConsent()).toBe("undecided");
  });

  it("records an explicit decline", () => {
    setEmbedConsent("essential");
    expect(readEmbedConsent()).toBe("essential");
  });

  it("records acceptance", () => {
    setEmbedConsent("accepted");
    expect(readEmbedConsent()).toBe("accepted");
  });

  it("lets a decline revoke a previous acceptance", () => {
    // Without this a viewer who accepted once could never withdraw, which is
    // the whole point of persisting the choice at all.
    setEmbedConsent("accepted");
    setEmbedConsent("essential");
    expect(readEmbedConsent()).toBe("essential");
  });

  it("reads a value written directly to storage", () => {
    stubStorage.setItem(KEY, "accepted");
    expect(readEmbedConsent()).toBe("accepted");
  });

  it("ignores an unrecognised stored value", () => {
    for (const raw of ["yes", "true", "1", "", "ACCEPTED"]) {
      stubStorage.setItem(KEY, raw);
      expect(readEmbedConsent(), `raw=${raw}`).toBe("undecided");
    }
  });
});
