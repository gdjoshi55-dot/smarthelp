'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Heart } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  addFavourite,
  fetchFavourites,
  removeFavourite,
  type FavouriteTargetType,
} from '@/lib/favouriteClient';

/**
 * The save toggle for a service or a professional (§20.3).
 *
 * Anonymous visitors are invited to sign in rather than shown an error: the
 * heart is a discovery affordance, and a 401 is how we find out we do not have a
 * customer to save against. Signed-in customers get an optimistic toggle that
 * reverts if the write fails, so the heart never lies about what the server holds.
 */

interface Props {
  targetType: FavouriteTargetType;
  targetId: string;
  label?: string;
  className?: string;
}

export function FavouriteButton({ targetType, targetId, label = 'Save', className }: Props) {
  const { role, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading || role !== 'customer') return;
    let cancelled = false;
    fetchFavourites()
      .then((res) => {
        if (cancelled) return;
        setSaved(
          res.favourites.some((f) => f.targetType === targetType && f.targetId === targetId)
        );
      })
      .catch(() => {
        if (!cancelled) setSaved(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, role, targetType, targetId]);

  async function toggle() {
    if (role !== 'customer') {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (busy) return;
    const next = !saved;
    setBusy(true);
    setSaved(next);
    try {
      if (next) await addFavourite(targetType, targetId);
      else await removeFavourite(targetType, targetId);
    } catch {
      setSaved(!next);
      toast.error('We could not update your favourites. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const active = saved === true;

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy || loading}
      aria-pressed={active}
      className={
        className ??
        'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-50 ' +
          (active
            ? 'border-red-200 bg-red-50 text-red-600'
            : 'border-gray-200 bg-white text-gray-600 hover:border-red-200 hover:text-red-600')
      }
    >
      <Heart
        className={`h-4 w-4 ${active ? 'fill-current' : ''}`}
        aria-hidden="true"
      />
      {active ? 'Saved' : label}
    </button>
  );
}
