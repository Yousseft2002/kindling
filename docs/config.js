/* The Community tab's backend: a Supabase project.
 *
 * Both values are public by design - they are in every visitor's browser the
 * moment the page loads - and what protects the data is the row-level
 * security in supabase/schema.sql, not secrecy. Never put the service_role
 * key here: that one skips every rule.
 *
 * Supabase > Project Settings > API: "Project URL" and the "anon public" key.
 * Leave them empty and the Community tab simply does not appear.
 */
export const SUPABASE_URL = 'https://rqicodsmdbbdeihyntwo.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxaWNvZHNtZGJiZGVpaHludHdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzMTIzMzksImV4cCI6MjEwNTg4ODMzOX0._uau44ncGaz2eFft8xSFEj3ttoSlslt0c-mxRb6E3co';
