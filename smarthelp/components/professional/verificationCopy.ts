/**
 * The verification-status copy, shared by the professional home page, its
 * banner, and the KYC stepper (§20.10).
 *
 * It lives here rather than in `app/professional/page.tsx` because a Next.js
 * page module may only export its default component and the framework's own
 * route config — an extra named export makes `next typegen` reject the file. One
 * map, imported by every screen that shows a verification chip, is also the
 * point: the home banner and the KYC stepper can never disagree about what
 * "In review" says.
 */
export const VERIFICATION_COPY: Record<
  string,
  { label: string; tone: string; blurb: string }
> = {
  not_submitted: {
    label: 'Not started',
    tone: 'bg-gray-100 text-gray-700',
    blurb: 'Upload your identity and address documents to start the review.',
  },
  submitted: {
    label: 'In review',
    tone: 'bg-amber-100 text-amber-800',
    blurb: 'We are checking your documents. This usually takes up to 48 hours.',
  },
  in_review: {
    label: 'In review',
    tone: 'bg-amber-100 text-amber-800',
    blurb: 'We are checking your documents. This usually takes up to 48 hours.',
  },
  verified: {
    label: 'Verified',
    tone: 'bg-green-100 text-green-800',
    blurb: 'You are verified. Customers can now book you.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'bg-red-100 text-red-800',
    blurb: 'The documents were not readable. Upload clearer copies and try again.',
  },
  expired: {
    label: 'Expired',
    tone: 'bg-amber-100 text-amber-800',
    blurb: 'Your verification has expired. Please upload your documents again.',
  },
};
