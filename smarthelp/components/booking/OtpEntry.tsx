'use client';

import { useCallback, useRef, useState, type ElementRef } from 'react';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { PLATFORM_DEFAULTS } from '@/lib/constants';

/**
 * The four digits that start a job (§20.6, §22.3, Interaction Contract 7).
 *
 * This component is deliberately dumb about *where* the code goes: it hands the
 * typed digits to `onSubmit`, and decides the three things a person feels — the
 * field is disabled while the round trip runs, a wrong code clears every slot
 * and puts the cursor back at the first one, and the button never pretends a
 * half-typed code is submittable. It holds no code, logs no code, and never
 * pre-fills: the code exists only in the customer's head and in this input's
 * own state for the seconds it takes to type it.
 *
 * Auto-submit on the fourth digit is intentional. The professional is standing
 * at a door with one hand free; making them find a button for a value they
 * finished typing is a step that exists only for the code's sake.
 */
export function OtpEntry({
  onSubmit,
  disabled = false,
  helperText,
}: {
  onSubmit: (code: string) => Promise<boolean>;
  disabled?: boolean;
  helperText?: string | null;
}) {
  const length = PLATFORM_DEFAULTS.serviceOtpLength;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<ElementRef<typeof InputOTP>>(null);
  const inFlight = useRef(false);

  const submit = useCallback(
    async (code: string) => {
      if (inFlight.current || disabled || code.length !== length) return;
      inFlight.current = true;
      setBusy(true);
      let accepted = false;
      try {
        accepted = await onSubmit(code);
      } catch {
        accepted = false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
      if (!accepted) {
        setValue('');
        // Wait for the controlled value to land before asking for focus, or the
        // slot the digits were cleared from takes the caret back.
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    },
    [disabled, length, onSubmit]
  );

  const complete = value.length === length;

  return (
    <div className="space-y-3">
      <InputOTP
        ref={inputRef}
        maxLength={length}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        aria-label={`Service start code, ${length} digits`}
        value={value}
        onChange={(next) => {
          setValue(next);
          if (next.length === length) void submit(next);
        }}
        disabled={disabled || busy}
        className="justify-start"
      >
        <InputOTPGroup>
          {Array.from({ length }, (_, index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void submit(value)}
          disabled={disabled || busy || !complete}
          aria-busy={busy}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          {busy ? (
            <>
              <LoadingSpinner size="sm" />
              Starting…
            </>
          ) : (
            'Start job'
          )}
        </button>
        {helperText ? <p className="text-sm text-amber-700">{helperText}</p> : null}
      </div>
    </div>
  );
}
