import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/contexts/AuthContext';
import AppOrSetupMessage from '@/components/auth/AppOrSetupMessage';
import { Toaster } from 'react-hot-toast';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: 'SmartHelp — Trusted home services, booked in minutes',
    template: '%s · SmartHelp',
  },
  description:
    'Book verified home service professionals in Bengaluru. Plumbers, electricians, carpenters, cleaners and more — transparent pricing, verified professionals, easy rescheduling.',
  keywords: [
    'home services',
    'Bengaluru',
    'book a plumber',
    'verified professionals',
    'SmartHelp',
  ],
  openGraph: {
    title: 'SmartHelp — Trusted home services, booked in minutes',
    description:
      'Book verified home service professionals in Bengaluru with transparent pricing.',
    type: 'website',
    locale: 'en_IN',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          {/* Replaces the app everywhere when Supabase is unreachable, so a
              missing .env.local reads as a setup step, not a crash. */}
          <AppOrSetupMessage>{children}</AppOrSetupMessage>
          <Toaster position="top-center" />
        </AuthProvider>
      </body>
    </html>
  );
}
