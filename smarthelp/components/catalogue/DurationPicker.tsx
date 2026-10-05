'use client';

import { durationLabel, formatPrice, priceForDuration, priceUnitLabel } from '@/lib/catalogue';
import type { DurationOption, ServiceSummary } from '@/lib/catalogue';

/**
 * The duration chips of §20.3.
 *
 * A radio group in everything but name: one choice, and arrow keys should move
 * along the row the way they would in any other radio group. `role="radiogroup"`
 * with the keyboard handling spelled out is what makes that true, and it is why
 * this is not a row of plain buttons — three buttons and a tab order is a
 * worse experience for the same markup.
 *
 * Each chip carries the price *for that duration*, not the headline rate. The
 * whole point of choosing two hours instead of one is seeing what two hours
 * costs, and a screen that only ever says "from ₹199" makes the choice blind.
 */

export function DurationPicker({
  service,
  minutes,
  options,
  onChange,
  disabled = false,
}: {
  service: ServiceSummary;
  minutes: number;
  options: DurationOption[];
  onChange: (minutes: number) => void;
  disabled?: boolean;
}) {
  const choices = options.length > 0 ? options.map((o) => o.minutes) : [service.minDurationMinutes];

  return (
    <div role="radiogroup" aria-label="Job length" className="flex flex-wrap gap-2">
      {choices.map((value) => {
        const option = options.find((o) => o.minutes === value) ?? null;
        const price = priceForDuration(service, value, option);
        const active = value === minutes;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = choices.indexOf(value);
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = choices[(index + step + choices.length) % choices.length];
              onChange(next);
              // The focus follows the selection, which is what a radio group
              // does: arrow keys change which one is checked.
              document
                .querySelector<HTMLButtonElement>(`[data-duration="${next}"]`)
                ?.focus();
            }}
            data-duration={value}
            className={`rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-60 ${
              active
                ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600'
                : 'border-gray-300 bg-white hover:border-blue-400'
            }`}
          >
            <span className="block font-medium text-gray-900">{durationLabel(value)}</span>
            <span className="block text-xs text-gray-600">
              {formatPrice(price)}
              {priceUnitLabel(service)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
