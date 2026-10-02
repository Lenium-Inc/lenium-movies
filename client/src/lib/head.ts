/**
 * Applies `HeadTag` descriptors to `document.head`.
 *
 * This is the only file in the SEO path that touches the DOM, and it is
 * deliberately the least interesting one. Everything that can be decided --
 * which tags a page has, what goes in them, which of last page's tags have to be
 * taken back off -- is decided in `seo.ts` as pure data and tested there. What is
 * left here is `createElement`, `setAttribute` and `appendChild`, which are
 * framework-provided and were not the source of the bug that left a 2/3-aspect
 * card and a duplicate `<script>` behind for a year.
 *
 * The one behaviour worth stating is that it is idempotent and additive-free:
 * applying the same page twice produces the same head, and applying a new page
 * updates or removes what it names without accumulating stale nodes. The previous
 * implementation appended a fresh `<script type="application/ld+json">` on every
 * call, so a viewer moving between titles accumulated one stale schema block per
 * page visited.
 */

import type { HeadTag } from "@/lib/seo";

/** Marker attribute, so every node this module owns is identifiable and removable. */
const OWNED = "data-seo-managed";

/**
 * The document to write into.
 *
 * Resolved per call rather than captured at import: this module is imported by
 * the test suite and by any future prerender pass, neither of which has a
 * `document` at the time the module is first evaluated.
 */
function head(): HTMLHeadElement | null {
  if (typeof document === "undefined") return null;
  return document.head ?? null;
}

function findMeta(
  attribute: "name" | "property",
  key: string
): HTMLMetaElement | null {
  const parent = head();
  if (!parent) return null;
  return parent.querySelector(
    `meta[${attribute}="${cssEscape(key)}"]`
  ) as HTMLMetaElement | null;
}

/** A minimal CSS.escape, without requiring the CSSOM in a non-browser run. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function adopt(node: Element): void {
  node.setAttribute(OWNED, "true");
}

function upsertMeta(
  attribute: "name" | "property",
  key: string,
  content: string
): void {
  const parent = head();
  if (!parent) return;
  let node = findMeta(attribute, key);
  if (!node) {
    node = document.createElement("meta");
    node.setAttribute(attribute, key);
    adopt(node);
    parent.appendChild(node);
  }
  /*
   * `content` is the attribute, not a property on every engine's HTMLMetaElement
   * in older DOM implementations. setAttribute is the portable form and keeps
   * the serialised output identical to what the static head in index.html has.
   */
  node.setAttribute("content", content);
}

function removeMeta(attribute: "name" | "property", key: string): void {
  findMeta(attribute, key)?.remove();
}

function upsertLink(rel: string, href: string): void {
  const parent = head();
  if (!parent) return;
  let node = parent.querySelector(
    `link[rel="${cssEscape(rel)}"]`
  ) as HTMLLinkElement | null;
  if (!node) {
    node = document.createElement("link");
    node.setAttribute("rel", rel);
    adopt(node);
    parent.appendChild(node);
  }
  node.setAttribute("href", href);
}

function upsertJsonLd(id: string, data: unknown): void {
  const parent = head();
  if (!parent) return;
  let node = parent.querySelector(
    `script[data-jsonld="${cssEscape(id)}"]`
  ) as HTMLScriptElement | null;
  if (!node) {
    node = document.createElement("script");
    node.setAttribute("type", "application/ld+json");
    node.setAttribute("data-jsonld", id);
    adopt(node);
    parent.appendChild(node);
  }
  node.textContent = JSON.stringify(data);
}

function removeJsonLd(id: string): void {
  head()
    ?.querySelector(`script[data-jsonld="${cssEscape(id)}"]`)
    ?.remove();
}

/**
 * Write a page's tags.
 *
 * Returns whether anything was written, so a caller can tell "applied" from
 * "there was no DOM" without inspecting globals. Not throwing is deliberate: this
 * runs inside a route effect, and a failure to update a `<title>` is not worth
 * taking the page down for.
 */
export function applyHeadTags(tags: HeadTag[]): boolean {
  const parent = head();
  if (!parent) return false;

  for (const tag of tags) {
    switch (tag.kind) {
      case "title":
        document.title = tag.content;
        break;
      case "meta":
        upsertMeta(tag.attribute, tag.key, tag.content);
        break;
      case "removeMeta":
        removeMeta(tag.attribute, tag.key);
        break;
      case "link":
        upsertLink(tag.rel, tag.href);
        break;
      case "jsonld":
        upsertJsonLd(tag.id, tag.data);
        break;
      case "removeJsonLd":
        removeJsonLd(tag.id);
        break;
    }
  }
  return true;
}

/**
 * Strip every tag this module owns from the head.
 *
 * Only used by tests and by a future client-side navigation teardown. It matches
 * on the marker attribute rather than on a list of known keys, so a tag added
 * here later cannot be left behind by an older caller that never knew its name.
 */
export function clearManagedHead(): void {
  const parent = head();
  if (!parent) return;
  for (const node of Array.from(parent.querySelectorAll(`[${OWNED}]`))) {
    node.remove();
  }
}

export type { HeadTag };
