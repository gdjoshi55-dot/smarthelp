'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Search } from 'lucide-react';

/**
 * The hero's search box (§20.1).
 *
 * One input, and it answers two different questions depending on what was typed.
 * A word goes to the catalogue as `?q=`. Six digits is a pincode, which is
 * checked against the localities we serve — and here the client cannot do that
 * check, so it hands the pincode to the same catalogue search and lets the
 * server decide, rather than guessing from a list that is not in the browser.
 *
 * It submits to `/services` and never fetches from this component: the answer
 * page owns the fetch, so a shared link and a click produce the same thing.
 */

export function HeroSearch({
  coverage,
}: {
  coverage: { city: string; state: string; localities: string[] };
}) {
  const router = useRouter();
  const [value, setValue] = useState('');

  const placeholder = `Try "bathroom clean" or ${coverage.localities[0] ?? 'your area'}`;

  return (
    <form
      className="mt-8"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (!query) {
          router.push('/services');
          return;
        }
        // A pincode is a location, not a service: sending it as `area` is what
        // lets the server's own resolution decide whether we cover it.
        const isPincode = /^\d{6}$/.test(query);
        router.push(`/services${isPincode ? `?area=${query}` : `?q=${encodeURIComponent(query)}`}`);
      }}
    >
      <label htmlFor="hero-search" className="sr-only">
        Search for a service or enter your pincode
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            id="hero-search"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-9 pr-3 text-base text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <button
          type="submit"
          className="rounded-xl bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Search
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Serving {coverage.localities.length} localities across {coverage.city}, {coverage.state}.
      </p>
    </form>
  );
}
