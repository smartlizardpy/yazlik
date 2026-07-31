/**
 * The circles at the top of a stepped flow.
 *
 * Two flows in this product ask a person a short sequence of questions — a
 * guest asking for a week, and an owner setting their house up for the first
 * time — and they must look like the same idea, because they *are* the same
 * idea. That is why this is a component and not four spans inlined twice.
 *
 * ### Three states, two shapes
 *
 * Done and current are both **filled ink**; upcoming is an **outline**. What
 * separates "you are here" from "you have been here" is not another colour —
 * this product has no accent hue — it is width: the current step is a pill,
 * every other step is a dot. The same trick the calendar uses for its four day
 * states, and it survives greyscale for the same reason.
 *
 * ### Silent by default
 *
 * The dots are `aria-hidden`. A screen reader that read out "circle circle
 * circle" would be worse than nothing. Pass `label` — "Step 2 of 4" — and the
 * group gets that as its accessible name instead, which is the whole content.
 * Progress is a picture, not a control: there is nothing here to tap. The Back
 * and Next pair underneath is what moves the flow, and it is the only thing
 * that should.
 */

import { cn } from "@/lib/utils";

export type StepDotsProps = {
  /** How many steps the flow has. */
  total: number;
  /** Which one is on screen, **0-based**. */
  current: number;
  /**
   * The accessible name for the whole group — "Step 2 of 4", already written
   * in the reader's language. Without it the dots stay purely decorative.
   */
  label?: string;
  className?: string;
};

export function StepDots({ total, current, label, className }: StepDotsProps) {
  return (
    <div
      // `group` rather than a list: it is one indicator, not a set of items
      // somebody might want to navigate through.
      role="group"
      aria-label={label}
      className={cn("flex items-center gap-1.5", className)}
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "h-2 rounded-full transition-all",
            index === current
              ? "w-6 bg-foreground"
              : index < current
                ? "w-2 bg-foreground"
                : // Outline, not a pale fill: a step you have not reached is
                  // an empty circle, which is what an empty circle means.
                  "w-2 border border-foreground/35",
          )}
        />
      ))}
    </div>
  );
}
