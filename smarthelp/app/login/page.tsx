'use client';

/**
 * The sign-in page.
 *
 * A deliberate port of SmartPOS's `app/login/page.tsx`: same shell, same
 * gradient, same card, same tab strip, same icon-in-input fields, same
 * "the form is replaced by a code screen" behaviour, same react-hot-toast
 * feedback, same footer. What a person sees here should be something they
 * already know how to use.
 *
 * The layout, the class names and the copy are copied rather than
 * re-invented on purpose. Diverging from them would buy nothing and would
 * make the two products feel like different software.
 *
 * Three things are not the same, and each is a real difference rather than an
 * oversight:
 *
 *   1. There is no "Migrate" tab. That exists in SmartPOS to attach an email
 *      and password to a restaurant row that predates them. SmartHelp has no
 *      such legacy state, so it has nothing to migrate. "Forgot password" is
 *      reached from a link, exactly as in SmartPOS.
 *
 *   2. The password rule is SmartHelp's, not SmartPOS's. The server requires
 *      eight characters with a letter and a number, so the form says the same
 *      thing rather than letting a person fill in a valid-looking six
 *      characters and be rejected after the code is already in their inbox.
 *
 *   3. The code screen carries a resend button. The ledger throttles to one
 *      live code per address per 60 seconds, and a person who mistypes a code
 *      needs a way back that does not involve waiting for the page to reload.
 *
 * A "Confirm password" field is the one field added beyond SmartPOS, and it is
 * here because the code is verified after the details are sent: without it a
 * typo in the password would be discovered only after the address was proven.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Wrench, Mail, Lock, User, UserCog, Phone, WrenchIcon } from 'lucide-react';
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from '@/components/ui/input-otp';
import toast from 'react-hot-toast';
import { useAuth, type SignUpRole } from '@/contexts/AuthContext';
import { ROLE_HOME } from '@/lib/roles';
import { OTP_LENGTH, DEFAULT_PHONE_COUNTRY_CODE } from '@/lib/constants';

type Tab = 'login' | 'signup' | 'forgot';
type OtpPurpose = 'signup' | 'password_reset';
type OtpPhase = 'idle' | 'sending' | 'entering';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;

/**
 * The same rule the server applies in `validatePassword`, so nothing is only
 * discovered server-side. The server re-checks it either way.
 */
function passwordProblem(value: string): string | null {
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return 'Include a letter and a number';
  return null;
}

/**
 * Mirrors `normalizePhone` in `lib/validation.ts`, step for step, so a typo is
 * caught before the code is requested rather than after it arrives. Empty is
 * allowed and is not a problem: `profiles.phone` is nullable (migration 0027),
 * because an email and password account genuinely does not need one.
 */
function phoneProblem(value: string): string | null {
  const raw = value.trim().replace(/[\s\-()]/g, '');
  if (!raw) return null;
  if (raw.length < 10 || raw.length > 20) return 'Enter a 10-digit mobile number';

  const cc = DEFAULT_PHONE_COUNTRY_CODE;
  let digits = raw.replace(/^\+/, '');
  if (digits.length === cc.length + 10 && digits.startsWith(cc)) digits = digits.slice(cc.length);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9][0-9]{9}$/.test(digits)) return 'Enter a 10-digit mobile number';
  return null;
}

// Copied from SmartPOS so the two forms are pixel-identical.
const inputClass =
  'w-full pl-10 pr-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm';
const labelClass = 'block text-sm font-medium text-gray-700 mb-1.5';

