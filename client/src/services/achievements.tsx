/**
 * Monochrome achievement celebrations. Fired when a milestone is hit; the
 * toast is minimal and elegant — a circular badge, the title, and one line of
 * positive-reinforcement copy.
 */
import { toast } from "sonner";
import { ACHIEVEMENTS } from "./stats";

export function celebrate(ids: string[]): void {
  if (!ids.length) return;
  ids.slice(0, 3).forEach(id => {
    const achievement = ACHIEVEMENTS.find(a => a.id === id);
    if (!achievement) return;
    const Icon = achievement.icon;
    toast.custom(() => (
      <div className="pointer-events-none flex w-72 items-center gap-3 rounded-xl border border-white/10 bg-[#16161a]/95 p-3 shadow-2xl backdrop-blur">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-black ring-1 ring-white/20">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-white">
            {achievement.title}
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-[#9a9aa0]">
            {achievement.copy}
          </p>
        </div>
      </div>
    ), {
      duration: 4500,
    });
  });
}