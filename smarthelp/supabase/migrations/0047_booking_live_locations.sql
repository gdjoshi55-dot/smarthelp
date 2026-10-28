CREATE TABLE IF NOT EXISTS public.booking_live_locations (
  booking_id UUID PRIMARY KEY REFERENCES public.bookings(id) ON DELETE CASCADE,
  customer_lat DOUBLE PRECISION,
  customer_lng DOUBLE PRECISION,
  professional_lat DOUBLE PRECISION,
  professional_lng DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.booking_live_locations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.booking_live_locations REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'booking_live_locations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.booking_live_locations;
  END IF;
END $$;
