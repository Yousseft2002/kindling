# Turning on the Community tab

About 15 minutes, once. Until `docs/config.js` has a URL and key, the tab stays
hidden and the site works exactly as before.

## 1. Create the project

1. Sign up at https://supabase.com (free plan) and click **New project**.
2. Name it `kindling`, set a database password (keep it somewhere safe; the app never
   needs it), and pick the region closest to most of your users.

## 2. Create the tables

1. In the project: **SQL Editor > New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**. It should say "Success".
   Running it again later is safe.

## 3. Sign-in settings

**Authentication > URL Configuration**

- **Site URL:** `https://yousseft2002.github.io/kindling/`
- **Redirect URLs:** add `https://yousseft2002.github.io/kindling/`

**Authentication > Emails > Magic Link**: so people can type a code instead of
tapping the link (handy inside the installed app), add this line to the template:

```
Or type this code in Kindling: {{ .Token }}
```

**An email sender (needed before you invite anyone).** Supabase's built-in email is
for testing: it only sends a few emails an hour and may refuse addresses outside
your own team. Connect a real sender under **Project Settings > Authentication > SMTP**.
Resend (https://resend.com) has a free tier: create an API key there and fill in
host `smtp.resend.com`, port `465`, user `resend`, password = the API key, and a
sender address on a domain you've verified with Resend.

## 4. Connect the site

**Project Settings > API**: copy the **Project URL** and the **anon public** key into
`docs/config.js`:

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...';
```

Both are safe to publish; the security rules in `schema.sql` protect the data.
**Never** paste the `service_role` key anywhere in the site.

Commit and push. The Community tab appears about a minute later.

## Running it day to day

- **Reported posts:** Table Editor > `itineraries`, filter `hidden = true`. Delete
  the post, or set `hidden` back to false to restore it. The reasons are in `reports`.
- **Removing someone:** Authentication > Users > delete the user. Their profile,
  posts, loves and reports go with them.
- **Deleting an account on request** (the privacy page promises this): the same.
- **Local guides** are automatic: 3 visible evenings in a city with 10 loves between them.
  Change the numbers in the `guide_scores` view in `schema.sql`, and `GUIDE_POSTS` /
  `GUIDE_LOVES` in `docs/lib/community.js` so the page explains it correctly.
