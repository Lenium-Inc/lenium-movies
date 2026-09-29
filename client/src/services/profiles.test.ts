/**
 * Profile storage tests.
 *
 * The important ones are the crash tests: `getProfiles` used to check only that
 * the stored root was an array, so a record written by an older build -- one
 * with no `avatar`, or a `null` entry -- flowed straight into
 * `<img src={undefined}>` at the render sites. Every read now normalises, and
 * these assert it.
 *
 * The `updateStoredProfile` tests exist because editing a profile has to keep
 * two storage keys in agreement: the profile list *and* the active-profile
 * snapshot. If the snapshot is not updated the navbar keeps rendering the old
 * avatar until the next sign-in, which is invisible in localStorage tests and
 * obvious in the UI.
 */
import { beforeEach, describe, expect, it } from "vitest";
// Must be first: installs the `window` globals the modules below read at module scope.
import { clearStorage, stubStorage } from "@/lib/webStorageStub";
import { presetById } from "@/lib/avatars";
import {
  createAvatar,
  getActiveProfile,
  getProfiles,
  normalizeProfile,
  saveProfiles,
  setActiveProfile,
  updateStoredProfile,
  type ProfileData,
} from "./profiles";

const USER = "user-1";
const PROFILES_KEY = `lenium-profiles-${USER}`;
const ACTIVE_KEY = `lenium-active-profile-${USER}`;

function profile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    id: "p1",
    name: "Alex",
    avatar: "https://cdn.test/a.svg",
    avatarId: null,
    isKids: false,
    isLocked: false,
    ...overrides,
  };
}

describe("createAvatar", () => {
  it("uses a chosen preset over anything else", () => {
    const preset = presetById("female-lorelei-0");
    expect(preset).not.toBeNull();
    expect(createAvatar("Alex", false, preset)).toBe(preset!.url);
  });

  it("generates from the name when no preset is given", () => {
    expect(createAvatar("Alex")).toBe(createAvatar("Alex"));
  });

  it("gives kids profiles a different generated face", () => {
    expect(createAvatar("Sam", true)).not.toBe(createAvatar("Sam", false));
  });
});

describe("normalizeProfile", () => {
  it("fills in a generated avatar when none is stored", () => {
    const result = normalizeProfile({ id: "p1", name: "Kai" });
    expect(result?.avatar).toContain("https://api.dicebear.com/");
    // Required by the type, so callers can rely on it without a guard.
    expect(result?.avatar.length).toBeGreaterThan(0);
  });

  it("keeps a stored avatar url", () => {
    expect(normalizeProfile(profile())?.avatar).toBe("https://cdn.test/a.svg");
  });

  it("treats a blank avatar as missing", () => {
    expect(normalizeProfile({ id: "p1", name: "Kai", avatar: "   " })?.avatar)
      .toContain("dicebear");
  });

  it("adds avatarId: null when the field is absent", () => {
    expect(normalizeProfile({ id: "p1", name: "Kai" })?.avatarId).toBeNull();
  });

  it("resolves a known preset id in preference to the stored url", () => {
    const preset = presetById("male-micah-0")!;
    const result = normalizeProfile({
      id: "p1",
      name: "Kai",
      avatar: "https://stale.test/old.svg",
      avatarId: preset.id,
    });
    expect(result?.avatar).toBe(preset.url);
  });

  it("rejects entries with no usable id", () => {
    for (const input of [null, undefined, {}, { id: "" }, { id: "   " }, "x", 42, []]) {
      expect(normalizeProfile(input)).toBeNull();
    }
  });

  it("coerces missing booleans to false rather than leaving them undefined", () => {
    const result = normalizeProfile({ id: "p1", name: "Kai" });
    expect(result?.isKids).toBe(false);
    expect(result?.isLocked).toBe(false);
  });

  it("does not throw on a cyclic-looking object", () => {
    const input: Record<string, unknown> = { id: "p1", name: "Kai" };
    input.self = input;
    expect(() => normalizeProfile(input)).not.toThrow();
  });
});

