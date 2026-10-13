'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import StatusPill from '@/components/admin/StatusPill';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchKycReview,
  kycDocumentDecision,
  type KycReview,
  type KycReviewDocument,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const pending = (doc: KycReviewDocument) => doc.status === 'submitted' || doc.status === 'in_review';

/**
 * The KYC review screen (§20.11).
 *
 * The document image is served through a short-lived signed URL minted per read
 * — `kyc-documents` is a private bucket with no select policy, so there is no
 * durable link to leak. The reviewer sees the picture, decides, and the decision
 * route re-derives the professional's status from the whole required set.
 */
export default function KycReviewPage() {
  const { roleLabel, hasCapability } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [review, setReview] = useState<KycReview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<KycReviewDocument | null>(null);
  const [reason, setReason] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const canReview = hasCapability('kyc.review');

  const load = useCallback(() => {
    setLoadError(false);
    fetchKycReview(id)
      .then(setReview)
      .catch(() => setLoadError(true));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (doc: KycReviewDocument, verdict: 'verified' | 'rejected', note?: string) => {
    setBusyId(doc.id);
    setRowError((prev) => ({ ...prev, [doc.id]: '' }));
    try {
      await kycDocumentDecision(id, doc.id, { verdict, note });
      load();
    } catch (e) {
      setRowError((prev) => ({
        ...prev,
        [doc.id]: e instanceof Error ? e.message : 'The decision could not be applied.',
      }));
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    if (reason.trim().length === 0) {
      setConfirmError('A rejection needs a reason the professional will see.');
      return;
    }
    const doc = rejecting;
    setConfirmError(null);
    setRejecting(null);
    await decide(doc, 'rejected', reason.trim());
    setReason('');
  };

  const pro = review?.professional;

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell
        role="admin"
        eyebrow={roleLabel ?? 'Operations'}
        title={review?.profile?.full_name ? `KYC — ${review.profile.full_name}` : 'KYC review'}
      >
        <div className="space-y-6">
          <Link href={`/admin/professionals/${id}`} className="inline-block text-sm font-medium text-blue-700 hover:underline">
            ← Back to professional
          </Link>

          {loadError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load this KYC review.
            </div>
          ) : !review || !pro ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : (
            <>
              <section className="rounded-2xl bg-white p-6 shadow-xl">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill status={pro.verification_status} />
                  {pro.employee_code && <span className="text-sm text-gray-500">{pro.employee_code}</span>}
                </div>
                <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Phone" value={review.profile?.phone ?? '—'} />
                  <Field label="Email" value={review.profile?.email ?? '—'} />
                  <Field
                    label="KYC verified"
                    value={pro.kyc_verified_at ? dt.format(new Date(pro.kyc_verified_at)) : '—'}
                  />
                  <Field
                    label="Skills"
                    value={review.skills.length ? `${review.skills.length} service(s)` : '—'}
                  />
                </dl>
                {!canReview && (
                  <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    You can view documents here, but only an admin can record a verdict.
                  </p>
                )}
              </section>

              <section className="space-y-4">
                <h2 className="text-base font-semibold text-gray-900">Documents</h2>
                {review.documents.length === 0 && (
                  <p className="text-sm text-gray-600">This professional has no documents on file.</p>
                )}
                {review.documents.map((doc) => (
                  <div key={doc.id} className="rounded-2xl bg-white p-5 shadow-xl">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold capitalize text-gray-900">
                          {doc.doc_type.replace(/_/g, ' ')}
                        </span>
                        <StatusPill status={doc.status} />
                      </div>
                      <span className="text-xs text-gray-500">
                        Uploaded {dt.format(new Date(doc.created_at))}
                      </span>
                    </div>

                    {doc.signedUrl ? (
                      <a
                        href={doc.signedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-block text-sm font-medium text-blue-700 hover:underline"
                      >
                        Open document image ↗
                      </a>
                    ) : (
                      <p className="mt-3 text-sm text-amber-800">
                        The document file could not be opened — it may have been removed.
                      </p>
                    )}

                    {doc.rejection_reason && (
                      <p className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-800">
                        Rejected: {doc.rejection_reason}
                      </p>
                    )}

                    {canReview && pending(doc) && (
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={busyId === doc.id}
                          onClick={() => decide(doc, 'verified')}
                          className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          Verify
                        </button>
                        <button
                          type="button"
                          disabled={busyId === doc.id}
                          onClick={() => {
                            setRejecting(doc);
                            setReason('');
                            setConfirmError(null);
                          }}
                          className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          Reject
                        </button>
                        {rowError[doc.id] && (
                          <span className="text-sm text-red-700">{rowError[doc.id]}</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </section>

              <p className="text-sm text-gray-500">
                Verdicts update the professional&apos;s overall verification status automatically.{' '}
                <Link href={`/admin/professionals/${id}`} className="text-blue-700 hover:underline">
                  Suspend or reactivate
                </Link>{' '}
                from the profile.
              </p>

              <button
                type="button"
                onClick={() => router.refresh()}
                className="text-xs text-gray-400 hover:underline"
              >
                Refresh
              </button>
            </>
          )}
        </div>

        <ConfirmationDialog
          isOpen={rejecting !== null}
          onClose={() => setRejecting(null)}
          onConfirm={confirmReject}
          title="Reject this document?"
          message="The professional will see the reason you give and can re-submit. This cannot be undone here."
          confirmText="Reject"
          type="danger"
          isLoading={busyId === rejecting?.id}
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Why is this document not acceptable?"
            className="w-full rounded-lg border border-gray-300 p-2 text-sm"
          />
          {confirmError && <p className="mt-1 text-sm text-red-700">{confirmError}</p>}
        </ConfirmationDialog>
      </RoleShell>
    </AuthGuard>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value}</dd>
    </div>
  );
}
