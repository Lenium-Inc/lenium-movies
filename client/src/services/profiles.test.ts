/**
 * Profile translation tests.
 *
 * Profiles are server rows now, but the render layer still speaks
 * `ProfileData`. This file covers the boundary between the two, which is where
 * a field can silently become `undefined` and reach an `<img src>`.
 *
 * The previous version of this file tested a localStorage store that no longer
 * exists. What replaced it matters more than what it removed: there is no
 * longer a second copy of the profiles that can drift from the server, so the
 * crash cases worth pinning down are the ones where a *server* row is missing,
 * blank or differently typed than the render layer expects -- a row written by
 * an older backend, a numeric SQLite id, a PIN-only row with no avatar.
 */
import { describe, expect, it } from "vitest";
import { presetById } from "@/lib/avatars";
import {
  createAvatar,
  normalizeProfile,
  toProfileData,
  type ProfileData,
} from "./profiles";
import type { ApiProfile } from "@/services/auth";

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

function apiProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: "p1",
    name: "Alex",
    avatar: "https://cdn.test/a.svg",
    avatar_id: null,
    is_kids: false,
    is_locked: false,
    sort_order: 0,
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

  /**
   * SQLite hands back integer primary keys and Postgres hands back UUIDs, and
   * the same client has to handle both. A numeric id that reached a caller as a
   * number would fail every `p.id === selectedId` string comparison and quietly
   * make the profile switcher do nothing.
   */
  it("stringifies a numeric id", () => {
    expect(normalizeProfile({ id: 7, name: "Rowan" })?.id).toBe("7");
  });

  it("accepts the server's snake_case field names", () => {
    const result = normalizeProfile({
      id: "p9",
      name: "Kai",
      is_kids: true,
      is_locked: true,
      avatar_id: "male-micah-0",
    });
    expect(result?.isKids).toBe(true);
    expect(result?.isLocked).toBe(true);
    expect(result?.avatarId).toBe("male-micah-0");
  });
});

describe("toProfileData", () => {
  it("maps every server field onto the render shape", () => {
    const result = toProfileData(
      apiProfile({
        id: "p2",
        name: "Robin",
        is_kids: true,
        is_locked: true,
        avatar_id: "neutral-bottts-0",
      })
    );
    expect(result).toEqual<ProfileData>({
      id: "p2",
      name: "Robin",
      avatar: presetById("neutral-bottts-0")!.url,
      avatarId: "neutral-bottts-0",
      isKids: true,
      isLocked: true,
    });
  });

  it("never loses a row", () => {
    // A translation layer that could return null would silently drop a profile
    // from the switcher, which is the failure this guards against.
    const result = toProfileData(apiProfile({ id: "p3", name: "" }));
    expect(result.id).toBe("p3");
    expect(result.avatar).toContain("http");
  });

  it("keeps a stored url when no preset was chosen", () => {
    expect(toProfileData(apiProfile()).avatar).toBe("https://cdn.test/a.svg");
  });

  it("regenerates a blank avatar rather than rendering an empty src", () => {
    const result = toProfileData(apiProfile({ avatar: "   ", name: "Kai" }));
    expect(result.avatar).toContain("dicebear");
  });

  it("stringifies a numeric id so string comparisons work", () => {
    // SQLite profile ids are integers; the switcher compares with `===`
    // against a value read out of storage, which is always a string.
    const result = toProfileData(apiProfile({ id: 4 as unknown as string }));
    expect(result.id).toBe("4");
  });

  it("falls back to a generated avatar for an unusable row", () => {
    // Exercises the `?? createAvatar(...)` branch rather than relying on
    // `normalizeProfile` never failing for a row we just validated.
    const broken = { id: "", name: "Kai" } as unknown as ApiProfile;
    const result = toProfileData(broken);
    expect(result.name).toBe("Kai");
    expect(result.avatar).toContain("dicebear");
  });
});
