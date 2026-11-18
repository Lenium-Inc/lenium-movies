import { describe, expect, it } from "vitest";
import { flattenCssLayers } from "./flattenCssLayers";

describe("flattenCssLayers", () => {
  it("expands a layer block in place", () => {
    const css = "@layer utilities{.flex{display:flex}.hidden{display:none}}";
    expect(flattenCssLayers(css)).toBe(".flex{display:flex}.hidden{display:none}");
  });

  it("drops the bare layer-ordering statement", () => {
    const css = "@layer theme,base,components,utilities;@layer base{h1{margin:0}}";
    expect(flattenCssLayers(css)).toBe("h1{margin:0}");
  });

  it("flattens every layer of the tailwind output shape, in order", () => {
    const css = [
      "@layer properties{:root{--accent:#c23b2e}}",
      "@layer theme{:root{--color-red:#f00}}",
      "@layer base{*,::before{box-sizing:border-box}}",
      "@layer components{.sv-shell{position:relative}}",
      "@layer utilities{.flex{display:flex}}",
      ":focus-visible{outline:2px solid #fff}",
    ].join("");
    expect(flattenCssLayers(css)).toBe(
      ":root{--accent:#c23b2e}:root{--color-red:#f00}*,::before{box-sizing:border-box}.sv-shell{position:relative}.flex{display:flex}:focus-visible{outline:2px solid #fff}"
    );
  });

  it("keeps nested at-rules inside a flattened layer", () => {
    const css =
      "@layer utilities{@media (min-width:640px){.sm\\:flex{display:flex}}@supports (display:grid){.grid{display:grid}}}";
    expect(flattenCssLayers(css)).toBe(
      "@media (min-width:640px){.sm\\:flex{display:flex}}@supports (display:grid){.grid{display:grid}}"
    );
  });

  it("flattens nested layers recursively", () => {
    const css = "@layer a{@layer b{.x{color:red}}.y{color:blue}}";
    expect(flattenCssLayers(css)).toBe(".x{color:red}.y{color:blue}");
  });

  it("leaves content outside layers untouched", () => {
    const css = "body{margin:0}@layer base{a{color:inherit}}.ln-field input{outline:none}";
    expect(flattenCssLayers(css)).toBe(
      "body{margin:0}a{color:inherit}.ln-field input{outline:none}"
    );
  });

  it("ignores @layer mentioned in a comment", () => {
    const css = "/* use @layer utilities{never} here */.a{color:red}";
    expect(flattenCssLayers(css)).toBe(css);
  });

  it("ignores an at-rule that only starts like @layer", () => {
    const css = "@layering-note{.a{color:red}}";
    expect(flattenCssLayers(css)).toBe(css);
  });

  it("survives braces inside quoted strings", () => {
    const css = '@layer base{a::after{content:"{ not a block }"}}';
    expect(flattenCssLayers(css)).toBe('a::after{content:"{ not a block }"}');
  });

  it("passes an empty string through", () => {
    expect(flattenCssLayers("")).toBe("");
  });
});
