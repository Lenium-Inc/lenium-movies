/**
 * Makes the compiled stylesheet survive WebViews without cascade layers.
 *
 * The problem
 * -----------
 * Tailwind CSS v4 authors its entire output inside native cascade layers:
 *
 *     @layer theme { ... } @layer base { ... } @layer utilities { ... }
 *
 * Cascade layers shipped in Chromium 99, Firefox 97 and Safari 15.4. Every
 * browser that predates them treats `@layer name { ... }` as an unknown
 * at-rule and drops the whole block -- not just a declaration, the entire
 * block. In this stylesheet that is essentially all of it: Tailwind's
 * preflight, every utility, and the app's own `@layer components` surfaces
 * (`.sv-shell`, `.sv-chrome`, the buttons) are all layered, so a visitor on
 * an un-updated Android WebView -- exactly the 2020-2021 Huawei devices this
 * project already targets with `build.target: chrome87`, whose WebViews
 * update through AppGallery rather than Play -- received the page's bare
 * HTML with almost no styling at all. The `@supports not (color: oklch())`
 * palette fallback in `index.css` could not help, because the fallback itself
 * sits inside a layer the same browser discarded.
 *
 * JavaScript is transpiled to chrome87, but no CSS tool in the chain can
 * lower `@layer`: esbuild and Lightning CSS both leave it untouched (cascade
 * order cannot be expressed without the feature), and Tailwind v4 has no
 * option to emit unlayered output.
 *
 * The fix
 * -------
 * Flatten the layers after compilation. `@layer name { rules }` becomes
 * `rules`, and a bare `@layer a, b, c;` ordering statement is deleted. The
 * blocks are expanded in place, so document order is preserved: theme, base,
 * components, utilities, then the unlayered custom rules from `index.css`,
 * which is the same order the layers already resolved ties by. Specificity
 * decides everything else, exactly as it did in the Tailwind v3 world every
 * pre-layer browser was built for.
 *
 * Two things are deliberately left alone:
 *
 * - `@supports` and `@media` blocks keep their nested structure, including
 *   Tailwind's `@layer properties` fallback that hands older engines the
 *   initial values of its `--tw-*` custom properties.
 * - `@property` rules, which Chromium 85+ understands and the chrome87 floor
 *   already covers.
 *
 * The scan is a character-level pass rather than a regex, so it survives
 * minified CSS, comments, quoted strings containing braces, and nested
 * at-rules.
 */

import type { Plugin } from "vite";

/**
 * Replace every cascade layer in `css` with its contents.
 *
 * Exported separately from the plugin so it can be tested without running a
 * build -- the same reason `seoOriginPlugin` exports its renderers.
 */
export function flattenCssLayers(css: string): string {
  let out = "";
  let i = 0;
  const n = css.length;

  while (i < n) {
    const ch = css[i];

    // Comments pass through untouched; a `@layer` inside one is prose.
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "@" && css.startsWith("@layer", i)) {
      const next = css[i + 6];
      // Guard against a longer at-rule that merely starts the same way.
      if (next === undefined || next === "{" || /\s/.test(next)) {
        // Walk the prelude to the `;` of an ordering statement or the `{` of
        // a block, skipping comments so one cannot end the search early.
        let j = i + 6;
        while (j < n && css[j] !== ";" && css[j] !== "{") {
          if (css[j] === "/" && css[j + 1] === "*") {
            const end = css.indexOf("*/", j + 2);
            if (end === -1) {
              j = n;
              break;
            }
            j = end + 2;
            continue;
          }
          j += 1;
        }

        // `@layer a, b;` -- the ordering statement. It does nothing once no
        // blocks remain, so it is dropped.
        if (css[j] === ";") {
          i = j + 1;
          continue;
        }

        // `@layer name { ... }` -- find the matching close brace, minding
        // comments and quoted strings, then splice the body in its place.
        if (css[j] === "{") {
          let depth = 0;
          let k = j;
          while (k < n) {
            const c = css[k];
            if (c === "/" && css[k + 1] === "*") {
              const end = css.indexOf("*/", k + 2);
              if (end === -1) break;
              k = end + 2;
              continue;
            }
            if (c === '"' || c === "'") {
              k += 1;
              while (k < n && css[k] !== c) {
                if (css[k] === "\\") k += 1;
                k += 1;
              }
            } else if (c === "{") {
              depth += 1;
            } else if (c === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
            k += 1;
          }
          const inner = css.slice(j + 1, k);
          out += flattenCssLayers(inner);
          i = k + 1;
          continue;
        }

        // Unterminated at-rule; keep the text as-is rather than eat the file.
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Flatten layers in the emitted stylesheet, in dev and at build time.
 *
 * In dev the hook mirrors the build so what a developer sees locally is the
 * cascade a phone will actually receive, instead of two subtly different
 * stylesheets.
 */
export function flattenCssLayersPlugin(): Plugin {
  return {
    name: "streamvy:flatten-css-layers",
    /*
     * Deliberately a normal plugin, not `enforce: "post"`.
     *
     * Plugin order inside the normal group follows the config's array order,
     * and this plugin is registered after `tailwindcss()`. So in both dev and
     * build the hook receives Tailwind's compiled stylesheet and hands it on
     * to Vite's own CSS pipeline. As a post plugin it would instead be handed
     * the CSS *after* `vite:css` has wrapped it in a JS module for HMR in dev,
     * and the flattening scan would then be running over JavaScript.
     */
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      if (!code.includes("@layer")) return null;
      return { code: flattenCssLayers(code), map: null };
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const source =
          typeof file.source === "string"
            ? file.source
            : Buffer.from(file.source).toString("utf8");
        file.source = flattenCssLayers(source);
      }
    },
  };
}