describe("getProfiles", () => {
  beforeEach(() => clearStorage());

  it("returns an empty list when nothing is stored", () => {
    expect(getProfiles(USER)).toEqual([]);
  });

  it("round-trips a saved list", () => {
    const list = [profile(), profile({ id: "p2", name: "Robin" })];
    saveProfiles(USER, list);
    expect(getProfiles(USER)).toEqual(list);
  });

  it("survives syntactically invalid JSON", () => {
    stubStorage.setItem(PROFILES_KEY, "{not json");
    expect(getProfiles(USER)).toEqual([]);
  });

  it("survives a non-array root", () => {
    for (const raw of ["null", "123", '"hello"', "true", "{}"]) {
      stubStorage.setItem(PROFILES_KEY, raw);
      expect(getProfiles(USER), `raw=${raw}`).toEqual([]);
    }
  });

  it("drops null and non-object entries", () => {
    stubStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([null, 5, "x", [], profile()]),
    );
    const list = getProfiles(USER);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p1");
  });

  it("backfills an avatar on a record that predates the picker", () => {
    // Exactly what an older build wrote: no avatar field at all.
    stubStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([{ id: "p1", name: "Legacy", isKids: false, isLocked: false }]),
    );
    const [restored] = getProfiles(USER);
    expect(restored.avatar).toContain("dicebear");
    expect(restored.avatarId).toBeNull();
  });

  it("drops an entry with no id", () => {
    stubStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([{ name: "No id" }, profile()]),
    );
    expect(getProfiles(USER).map((p) => p.id)).toEqual(["p1"]);
  });

  it("keeps profiles isolated per user", () => {
    saveProfiles(USER, [profile()]);
    expect(getProfiles("other-user")).toEqual([]);
  });
});

describe("getActiveProfile", () => {
  beforeEach(() => clearStorage());

  it("returns null when nothing is stored", () => {
    expect(getActiveProfile(USER)).toBeNull();
  });

  it("round-trips a profile", () => {
    const p = profile();
    setActiveProfile(USER, p);
    expect(getActiveProfile(USER)).toEqual(p);
  });

  it("clears when set to null", () => {
    setActiveProfile(USER, profile());
    setActiveProfile(USER, null);
    expect(getActiveProfile(USER)).toBeNull();
  });

  it("survives a stored value that is not a profile", () => {
    // The old implementation returned whatever JSON.parse produced, so a stored
    // `"hello"` came back as a string that then blew up on `.avatar`.
    for (const raw of ["null", '"hello"', "42", "[]"]) {
      stubStorage.setItem(ACTIVE_KEY, raw);
      expect(getActiveProfile(USER), `raw=${raw}`).toBeNull();
    }
  });
});

describe("updateStoredProfile", () => {
  beforeEach(() => clearStorage());

  it("patches the named profile and leaves the rest alone", () => {
    saveProfiles(USER, [profile(), profile({ id: "p2", name: "Robin" })]);
    const updated = updateStoredProfile(USER, "p2", { name: "Robin B" });
    expect(updated?.name).toBe("Robin B");
    const list = getProfiles(USER);
    expect(list[0].name).toBe("Alex");
    expect(list[1].name).toBe("Robin B");
  });

  it("keeps the active-profile snapshot in step", () => {
    // Otherwise the navbar keeps showing the pre-edit avatar until re-signin.
    const p = profile();
    saveProfiles(USER, [p]);
    setActiveProfile(USER, p);
    updateStoredProfile(USER, "p1", { name: "Alex Renamed" });
    expect(getActiveProfile(USER)?.name).toBe("Alex Renamed");
  });

  it("does not touch the snapshot for a different active profile", () => {
    const a = profile({ id: "p1" });
    const b = profile({ id: "p2", name: "Robin" });
    saveProfiles(USER, [a, b]);
    setActiveProfile(USER, a);
    updateStoredProfile(USER, "p2", { name: "Robin B" });
    expect(getActiveProfile(USER)?.name).toBe("Alex");
  });

  it("applies a chosen preset to both fields", () => {
    const preset = presetById("neutral-bottts-0")!;
    saveProfiles(USER, [profile()]);
    setActiveProfile(USER, profile());
    const updated = updateStoredProfile(USER, "p1", {
      avatarId: preset.id,
      avatar: preset.url,
    });
    expect(updated?.avatarId).toBe(preset.id);
    expect(updated?.avatar).toBe(preset.url);
    expect(getActiveProfile(USER)?.avatar).toBe(preset.url);
  });

  it("regenerates the avatar when reset to auto with a new name", () => {
    // The url is derived from the name, so a rename has to recompute it.
    saveProfiles(USER, [profile({ avatarId: "female-lorelei-0" })]);
    const updated = updateStoredProfile(USER, "p1", {
      name: "Kai",
      avatarId: null,
    });
    expect(updated?.avatarId).toBeNull();
    expect(updated?.avatar).toBe(createAvatar("Kai", false));
  });

  it("returns null for an unknown id and writes nothing", () => {
    saveProfiles(USER, [profile()]);
    expect(updateStoredProfile(USER, "nope", { name: "x" })).toBeNull();
    expect(getProfiles(USER)[0].name).toBe("Alex");
  });
});
