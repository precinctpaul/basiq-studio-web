import { createClient } from "@supabase/supabase-js";

/**
 * Anon-key Supabase client for the browser. Confirmed (see the session's live
 * key check) that this key alone can do nothing against our tables — deny-all
 * RLS with no policies. Its only real job client-side is
 * storage.uploadToSignedUrl, which is authorised by the one-time token a
 * server route hands out, not by this key's own privileges.
 */
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
);
