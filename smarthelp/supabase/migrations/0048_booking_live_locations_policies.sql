-- RLS policies for booking_live_locations
-- Allow read/write only to the customer and professional of the booking

CREATE POLICY "Users can read their booking live locations"
  ON public.booking_live_locations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.customers c ON c.id = b.customer_id
      WHERE b.id = booking_live_locations.booking_id
        AND c.profile_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.professionals p ON p.id = b.professional_id
      WHERE b.id = booking_live_locations.booking_id
        AND p.profile_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert/update their booking live locations"
  ON public.booking_live_locations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.customers c ON c.id = b.customer_id
      WHERE b.id = booking_live_locations.booking_id
        AND c.profile_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.professionals p ON p.id = b.professional_id
      WHERE b.id = booking_live_locations.booking_id
        AND p.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.customers c ON c.id = b.customer_id
      WHERE b.id = booking_live_locations.booking_id
        AND c.profile_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.professionals p ON p.id = b.professional_id
      WHERE b.id = booking_live_locations.booking_id
        AND p.profile_id = auth.uid()
    )
  );
