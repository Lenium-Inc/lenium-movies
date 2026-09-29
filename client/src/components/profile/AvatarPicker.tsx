import { useCallback, useRef } from "react";
import { Check } from "lucide-react";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  presetsForCategory,
  type AvatarCategory,
  type AvatarPreset,
} from "@/lib/avatars";
import { cn } from "@/lib/utils";

interface AvatarPickerProps {
  /** Currently chosen preset id, or null when the avatar is generated. */
  value: string | null;
  onChange: (preset: AvatarPreset) => void;
  /**
   * Categories to show. Lets a kids profile offer a narrower, softer set rather
   * than the full library.
   */
  categories?: readonly AvatarCategory[];
  className?: string;
  /** Accessible name for the group of tiles. */
  label?: string;
}

/**
 * Categorised grid of avatar presets.
 *
 * Implemented as a single radio group rather than twenty-four independent
 * buttons. The options are mutually exclusive, so `role="radio"` plus arrow-key
 * navigation is what tells a screen reader that picking one deselects the
 * others, and it collapses what would otherwise be twenty-four tab stops into
 * one. That only works if the roving tabindex is maintained properly: exactly one
 * tile is tabbable, and arrow keys move both focus and selection within the
 * group, which is what a radio group is expected to do.
 *
 * The selected state is carried by a ring, a dimming layer, and a check badge,
 * so it never depends on colour alone.
 */
export function AvatarPicker({
  value,
  onChange,
  categories = CATEGORY_ORDER,
  className,
  label = "Choose an avatar",
}: AvatarPickerProps) {
  // Flat view of every rendered tile, so arrow keys traverse across category
  // boundaries in reading order rather than trapping at each heading.
  const flat = categories.flatMap((category) => presetsForCategory(category));
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());

  const focusTile = useCallback((id: string) => {
    tileRefs.current.get(id)?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = flat.length - 1;
      let next = -1;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = index === last ? 0 : index + 1;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = index === 0 ? last : index - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        default:
          return;
      }

      event.preventDefault();
      const target = flat[next];
      if (!target) return;
      // Selecting on arrow move rather than only on focus is standard radio
      // behaviour and keeps keyboard use to a single keypress per avatar.
      onChange(target);
      focusTile(target.id);
    },
    [flat, onChange, focusTile]
  );

  // When no preset is chosen there is no selected tile to make tabbable, so
  // fall back to the first one. Without this the entire group would be
  // unreachable by keyboard.
  const tabbableId = value ?? flat[0]?.id ?? null;

  let runningIndex = -1;

  return (
    <div className={cn("space-y-5", className)} role="radiogroup" aria-label={label}>
      {categories.map((category) => {
        const presets = presetsForCategory(category);
        if (presets.length === 0) return null;

        return (
          <section key={category}>
            <h4 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
              {CATEGORY_LABELS[category]}
            </h4>
            <div className="mt-2.5 grid grid-cols-4 gap-2.5 sm:grid-cols-6">
              {presets.map((preset) => {
                runningIndex += 1;
                const index = runningIndex;
                const selected = preset.id === value;

                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={preset.label}
                    onClick={() => onChange(preset)}
                    onKeyDown={event => handleKeyDown(event, index)}
                    tabIndex={preset.id === tabbableId ? 0 : -1}
                    ref={node => {
                      if (node) tileRefs.current.set(preset.id, node);
                      else tileRefs.current.delete(preset.id);
                    }}
                    className={cn(
                      "group relative aspect-square overflow-hidden rounded-xl ring-1 transition",
                      selected
                        ? "ring-2 ring-white"
                        : "ring-white/10 hover:ring-white/40",
                    )}
                  >
                    <img
                      src={preset.url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                    {selected ? (
                      <>
                        <span
                          aria-hidden
                          className="absolute inset-0 bg-black/25"
                        />
                        <span
                          aria-hidden
                          className="absolute bottom-1 right-1 grid h-4 w-4 place-items-center rounded-full bg-white text-black"
                        >
                          <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        </span>
                      </>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
