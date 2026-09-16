# Setup — about 30 minutes, $0

Three free services: **Supabase** (database + logins), **GitHub** (code, hosting, hourly sync job), **The Odds API** (DraftKings lines). No credit card anywhere.

```
The Odds API ──► GitHub Action (hourly) ──► Supabase ◄── GitHub Pages site (you + TJ)
ESPN scores  ──►
```

---

## 1. Supabase project

1. https://supabase.com → New project. Name it anything, region **West US**, save the database password (you won't need it again, but keep it).
2. Wait ~2 min for it to provision.
3. **SQL Editor → New query** → paste the entire contents of `supabase/schema.sql` → **Run**. Should end with "Success. No rows returned".
4. **Authentication → Sign In / Providers → Email**:
   - **Turn OFF "Allow new users to sign up."** ← Important. Otherwise anyone who finds the site can make an account and show up on the scoreboard. You'll add players yourself.
   - Leave "Confirm email" on or off, doesn't matter since you create the accounts.
5. **Authentication → Users → Add user → Create new user**: enter email + a password, tick **Auto Confirm User**. Do this for you and TJ. Tell TJ his password; he can change it via "Forgot password" later.
6. **Project Settings → API**. Copy three things:
   - Project URL (`https://xxxx.supabase.co`)
   - `anon` `public` key → goes in the website
   - `service_role` `secret` key → goes in GitHub secrets only. **Never put this in the website or commit it.**

Display names default to the part of your email before the `@` (so "rchristensen"). Click your name in the top-right of the app to change it, or run:
```sql
update public.profiles set display_name = 'Ryan' where display_name = 'rchristensen';
```

## 2. GitHub repo

1. Create a repo (private is fine). Push this folder to it.
2. Edit `docs/config.js` with your Project URL and anon key. Commit.
3. **Settings → Secrets and variables → Actions → New repository secret**, three times:
   - `SUPABASE_URL` = your project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role key
   - `ODDS_API_KEY` = your the-odds-api.com key
4. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder **`/docs`** → Save. Your site will be `https://<you>.github.io/<repo>/` in a minute or two.
5. **Actions tab → "Sync lines & scores" → Run workflow** (leave odds = `always`). Watch it go green. This loads this week's and next week's games with DraftKings lines. After that it runs itself every hour.
6. Back in Supabase: **Authentication → URL Configuration** → set **Site URL** to your GitHub Pages URL and add it to **Redirect URLs** too. This is only needed for the "forgot password" email link.

Open the site, sign in, pick.

## 3. Rules the app enforces (so nobody has to argue)

- **Lines lock when you pick.** Your number is DraftKings' number at the moment you click. Change your side later and you get the *new* number.
- **Picks lock at kickoff**, server-side. You can edit or remove a pick until then; the database refuses afterward.
- **Hidden until kickoff.** The database itself won't return another player's pick for a game that hasn't started. Not just hidden in the UI — you can't get it out of the API either.
- **Scoring:** 1 point per correct pick. One **gold** pick per week is worth 2. Wrong gold = 0, no penalty. No gold marked = all 1-pointers.
- **Missed pick = loss.** Every final game you didn't pick counts as an L (0 points) in your record and standings.
- **Pushes** don't count either way.
- **Weekly winner** = most points in a completed week. Ties are ties. Season tracks total points, W-L-P, weeks W-L-T.
- New players are only on the hook from the week they join (`profiles.first_week`).
- Weeks run Tuesday → Monday, Eastern time.

## 4. Adding a third player later

Supabase → Authentication → Users → Add user. That's it. They show up in standings starting that week.

## 5. Things that can bite you

- **The Odds API free tier = 500 credits/month.** The job pulls lines every 4 hours (~180/month). If you want more frequent line updates, change `ODDS_EVERY_HOURS` in `.github/workflows/sync.yml` — every 2 hours is ~360/month, still under the cap.
- **GitHub auto-disables scheduled workflows after 60 days with no commits** to the repo. Push something (even a README tweak) every month or two, or you'll notice in November that scores stopped updating. GitHub emails you before it does this.
- **Supabase pauses free projects after 7 days of inactivity.** The hourly sync counts as activity, so this won't happen while the job is running.
- **ESPN's scoreboard is an unofficial endpoint.** It's been stable for years but if it ever breaks, finals stop posting. Fix: set scores by hand in Supabase → Table Editor → games (`home_score`, `away_score`, `status = final`). The grading is all computed from those columns so nothing else needs touching.
- **Next week's lines** show up when DraftKings posts them, usually late Sunday / Monday. Until then next week is empty in the app.
- If a game is in the app with no line (`DK —`), nobody can pick it yet — the database refuses a pick with no spread.

## 6. Backfilling Week 2 Thursday

If the Thursday game kicks off before the site is live, text each other your picks and run `supabase/backfill-picks.sql` with the real values afterward.

## Files

```
supabase/schema.sql          the whole database: tables, lock/hide rules, scoring views
supabase/backfill-picks.sql  manual pick entry template
scripts/sync.mjs             lines + scores job (Node 22, no dependencies)
.github/workflows/sync.yml   runs sync.mjs hourly
docs/                        the website (GitHub Pages serves this folder)
  index.html / app.js / styles.css / config.js
```
