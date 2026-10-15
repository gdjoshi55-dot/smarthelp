'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Star, Trash2, Wrench } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/catalogue/EmptyState';
import {
  fetchFavourites,
  removeFavourite,
  type FavouriteItem,
} from '@/lib/favouriteClient';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function FavouritesView() {
  const [items, setItems] = useState<FavouriteItem[] | null>(null);
  const [error, setError] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchFavourites()
      .then((res) => setItems(res.favourites))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(item: FavouriteItem) {
    setRemovingId(item.id);
    try {
      await removeFavourite(item.targetType, item.targetId);
      setItems((current) => (current ? current.filter((f) => f.id !== item.id) : current));
    } catch {
      toast.error('We could not remove that favourite.');
    } finally {
      setRemovingId(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
        We could not load your favourites. Reload the page to try again.
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No favourites yet"
        message="Save the services you book often and the professionals you trust, and they will be waiting here."
        action={{ href: '/services', label: 'Browse services' }}
        icon={<Star className="h-5 w-5" aria-hidden="true" />}
      />
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id}>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white p-5">
            <div className="min-w-0 flex-1">
              {item.service ? (
                <Link href={`/services/${item.service.slug}`} className="block">
                  <p className="truncate text-sm font-medium text-gray-900 hover:text-blue-700">
                    {item.service.name}
                  </p>
                  {item.service.shortDescription ? (
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      {item.service.shortDescription}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs font-semibold text-gray-700">
                    from {inr.format(item.service.basePrice)}
                  </p>
                </Link>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                    <Wrench className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {item.professional?.name ?? 'Professional'}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
                      <Star className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                      {item.professional?.rating ? item.professional.rating.toFixed(1) : 'New'}
                      {item.professional?.ratingCount
                        ? ` (${item.professional.ratingCount})`
                        : ''}
                    </p>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => remove(item)}
              disabled={removingId === item.id}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              aria-label={`Remove ${item.service?.name ?? 'favourite'}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Remove
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function CustomerFavouritesPage() {
  return (
    <AuthGuard role="customer">
      <RoleShell role="customer" eyebrow="Customer" title="Favourites">
        <FavouritesView />
      </RoleShell>
    </AuthGuard>
  );
}
