'use client';

import { AlertCircle, BadgeCheck, Clock, FileText, Upload } from 'lucide-react';
import { VERIFICATION_COPY } from '@/components/professional/verificationCopy';
import { KYC_REQUIRED_DOC_TYPES, type KycDocType } from '@/lib/constants';
import type { KycDocument } from '@/lib/professionalClient';

/**
 * The three-step KYC stepper (§20.10, Interaction Contract 9).
 *
 * Identity / Address / Selfie, one `professional_documents` row each. The
 * per-step status chip reuses `VERIFICATION_COPY` from the professional home
 * page verbatim — one source for the wording, so the stepper and the home
 * banner can never disagree about what "In review" means.
 *
 * It renders no reviewer-note field at all, which is how the "never show
 * internal reviewer notes" rule is kept: there is nothing to show. The optional
 * rejection reason the professional *is* allowed to see arrives on the document
 * row and is rendered as feedback, not as an internal note.
 */

const STEP_META: Record<KycDocType, { title: string; hint: string }> = {
  aadhaar_front: {
    title: 'Identity',
    hint: 'A clear photo of your Aadhaar (front side).',
  },
  address_proof: {
    title: 'Address',
    hint: 'A utility bill, rent agreement or Aadhaar showing your address.',
  },
  selfie: {
    title: 'Selfie',
    hint: 'A selfie holding the same identity document.',
  },
};

export default function KycStepper({
  documents,
  onSelect,
  busyDocType,
  disabled = false,
}: {
  documents: KycDocument[];
  onSelect: (docType: KycDocType) => void;
  busyDocType: KycDocType | null;
  disabled?: boolean;
}) {
  const byType = new Map(documents.map((doc) => [doc.docType, doc]));

  return (
    <ol className="space-y-3">
      {KYC_REQUIRED_DOC_TYPES.map((docType, index) => {
        const meta = STEP_META[docType];
        const doc = byType.get(docType);
        const status = doc?.status ?? 'not_submitted';
        const copy = VERIFICATION_COPY[status] ?? VERIFICATION_COPY.not_submitted;
        const busy = busyDocType === docType;
        const canUpload = status === 'not_submitted' || status === 'rejected' || status === 'expired';
        const actionLabel = canUpload ? 'Upload' : 'Replace';

        return (
          <li
            key={docType}
            className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold text-gray-700"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-gray-900">{meta.title}</p>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${copy.tone}`}
                  >
                    {status === 'verified' ? (
                      <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : status === 'rejected' ? (
                      <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : status === 'submitted' || status === 'in_review' ? (
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : null}
                    {copy.label}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-gray-600">{meta.hint}</p>
                {doc?.filePath ? (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    {doc.filePath.split('/').pop()}
                  </p>
                ) : null}
                {doc?.status === 'rejected' && doc.rejectionReason ? (
                  <p className="mt-1 text-xs text-red-600">{doc.rejectionReason}</p>
                ) : null}
              </div>
            </div>

            <button
              type="button"
              onClick={() => onSelect(docType)}
              disabled={disabled || busy}
              aria-busy={busy}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              {busy ? 'Uploading…' : actionLabel}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
