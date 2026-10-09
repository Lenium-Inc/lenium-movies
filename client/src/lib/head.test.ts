import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHeadTags, clearManagedHead } from "./head";
import { buildHeadTags, pageSeo } from "./seo";

/**
 * A minimal DOM, implementing only what `head.ts` touches.
 *
 * The test environment for this repo is `node` with no jsdom, and the alternative
 * -- installing a DOM implementation to test twenty lines of `createElement` --
 * is a dependency added for a test. What is actually worth testing here is the
 * applier's own logic: that a second call updates instead of appending, that a
 * removal detaches, and that nothing accumulates. Those are the bugs that
 * shipped before, and a hand-written fake is enough to pin them, provided it is
 * faithful about the one thing they depend on: `querySelector` reflects
 * attributes that were set and stops matching once a node is detached.
 *
 * Every method here is in the file because `head.ts` calls it. If that file grows
 * a new DOM call, this fake has to grow with it -- which is the intended signal.
 */

class FakeNode {
  attributes: Record<string, string> = {};
  parent: FakeNode | null = null;
  textContent = "";

  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }

  getAttribute(key: string) {
    return this.attributes[key] ?? null;
  }

  remove() {
    if (!this.parent) return;
    const siblings = this.parent.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parent = null;
  }

  children: FakeNode[] = [];
  appendChild(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /**
   * Supports exactly `tag[attr="value"]` and `[attr="value"]`, which are the two
   * shapes `head.ts` emits -- anything else throws rather than quietly matching
   * everything, so the fake cannot pass a test by being permissive.
   */
  querySelectorAll(selector: string): FakeNode[] {
    const withValue = /^(?:([a-z]+))?\[([a-z-]+)="([^"]*)"\]$/.exec(selector);
    const presence = /^(?:([a-z]+))?\[([a-z-]+)\]$/.exec(selector);
    const match = withValue ?? presence;
    if (!match) throw new Error(`fake DOM: unsupported selector ${selector}`);
    const [, tag, attribute, value] = match;
    const found: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        const tagMatches = !tag || (child as FakeElement).tagName === tag;
        // `value` is undefined for the presence form, which matches on the
        // attribute existing at all.
        const attrMatches =
          value === undefined
            ? child.getAttribute(attribute) !== null
            : child.getAttribute(attribute) === value;
        if (tagMatches && attrMatches) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
}

let headElement: FakeNode;
let originalDocument: typeof globalThis.document | undefined;

beforeEach(() => {
  headElement = new FakeNode();
  originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      title: "",
      head: headElement,
      createElement: (tag: string) => new FakeElement(tag),
    },
  });
});

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: originalDocument,
    });
  }
});

const ORIGIN = "https://vy.example";

const meta = (selector: string) =>
  headElement.querySelector(selector)?.getAttribute("content");
const count = (selector: string) =>
  headElement.querySelectorAll(selector).length;

describe("applyHeadTags", () => {
  it("writes a title and the description through the right attribute", () => {
    applyHeadTags(buildHeadTags(pageSeo("/"), ORIGIN));

    expect(document.title).toBe(pageSeo("/").title);
    // The regression that started all of this: `updateOrCreateMetaTag` was called
    // as ("description", content), so it created `<meta description="...">` --
    // an attribute no consumer reads -- and left `content` undefined.
    expect(count('meta[name="description"]')).toBe(1);
    expect(meta('meta[name="description"]')).toBe(pageSeo("/").description);
    // ...and the malformed shape it used to take is gone. Walk the tree rather
    // than invent a selector for it: `meta[description]` is not a query, it is
    // exactly the attribute mistake being asserted against.
    const strays = headElement.children
      .flatMap(function collect(node: FakeNode): FakeNode[] {
        return [node, ...node.children.flatMap(collect)];
      })
      .filter(node => node.getAttribute("description") !== null);
    expect(strays).toEqual([]);
  });

  it("is idempotent: applying the same page twice adds nothing", () => {
    const tags = buildHeadTags(pageSeo("/"), ORIGIN);
    applyHeadTags(tags);
    const first = headElement.children.length;

    applyHeadTags(tags);
    applyHeadTags(tags);

    // The old implementation appended a fresh ld+json <script> per call, so a
    // viewer moving between pages accumulated one stale schema block per visit.
    expect(headElement.children.length).toBe(first);
    expect(count('script[data-jsonld="site-jsonld"]')).toBe(0);
  });

  it("updates in place when the page changes", () => {
    applyHeadTags(buildHeadTags(pageSeo("/"), ORIGIN));
    applyHeadTags(buildHeadTags(pageSeo("/terms"), ORIGIN));

    expect(document.title).toBe("Terms of Service - Stream Vy");
    expect(meta('meta[name="description"]')).toContain("terms that apply");
    expect(count('meta[name="description"]')).toBe(1);
    expect(count('link[rel="canonical"]')).toBe(1);
  });

  it("removes a tag the next page does not have", () => {
    applyHeadTags(buildHeadTags(pageSeo("/watch/603"), ORIGIN));
    // A watch page must not advertise its og:image or description to a crawler.
    expect(count('meta[property="og:image"]')).toBe(0);
    expect(count('meta[name="description"]')).toBe(0);

    applyHeadTags(buildHeadTags(pageSeo("/"), ORIGIN));
    expect(count('meta[property="og:image"]')).toBe(1);

    // ...and back again, so the removal is not one-way.
    applyHeadTags(buildHeadTags(pageSeo("/my-list"), ORIGIN));
    expect(count('meta[property="og:image"]')).toBe(0);
  });

  it("sets a JSON-LD block's content rather than appending a new script", () => {
    applyHeadTags([
      { kind: "jsonld", id: "movie-jsonld", data: { name: "First" } },
    ]);
    applyHeadTags([
      { kind: "jsonld", id: "movie-jsonld", data: { name: "Second" } },
    ]);

    expect(count('script[data-jsonld="movie-jsonld"]')).toBe(1);
    const script = headElement.querySelector(
      'script[data-jsonld="movie-jsonld"]'
    ) as FakeElement;
    expect(script.tagName).toBe("script");
    expect(script.getAttribute("type")).toBe("application/ld+json");
    expect(JSON.parse(script.textContent)).toEqual({ name: "Second" });
  });

  it("detaches a removed JSON-LD block so it is not merely hidden", () => {
    applyHeadTags([
      { kind: "jsonld", id: "movie-jsonld", data: { name: "x" } },
    ]);
    applyHeadTags([{ kind: "removeJsonLd", id: "movie-jsonld" }]);
    expect(count('script[data-jsonld="movie-jsonld"]')).toBe(0);
  });

  it("marks everything it creates, so clearManagedHead can find all of it", () => {
    applyHeadTags(buildHeadTags(pageSeo("/"), ORIGIN));
    expect(count("[data-seo-managed]")).toBeGreaterThan(0);

    clearManagedHead();
    // Everything it owns is gone; the nodes it did not create are untouched.
    expect(
      headElement.children.filter(c => c.getAttribute("data-seo-managed"))
        .length
    ).toBe(0);
  });

  it("reports failure instead of throwing when there is no document", () => {
    delete (globalThis as { document?: unknown }).document;
    expect(applyHeadTags(buildHeadTags(pageSeo("/"), ORIGIN))).toBe(false);
  });
});
