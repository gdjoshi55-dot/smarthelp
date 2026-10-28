GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_live_locations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.booking_live_locations TO anon;

-- Ensure RLS is enforced
ALTER TABLE public.booking_live_locations ENABLE ROW LEVEL SECURITY;
