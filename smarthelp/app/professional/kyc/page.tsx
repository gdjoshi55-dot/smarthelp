'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, CheckCircle2, Clock, Loader2, ShieldCheck, Upload } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import KycStepper from '@/components/professional/KycStepper';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { VERIFICATION_COPY } from '@/components/professional/verificationCopy';
import { getSupabase } from '@/lib/supabase';
import {
  KYC_ALLOWED_MIME_TYPES,
  KYC_MAX_UPLOAD_BYTES,
  KYC_REQUIRED_DOC_TYPES,
  type KycDocType,
} from '@/lib/constants';
import {
  ProfessionalApiError,
  fetchKyc,
  requestKycUploadUrl,
  submitKycDocument,
  type KycState,
} from '@/lib/professionalClient';

/**
 * `/professional/kyc` (§20.10) — upload identity documents and watch the review.
 *
 * The flow per document is Interaction Contract 9: the file is pre-checked in
 * the browser (≤5 MB, image or PDF), uploaded straight to the private
 * `kyc-documents` bucket through a signed URL the server mints, and only then
 * recorded as a `submitted` row. The bytes never pass through our Route
 * Handlers — the signed URL is the only write channel, and its path is fixed
 * server-side (Pitfall 10).
 *
 * The reviewer's notes are not fetched or rendered: the API does not return
 * them and this page has no field for them (§20.10).
 */

const ACCEPT = KYC_ALLOWED_MIME_TYPES.join(',');

function KycManager() {
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [kyc, setKyc] = useState<KycState | null>(null);

  const [busyDocType, setBusyDocType] = useState<KycDocType | null>(null);
  const [pendingReplace, setPendingReplace] = useState<KycDocType | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const activeDocType = useRef<KycDocType | null>(null);

  const load = useCallback(async () => {
    const state = await fetchKyc();
    setKyc(state);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProblem(null);
    load()
      .catch((e: unknown) => {
        if (cancelled) return;
        setProblem(
          e instanceof ProfessionalApiError
            ? e.message
            : 'We could not load your verification right now.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  function openPicker(docType: KycDocType) {
    activeDocType.current = docType;
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  }

  function selectDocument(docType: KycDocType) {
    const existing = kyc?.documents.find((doc) => doc.docType === docType);
    if (existing) {
      setPendingReplace(docType);
      return;
    }
    openPicker(docType);
  }

  async function handleFile(file: File) {
    const docType = activeDocType.current;
    if (!docType) return;

    if (file.size > KYC_MAX_UPLOAD_BYTES || !ACCEPT.includes(file.type)) {
      toast.error('That file could not be uploaded. Use a photo or PDF under 5 MB.');
      return;
    }

    setBusyDocType(docType);
    try {
      const signed = await requestKycUploadUrl({
        docType,
        filename: file.name,
        contentType: file.type,
        size: file.size,
      });

      const { error: uploadError } = await getSupabase()
        .storage.from('kyc-documents')
        .uploadToSignedUrl(signed.path, signed.token, file);
      if (uploadError) throw uploadError;

      await submitKycDocument({ docType, filePath: signed.path });
      await load();
      toast.success('Documents submitted for review.');
    } catch (e: unknown) {
      toast.error(
        e instanceof ProfessionalApiError
          ? e.message
          : 'We could not upload that document. Please try again.'
      );
    } finally {
      setBusyDocType(null);
      activeDocType.current = null;
    }
  }

  async function submitForReview() {
    setSubmitting(true);
    try {
      await load();
      toast.success('Documents submitted for review.');
    } catch (e: unknown) {
      toast.error(
        e instanceof ProfessionalApiError
          ? e.message
          : 'We could not submit your documents. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-gray-600" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your verification…
      </p>
    );
  }

  if (problem || !kyc) {
    return (
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
        {problem ?? 'We could not load your verification right now.'}
      </p>
    );
  }

  const status = kyc.verificationStatus;
  const copy = VERIFICATION_COPY[status] ?? VERIFICATION_COPY.not_submitted;
  const showGate = status !== 'verified';
  const uploadedCount = KYC_REQUIRED_DOC_TYPES.filter((docType) =>
    kyc.documents.some((doc) => doc.docType === docType)
  ).length;
  const allUploaded = uploadedCount === KYC_REQUIRED_DOC_TYPES.length;

  return (
    <div className="space-y-6">
      {showGate ? (
        <div
          className="flex flex-col gap-4 rounded-xl border border-amber-200 bg-amber-50 p-5 sm:flex-row sm:items-center"
          role="status"
        >
          <div className="shrink-0">
            {status === 'rejected' ? (
              <AlertCircle className="h-6 w-6 text-red-600" aria-hidden="true" />
            ) : status === 'submitted' || status === 'in_review' ? (
              <Clock className="h-6 w-6 text-amber-600" aria-hidden="true" />
            ) : (
              <Upload className="h-6 w-6 text-amber-600" aria-hidden="true" />
            )}
          </div>
          <div className="flex-1">
            <p className="font-semibold text-amber-900">Verification: {copy.label}</p>
            <p className="mt-0.5 text-sm text-amber-800">{copy.blurb}</p>
          </div>
        </div>
      ) : (
        <div
          className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-5"
          role="status"
        >
          <CheckCircle2 className="h-6 w-6 text-green-600" aria-hidden="true" />
          <p className="text-sm text-green-900">
            <span className="font-semibold">You are verified.</span> Customers can see your profile
            and book you.
          </p>
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-gray-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-gray-900">Verification documents</h2>
        </div>
        <p className="mt-1 text-sm text-gray-600">
          Photos stay private and are only visible to the verification team.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        <div className="mt-4">
          <KycStepper
            documents={kyc.documents}
            onSelect={selectDocument}
            busyDocType={busyDocType}
            disabled={submitting}
          />
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={submitForReview}
            disabled={!allUploaded || submitting}
            aria-busy={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Submitting…
              </>
            ) : (
              'Submit for review'
            )}
          </button>
          {!allUploaded ? (
            <p className="text-xs text-gray-500">
              Upload all three documents to submit for review.
            </p>
          ) : null}
        </div>
      </section>

      <ConfirmationDialog
        isOpen={pendingReplace !== null}
        onClose={() => setPendingReplace(null)}
        onConfirm={() => {
          const docType = pendingReplace;
          setPendingReplace(null);
          if (docType) openPicker(docType);
        }}
        type="warning"
        title="Replace this document?"
        message="Verification restarts from the beginning for all documents."
        confirmText="Replace document"
        cancelText="Keep document"
      />
    </div>
  );
}

export default function ProfessionalKycPage() {
  return (
    <AuthGuard role="professional">
      <RoleShell role="professional" eyebrow="Professional" title="Verification">
        <KycManager />
      </RoleShell>
    </AuthGuard>
  );
}
