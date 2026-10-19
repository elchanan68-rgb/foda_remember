/* Public browser settings only. These are not secrets. Never put a Supabase secret key here. */
window.FODA_PUBLIC_CONFIG = Object.freeze({
  // Example: https://YOUR-PROJECT.supabase.co/functions/v1/family-memories
  apiUrl: '',
  // Cloudflare Turnstile site keys are public; its secret key belongs in Supabase Edge Function Secrets.
  turnstileSiteKey: ''
});
