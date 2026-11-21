# 🐘 White Elephant

An online white elephant gift exchange, built for remote groups (e.g. over Discord).

**Play it:** https://darkspector.github.io/white-elephant/

> ## 📌 Yearly reminder: reactivate the project before next season
> The database runs on Supabase's free plan, which **pauses a project after about a week with no activity**.
> A scheduled job (`.github/workflows/keepalive.yml`) pings it twice a week, but **only until Dec 31, 2026**.
> After that the project will go to sleep and the site will stop connecting.
>
> **To bring it back for the next season:**
> 1. Log in at [supabase.com](https://supabase.com) (Continue with GitHub) and **restore** the paused `white-elephant` project.
> 2. Edit `.github/workflows/keepalive.yml` and change `KEEPALIVE_UNTIL` to the new end date (for example `20271231`).
> 3. Push the change. GitHub also turns off scheduled jobs in repos with no commits for 60 days, so this push re-enables it. If it still shows as disabled, turn it back on under the repo's **Actions** tab.
>
> Old groups will be gone by then (they are deleted 8 weeks after creation), so everyone starts fresh.

## How it works
- **Create a group.** The host creates a group, optionally with a **group password**, and shares the invite link. The host also gets a private host link for managing the group from any device.
- **Limits.** At most **5 groups** exist at a time, and each group is **deleted automatically 8 weeks after it was created**. The lobby shows the start and end dates, plus the **event date** the host sets.
- **Join and add a gift.** Players open the link, enter a name (and the group password if there is one); no account is needed. Each player adds their own gift:
  - the item name and an optional description
  - a photo, either uploaded (resized automatically) or pasted as an image URL
  - custom wrapping: paper color, pattern, ribbon, bow style, topper emoji and gift tag
- **Contents stay secret.** Nobody, including the host, can see what's inside a gift until the reveal. The database enforces this.
- **Lobby.** The host can add people who can't use the link, remove players, close signups, set the rules, and reset a player's link if they switch device or browser.
- **Play live.** Turn order is shuffled. On your turn you pick from the pile or steal; anyone who gets robbed picks again.
  - Gifts lock after a maximum number of steals, and immediate steal-backs are blocked.
  - The first player gets an optional final swap.
  - Optional rule (on by default): nobody can end up with the gift they brought.
  - Players act on their own turn and get a sound and tab-title alert. The host can act for anyone and undo moves.
  - Big-screen mode is for screen-sharing.
- **Gift tracker.** A live panel shows every gift and the chain of people who have held it.
- **Big reveal.** After the last round, the host or each gift's owner unwraps it. The animation plays on everyone's screen at once. Afterwards, one button copies the results (who got what, and from whom) to paste into Discord.

## Deploying
- **Front end:** GitHub Pages serves `main`. Every push redeploys it.
- **Database:** The Supabase GitHub integration applies new files in `supabase/migrations/` on every push to `main`.
  To change the schema, add a new file named `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Never edit a migration that has already been applied.
- **Connection:** `config.js` holds the Supabase project URL and the publishable key. That key is public on purpose; access is enforced by row-level security and the database functions.
- **Supabase settings:** Authentication → Sign In / Providers → **Allow anonymous sign-ins** must be on.
