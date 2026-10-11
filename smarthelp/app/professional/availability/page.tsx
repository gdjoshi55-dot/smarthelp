'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { CalendarOff, Loader2, Plus, Trash2 } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { EmptyState } from '@/components/catalogue/EmptyState';
import { Switch } from '@/components/ui/switch';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import {
  ProfessionalApiError,
  addTimeOff,
  deleteTimeOff,
  fetchAvailability,
  fetchTimeOff,
  fetchWorkingHours,
  saveWorkingHours,
  setAvailability as setAvailabilityOnline,
  type AvailabilityState,
  type TimeOffEntry,
  type WorkingHourInput,
} from '@/lib/professionalClient';

/**
 * `/professional/availability` (§19.1) — when you work, and when you are online.
 *
 * Three things live on this page and they answer three different questions:
 * the Switch is "are you taking jobs *right now*", the weekly editor is "when
 * are you generally willing to work", and time off is "which days are you out".
 * The first is the one place in the phase where the UI is optimistic (UI-SPEC
 * Interaction Contract 4) — the Switch moves first and is rolled back if the
 * server refuses — while hours and time off wait for the response.
 *
 * `time-off` is a range the professional blocks; overlaps are refused by the
 * route, so the page only has to report the 409 rather than pre-check the
 * calendar itself.
 */

const DAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

function dayLabel(weekday: number): string {
  return DAYS.find((d) => d.value === weekday)?.label ?? 'Day';
}

function formatRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date = start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const from = start.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const to = end.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${from}–${to}`;
}

function AvailabilityManager() {
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const [availability, setAvailability] = useState<AvailabilityState | null>(null);
  const [togglingOnline, setTogglingOnline] = useState(false);

  const [windows, setWindows] = useState<WorkingHourInput[]>([]);
  const [savingHours, setSavingHours] = useState(false);

  const [timeOff, setTimeOff] = useState<TimeOffEntry[]>([]);
  const [addStart, setAddStart] = useState('');
  const [addEnd, setAddEnd] = useState('');
  const [addReason, setAddReason] = useState('');
  const [addingTimeOff, setAddingTimeOff] = useState(false);
  const [timeOffProblem, setTimeOffProblem] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TimeOffEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const [state, hours, blocks] = await Promise.all([
      fetchAvailability(),
      fetchWorkingHours(),
      fetchTimeOff(),
    ]);
    setAvailability(state);
    setWindows(
      hours.hours.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime }))
    );
    setTimeOff(blocks.timeOff);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProblem(null);
    load()
      .catch((e: unknown) => {
        if (cancelled) return;
        setProblem(
          e instanceof ProfessionalApiError ? e.message : 'We could not load this page right now.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleToggle(next: boolean) {
    if (!availability) return;
    const previous = availability;
    // Optimistic: the Switch has already moved. A failure puts it back and says
    // why — there is nothing else on the page that depends on this value.
    setAvailability({
      availabilityStatus: next ? 'online' : 'offline',
      isAvailableToday: next,
    });
    setTogglingOnline(true);
    try {
      const updated = await setAvailabilityOnline(next);
      setAvailability(updated);
    } catch (e: unknown) {
      setAvailability(previous);
      toast.error(
        e instanceof ProfessionalApiError
          ? e.message
          : 'We could not change your availability. Try again.'
      );
    } finally {
      setTogglingOnline(false);
    }
  }

  function addWindow() {
    setWindows((current) => [
      ...current,
      { weekday: 1, startTime: '09:00', endTime: '17:00' },
    ]);
  }

  function updateWindow(index: number, patch: Partial<WorkingHourInput>) {
    setWindows((current) => current.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  }

  function removeWindow(index: number) {
    setWindows((current) => current.filter((_, i) => i !== index));
  }

  async function handleSaveHours() {
    setSavingHours(true);
    try {
      const result = await saveWorkingHours(windows);
      setWindows(
        result.hours.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime }))
      );
      toast.success('Hours saved.');
    } catch (e: unknown) {
      toast.error(
        e instanceof ProfessionalApiError ? e.message : 'We could not save your hours. Try again.'
      );
    } finally {
      setSavingHours(false);
    }
  }

  async function handleAddTimeOff() {
    setTimeOffProblem(null);
    if (!addStart || !addEnd) {
      setTimeOffProblem('Pick both a start and an end.');
      return;
    }
    setAddingTimeOff(true);
    try {
      const created = await addTimeOff({
        startsAt: new Date(addStart).toISOString(),
        endsAt: new Date(addEnd).toISOString(),
        reason: addReason.trim() || null,
      });
      setTimeOff((current) =>
        [...current, created.timeOff].sort(
          (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
        )
      );
      setAddStart('');
      setAddEnd('');
      setAddReason('');
    } catch (e: unknown) {
      setTimeOffProblem(
        e instanceof ProfessionalApiError ? e.message : 'We could not add that time off.'
      );
    } finally {
      setAddingTimeOff(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteTimeOff(pendingDelete.id);
      setTimeOff((current) => current.filter((entry) => entry.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (e: unknown) {
      toast.error(
        e instanceof ProfessionalApiError ? e.message : 'We could not remove that time off.'
      );
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-gray-600" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your availability…
      </p>
    );
  }

  if (problem) {
    return (
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
        {problem}
      </p>
    );
  }

  const online = availability?.availabilityStatus === 'online';

  return (
    <div className="space-y-6">
      {/* ── The online switch ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {online ? 'Go offline' : 'Go online'}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {online
                ? 'You are online and can be offered new jobs.'
                : 'Go online to receive offers for nearby jobs.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700" aria-hidden="true">
              {online ? 'Online' : 'Offline'}
            </span>
            <Switch
              checked={online}
              disabled={togglingOnline}
              onCheckedChange={handleToggle}
              aria-label={online ? 'Go offline' : 'Go online'}
            />
          </div>
        </div>
        {togglingOnline ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500" role="status">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Saving…
          </p>
        ) : null}
      </section>

      {/* ── Weekly working hours ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Working hours</h2>
            <p className="mt-1 text-sm text-gray-600">
              When you are generally willing to work. Jobs are only offered inside these windows.
            </p>
          </div>
          <button
            type="button"
            onClick={addWindow}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add window
          </button>
        </div>

        {windows.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">
            No working hours yet. Add a window for each day you work.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {windows.map((window, index) => (
              <li key={index} className="flex flex-wrap items-center gap-3">
                <label className="sr-only" htmlFor={`weekday-${index}`}>
                  Day
                </label>
                <select
                  id={`weekday-${index}`}
                  value={window.weekday}
                  onChange={(e) => updateWindow(index, { weekday: Number(e.target.value) })}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                >
                  {DAYS.map((day) => (
                    <option key={day.value} value={day.value}>
                      {day.label}
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  value={window.startTime}
                  onChange={(e) => updateWindow(index, { startTime: e.target.value })}
                  aria-label={`${dayLabel(window.weekday)} start time`}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                <span className="text-sm text-gray-500" aria-hidden="true">
                  to
                </span>
                <input
                  type="time"
                  value={window.endTime}
                  onChange={(e) => updateWindow(index, { endTime: e.target.value })}
                  aria-label={`${dayLabel(window.weekday)} end time`}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                <button
                  type="button"
                  onClick={() => removeWindow(index)}
                  aria-label={`Remove ${dayLabel(window.weekday)} window`}
                  className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={handleSaveHours}
          disabled={savingHours}
          aria-busy={savingHours}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {savingHours ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save hours'
          )}
        </button>
      </section>

      {/* ── Time off ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-base font-semibold text-gray-900">Time off</h2>
        <p className="mt-1 text-sm text-gray-600">
          Block a day and no offers will be sent for it.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-700">
            <span className="mb-1 block text-xs font-medium text-gray-600">Starts</span>
            <input
              type="datetime-local"
              value={addStart}
              onChange={(e) => setAddStart(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <label className="text-sm text-gray-700">
            <span className="mb-1 block text-xs font-medium text-gray-600">Ends</span>
            <input
              type="datetime-local"
              value={addEnd}
              onChange={(e) => setAddEnd(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <label className="text-sm text-gray-700">
            <span className="mb-1 block text-xs font-medium text-gray-600">Reason (optional)</span>
            <input
              type="text"
              value={addReason}
              maxLength={200}
              onChange={(e) => setAddReason(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <button
            type="button"
            onClick={handleAddTimeOff}
            disabled={addingTimeOff}
            aria-busy={addingTimeOff}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {addingTimeOff ? 'Adding…' : 'Add time off'}
          </button>
        </div>

        {timeOffProblem ? (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {timeOffProblem}
          </p>
        ) : null}

        <div className="mt-5">
          {timeOff.length === 0 ? (
            <EmptyState
              icon={<CalendarOff className="h-5 w-5" aria-hidden="true" />}
              title="No time off booked"
              message="Days you block will appear here. Add a date to stop offers on that day."
            />
          ) : (
            <ul className="divide-y divide-gray-100">
              {timeOff.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {formatRange(entry.startsAt, entry.endsAt)}
                    </p>
                    {entry.reason ? (
                      <p className="mt-0.5 text-xs text-gray-500">{entry.reason}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(entry)}
                    aria-label={`Remove time off on ${formatRange(entry.startsAt, entry.endsAt)}`}
                    className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <ConfirmationDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        type="info"
        title={pendingDelete ? `Remove time off on ${formatRange(pendingDelete.startsAt, pendingDelete.endsAt)}?` : 'Remove time off?'}
        message="Offers may be sent for that day again."
        confirmText="Remove day"
        cancelText="Keep it"
        isLoading={deleting}
      />
    </div>
  );
}

export default function ProfessionalAvailabilityPage() {
  return (
    <AuthGuard role="professional">
      <RoleShell role="professional" eyebrow="Professional" title="Availability">
        <AvailabilityManager />
      </RoleShell>
    </AuthGuard>
  );
}