export default function LoginPage() {
  const router = useRouter();
  const {
    session,
    role,
    initialising,
    signIn,
    signUpStart,
    signUpComplete,
    passwordResetStart,
    passwordResetComplete,
  } = useAuth();

  const [tab, setTab] = useState<Tab>('login');

  // One address for all three tabs, because moving between "sign in" and
  // "forgot password" is nearly always the same person at the same keyboard.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [signUpRole, setSignUpRole] = useState<SignUpRole>('customer');

  const [submitting, setSubmitting] = useState(false);
  const [otpPhase, setOtpPhase] = useState<OtpPhase>('idle');
  const [otpCode, setOtpCode] = useState('');
  const [otpPurpose, setOtpPurpose] = useState<OtpPurpose>('signup');
  const [pendingSignUp, setPendingSignUp] = useState<{
    fullName: string;
    email: string;
    password: string;
    role: SignUpRole;
    phone: string;
  } | null>(null);
  const [pendingReset, setPendingReset] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [resendIn, setResendIn] = useState(0);

  const [next, setNext] = useState<string | null>(null);
  const [searchRead, setSearchRead] = useState(false);

  // Read the query string off `window` rather than through useSearchParams:
  // this is a client component, and useSearchParams would put the whole page
  // behind a Suspense boundary to read two parameters.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const wanted = params.get('tab');
    if (wanted === 'signup' || wanted === 'login' || wanted === 'forgot') setTab(wanted);

    const destination = params.get('next');
    if (destination && destination.startsWith('/') && !destination.startsWith('//')) {
      setNext(destination);
    }
    setSearchRead(true);
  }, []);

  // Already signed in: go where this account belongs, not where the link said.
  // `searchRead` gates this so a deep link is not lost to the first render.
  useEffect(() => {
    if (initialising || !searchRead || !session || !role) return;
    router.replace(next ?? ROLE_HOME[role] ?? '/');
  }, [initialising, searchRead, session, role, next, router]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const normalisedEmail = email.trim().toLowerCase();

  const requireEmail = useCallback((): string | null => {
    if (!EMAIL_RE.test(email.trim())) {
      toast.error('Please enter a valid email address');
      return null;
    }
    return normalisedEmail;
  }, [email, normalisedEmail]);

  /** Drops the secret state so nothing leaks into the next tab. */
  function switchTab(target: Tab) {
    setTab(target);
    setPassword('');
    setPasswordConfirm('');
    setOtpCode('');
    setOtpPhase('idle');
    setPendingSignUp(null);
    setPendingReset(null);
    setResendIn(0);
  }

  function leaveCodeScreen() {
    setOtpPhase('idle');
    setOtpCode('');
    setPendingSignUp(null);
    setPendingReset(null);
    setResendIn(0);
  }

  // ── Sign in ───────────────────────────────────────────────────────────────

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const address = requireEmail();
    if (!address) return;
    if (!password) {
      toast.error('Please enter your password');
      return;
    }

    setSubmitting(true);
    try {
      const { home } = await signIn(address, password);
      toast.success('Welcome to SmartHelp!');
      router.replace(next ?? home ?? '/');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Create account ────────────────────────────────────────────────────────

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();

    if (fullName.trim().length < 2) {
      toast.error('Please tell us your name');
      return;
    }
    const address = requireEmail();
    if (!address) return;
    const problem = passwordProblem(password);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (password !== passwordConfirm) {
      toast.error('Passwords do not match');
      return;
    }
    const phoneTrouble = phoneProblem(phone);
    if (phoneTrouble) {
      toast.error(phoneTrouble);
      return;
    }

    // The details are held, not sent: nothing exists until the code is proven.
    setPendingSignUp({
      fullName: fullName.trim(),
      email: address,
      password,
      role: signUpRole,
      phone: phone.trim(),
    });
    await sendOtp(address, 'signup');
  }

  // ── Forgot password ───────────────────────────────────────────────────────

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();

    const address = requireEmail();
    if (!address) return;
    const problem = passwordProblem(password);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (password !== passwordConfirm) {
      toast.error('Passwords do not match');
      return;
    }

    setPendingReset({ email: address, password });
    await sendOtp(address, 'password_reset');
  }

  // ── The code screen ───────────────────────────────────────────────────────

  /**
   * Asks for a code without saying whether the account exists. Both endpoints
   * answer the same way either way, so a failure here reveals nothing.
   */
  async function sendOtp(address: string, purpose: OtpPurpose) {
    setOtpPhase('sending');
    try {
      if (purpose === 'signup') {
        const res = await signUpStart({
          email: address,
          fullName: pendingSignUp?.fullName ?? fullName.trim(),
          role: pendingSignUp?.role ?? signUpRole,
        });
        setResendIn(res.resendInSeconds);
      } else {
        const res = await passwordResetStart(address);
        setResendIn(res.resendInSeconds);
      }

      setOtpPurpose(purpose);
      setOtpCode('');
      setOtpPhase('entering');
      toast.success('Code sent to your email');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to send the code');
      setOtpPhase('idle');
      setPendingSignUp(null);
      setPendingReset(null);
    }
  }

  async function verifyOtpAndProceed() {
    if (otpCode.length !== OTP_LENGTH) {
      toast.error(`Please enter the ${OTP_LENGTH}-digit code`);
      return;
    }
    if (!pendingSignUp && !pendingReset) {
      leaveCodeScreen();
      return;
    }

    setSubmitting(true);
    try {
      if (otpPurpose === 'signup' && pendingSignUp) {
        const { home } = await signUpComplete({
          email: pendingSignUp.email,
          code: otpCode,
          password: pendingSignUp.password,
          passwordConfirm: pendingSignUp.password,
          fullName: pendingSignUp.fullName,
          role: pendingSignUp.role,
          phone: pendingSignUp.phone,
        });
        toast.success('Account created! Welcome to SmartHelp.');
        router.replace(next ?? home ?? '/');
        return;
      }

      if (otpPurpose === 'password_reset' && pendingReset) {
        await passwordResetComplete({
          email: pendingReset.email,
          code: otpCode,
          password: pendingReset.password,
          passwordConfirm: pendingReset.password,
        });
        toast.success('Password reset successfully! Please login.');
        setPassword('');
        setPasswordConfirm('');
        setOtpCode('');
        setPendingReset(null);
        setOtpPhase('idle');
        setTab('login');
        return;
      }
    } catch (err: any) {
      toast.error(err?.message || 'Verification failed');
      // A wrong code must not leave six digits sitting in the box looking
      // correct; the person is starting again, and clearing it says so.
      setOtpCode('');
    } finally {
      setSubmitting(false);
    }
  }

  if (initialising) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50" role="status" aria-busy="true">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
            <Wrench className="h-8 w-8 text-white" />
          </div>
          <p className="text-gray-500 font-medium">Loading SmartHelp...</p>
        </div>
      </div>
    );
  }

  /*
   * `w-screen` on the shell, and `overflow-x-clip` on the wrapper below it.
   *
   * The shell used to be sized by `100vh` alone, so its width came from the
   * layout viewport — which is `innerWidth` minus any vertical scrollbar. Once
   * the card is taller than the window, a scrollbar appears, the layout
   * viewport narrows, and everything centred inside it shifts about 7px to the
   * left. The gradient also stopped 15px short of the right edge, leaving a
   * pale strip. `w-screen` is `100vw`, which is the full width including where
   * the scrollbar sits, so the gradient reaches the edge and the centring is
   * correct at every window size.
   *
   * The `clip` is only there to contain that 100vw against a narrower body. It
   * is `clip` rather than `hidden` on purpose: `hidden` would make the wrapper
   * a scroll container and break `position: sticky` further down the page.
   */
  return (
    <div className="overflow-x-clip">
      <div className="min-h-screen w-screen flex flex-col bg-gradient-to-br from-blue-600 to-blue-800">
      <nav className="py-4 px-6">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 bg-white/15 hover:bg-white/25 text-white px-4 py-2 rounded-lg transition-colors backdrop-blur-sm"
          >
            <span className="text-sm font-semibold">Home</span>
          </Link>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center">
              <Wrench className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-white">SmartHelp</span>
          </div>
        </div>
      </nav>

      <div className="flex-1 flex items-center justify-center p-4 py-8">
        <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[calc(100vh-13.5rem)] overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <div className="text-center pt-8 pb-4 px-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
              <Wrench className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">SmartHelp</h1>
            <p className="text-gray-500 mt-1 text-sm">Home Services Marketplace</p>
          </div>

          <div className="flex border-b border-gray-200 px-8">
            {(
              [
                { id: 'login', label: 'Login' },
                { id: 'signup', label: 'Sign Up' },
              ] as { id: Tab; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => switchTab(t.id)}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  tab === t.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-8">
            {otpPhase !== 'idle' ? (
              <div className="space-y-4 max-w-md mx-auto">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm text-blue-800">
                    {otpPhase === 'sending'
                      ? 'Sending verification code...'
                      : `Enter the ${OTP_LENGTH}-digit code sent to ${
                          otpPurpose === 'signup' ? pendingSignUp?.email : pendingReset?.email
                        }`}
                  </p>
                </div>

                {otpPhase === 'entering' && (
                  <>
                    <div>
                      <label className={labelClass}>Verification Code</label>
                      <div className="flex justify-center">
                        <InputOTP
                          maxLength={OTP_LENGTH}
                          value={otpCode}
                          onChange={(value) => setOtpCode(value)}
                        >
                          <InputOTPGroup>
                            <InputOTPSlot index={0} />
                            <InputOTPSlot index={1} />
                            <InputOTPSlot index={2} />
                          </InputOTPGroup>
                          <InputOTPSeparator />
                          <InputOTPGroup>
                            <InputOTPSlot index={3} />
                            <InputOTPSlot index={4} />
                            <InputOTPSlot index={5} />
                          </InputOTPGroup>
                        </InputOTP>
                      </div>
                    </div>

                    <button
                      onClick={verifyOtpAndProceed}
                      disabled={submitting || otpCode.length !== OTP_LENGTH}
                      className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      {submitting ? 'Verifying...' : 'Verify & Continue'}
                    </button>

                    <div className="flex items-center justify-center gap-4">
                      <p className="text-center text-sm text-gray-500">
                        <button
                          type="button"
                          onClick={leaveCodeScreen}
                          className="text-blue-600 font-medium hover:underline"
                        >
                          Cancel
                        </button>
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          sendOtp(
                            otpPurpose === 'signup' ? pendingSignUp!.email : pendingReset!.email,
                            otpPurpose
                          )
                        }
                        disabled={resendIn > 0}
                        className="text-sm text-gray-500 hover:text-blue-600 disabled:text-gray-300 font-medium transition-colors"
                      >
                        {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                {tab === 'login' && (
                  <form onSubmit={handleLogin} className="space-y-4 max-w-md mx-auto">
                    <div>
                      <label className={labelClass}>Email Address</label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="Enter your email"
                          className={inputClass}
                          autoComplete="username"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className={labelClass}>Password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Enter your password"
                          className={inputClass}
                          autoComplete="current-password"
                          required
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      {submitting ? 'Signing in...' : 'Login'}
                    </button>

                    <p className="text-center text-sm text-gray-500">
                      <button
                        type="button"
                        onClick={() => switchTab('forgot')}
                        className="text-blue-600 font-medium hover:underline"
                      >
                        Forgot Password?
                      </button>
                    </p>

                    <p className="text-center text-sm text-gray-500">
                      Don&apos;t have an account?{' '}
                      <button
                        type="button"
                        onClick={() => switchTab('signup')}
                        className="text-blue-600 font-medium hover:underline"
                      >
                        Sign Up
                      </button>
                    </p>
                  </form>
                )}

                {tab === 'signup' && (
                  <form onSubmit={handleSignUp} className="space-y-5">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                        <UserCog className="h-4 w-4 mr-2 text-blue-600" />
                        Account Type
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {(
                          [
                            ['customer', 'I need services', UserCog],
                            ['professional', 'I offer services', WrenchIcon],
                          ] as [SignUpRole, string, typeof User][]
                        ).map(([value, label, Icon]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setSignUpRole(value)}
                            aria-pressed={signUpRole === value}
                            className={`flex items-center gap-2 pl-3 pr-3 py-2.5 border rounded-lg text-sm font-medium transition-colors text-left ${
                              signUpRole === value
                                ? 'border-blue-600 bg-blue-50 text-blue-700'
                                : 'border-gray-300 text-gray-600 hover:border-gray-400'
                            }`}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                        <User className="h-4 w-4 mr-2 text-blue-600" />
                        Your Details
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass}>Full Name *</label>
                          <div className="relative">
                            <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type="text"
                              value={fullName}
                              onChange={(e) => setFullName(e.target.value)}
                              placeholder="Your name"
                              className={inputClass}
                              autoComplete="name"
                              required
                            />
                          </div>
                        </div>

                        <div>
                          <label className={labelClass}>Phone Number</label>
                          <div className="relative">
                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type="tel"
                              inputMode="tel"
                              value={phone}
                              onChange={(e) => setPhone(e.target.value)}
                              placeholder={`+${DEFAULT_PHONE_COUNTRY_CODE} 98765 43210`}
                              className={inputClass}
                              autoComplete="tel-national"
                            />
                          </div>
                          <p className="text-xs text-gray-500 mt-1.5">
                            Optional. Used for booking reminders only.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                        <Lock className="h-4 w-4 mr-2 text-blue-600" />
                        Login Credentials
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass}>Email Address *</label>
                          <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type="email"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              placeholder="you@example.com"
                              className={inputClass}
                              autoComplete="username"
                              required
                            />
                          </div>
                        </div>

                        <div>
                          <label className={labelClass}>Password *</label>
                          <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type="password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder={`Min ${MIN_PASSWORD} characters`}
                              className={inputClass}
                              autoComplete="new-password"
                              required
                            />
                          </div>
                        </div>

                        <div>
                          <label className={labelClass}>Confirm Password *</label>
                          <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type="password"
                              value={passwordConfirm}
                              onChange={(e) => setPasswordConfirm(e.target.value)}
                              placeholder="Re-enter password"
                              className={inputClass}
                              autoComplete="new-password"
                              required
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                      <p className="text-xs text-blue-800">
                        {signUpRole === 'professional'
                          ? 'After creating your account you can add your service skills and verify your identity.'
                          : 'After creating your account you can browse and book verified professionals.'}{' '}
                        We will email a {OTP_LENGTH}-digit code to confirm this address.
                      </p>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      {submitting ? 'Creating account...' : 'Create Account'}
                    </button>

                    <p className="text-center text-sm text-gray-500">
                      Already have an account?{' '}
                      <button
                        type="button"
                        onClick={() => switchTab('login')}
                        className="text-blue-600 font-medium hover:underline"
                      >
                        Login
                      </button>
                    </p>
                  </form>
                )}

                {tab === 'forgot' && (
                  <form onSubmit={handleForgot} className="space-y-4 max-w-md mx-auto">
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                      <p className="text-sm text-blue-800">
                        Enter your account email and a new password to reset your login.
                      </p>
                    </div>

                    <div>
                      <label className={labelClass}>Email Address</label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="Enter your email"
                          className={inputClass}
                          autoComplete="username"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className={labelClass}>New Password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder={`Min ${MIN_PASSWORD} characters`}
                          className={inputClass}
                          autoComplete="new-password"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className={labelClass}>Confirm New Password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="password"
                          value={passwordConfirm}
                          onChange={(e) => setPasswordConfirm(e.target.value)}
                          placeholder="Re-enter new password"
                          className={inputClass}
                          autoComplete="new-password"
                          required
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      {submitting ? 'Resetting...' : 'Reset Password'}
                    </button>

                    <p className="text-center text-sm text-gray-500">
                      Remembered your password?{' '}
                      <button
                        type="button"
                        onClick={() => switchTab('login')}
                        className="text-blue-600 font-medium hover:underline"
                      >
                        Login
                      </button>
                    </p>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <footer className="py-6 text-center">
        <p className="text-sm text-white/70 mb-2">&copy; 2026 SmartHelp</p>
        <p className="text-xs text-white/50">
          By continuing you agree to our terms and privacy policy.
        </p>
      </footer>
      </div>
    </div>
  );
}
