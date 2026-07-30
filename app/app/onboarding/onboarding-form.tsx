"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { createHouse, type HouseFormState } from "@/app/_actions/house";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The first screen an owner ever fills in. Three fields, one button.
 *
 * The values are held in state rather than left to the DOM: React clears an
 * uncontrolled form once its action settles, and having your typing wiped
 * because the town was too long is a small betrayal we can simply not commit.
 */
type FieldName = "name" | "town" | "country";

const FIELDS: {
  name: FieldName;
  label: string;
  placeholder: string;
  autoComplete: string;
  hint?: string;
}[] = [
  {
    name: "name",
    label: "House name",
    placeholder: "The Çeşme house",
    autoComplete: "off",
  },
  {
    name: "town",
    label: "Town",
    placeholder: "Çeşme",
    autoComplete: "address-level2",
    hint: "Guests see the town. The address stays private until you approve them.",
  },
  {
    name: "country",
    label: "Country",
    placeholder: "Turkey",
    autoComplete: "country-name",
  },
];

export function OnboardingForm() {
  const baseId = useId();
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({});

  const [state, formAction, pending] = useActionState<HouseFormState, FormData>(
    createHouse,
    null,
  );
  const [values, setValues] = useState<Record<FieldName, string>>({
    name: "",
    town: "",
    country: "",
  });

  // An error stands until the person starts fixing it, then gets out of the way.
  // Holding the dismissed result rather than a flag means the next submission
  // brings its own object, and its message shows without anything to reset.
  const [dismissed, setDismissed] = useState<HouseFormState>(null);

  useEffect(() => {
    if (!state || state.ok) return;
    // Put the cursor where the problem is, so the fix is one tap away.
    const field = state.field;
    if (field === "name" || field === "town" || field === "country") {
      inputs.current[field]?.focus();
    }
  }, [state]);

  const failed = state && !state.ok && dismissed !== state ? state : null;
  const formError = failed && !failed.field ? failed.error : null;

  return (
    <form action={formAction} noValidate className="flex flex-col gap-6">
      <div className="flex flex-col gap-5">
        {FIELDS.map((field) => {
          const fieldId = `${baseId}-${field.name}`;
          const errorId = `${fieldId}-error`;
          const hintId = `${fieldId}-hint`;
          const error = failed?.field === field.name ? failed.error : null;

          return (
            <div key={field.name} className="flex flex-col gap-2">
              <Label htmlFor={fieldId}>{field.label}</Label>
              <Input
                id={fieldId}
                ref={(node) => {
                  inputs.current[field.name] = node;
                }}
                name={field.name}
                value={values[field.name]}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((current) => ({ ...current, [field.name]: next }));
                  setDismissed(state);
                }}
                placeholder={field.placeholder}
                autoComplete={field.autoComplete}
                autoCapitalize="words"
                spellCheck={false}
                required
                disabled={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error ? errorId : field.hint ? hintId : undefined
                }
                className="h-11 text-base"
              />
              {error ? (
                <p id={errorId} role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : field.hint ? (
                <p id={hintId} className="text-xs text-muted-foreground">
                  {field.hint}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button type="submit" disabled={pending} className="h-11 w-full">
          {pending ? "Creating the house…" : "Create the house"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Everything else has a sensible default — how long people can stay, the
          season, the language your guests read. Change any of it in settings.
        </p>
      </div>
    </form>
  );
}
