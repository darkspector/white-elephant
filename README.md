# 🐘 White Elephant

An online white elephant gift exchange, built for remote groups (e.g. over Discord).

**Play it:** https://darkspector.github.io/white-elephant/

## How it works
- **Create a group.** The host creates a group and shares the invite link. The host also gets a private host link for managing the group from any device.
- **Join and add a gift.** Players open the link and enter a name; no account is needed. Each player adds their own gift:
  - the item name and an optional description
  - a photo, either uploaded (resized automatically) or pasted as an image URL
  - custom wrapping: paper color, pattern, ribbon, bow style, topper emoji and gift tag
- **Contents stay secret.** Nobody, including the host, can see what's inside a gift until the reveal. The database enforces this.
- **Lobby.** The host can add people who can't use the link, remove players, close signups and set the rules.
- **Play live.** Turn order is shuffled. On your turn you pick from the pile or steal; anyone who gets robbed picks again. Gifts lock after a maximum number of steals, immediate steal-backs are blocked, and the first player gets an optional final swap. Players act on their own turn, and the host can act for anyone and undo moves. Big-screen mode is for screen-sharing.
- **Big reveal.** After the last round, the host or each gift's owner unwraps it. The animation plays on everyone's screen at once.

## Deploying
- **Front end:** GitHub Pages serves `main`. Every push redeploys it.
- **Database:** The Supabase GitHub integration applies new files in `supabase/migrations/` on every push to `main`.
  To change the schema, add a new file named `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Never edit a migration that has already been applied.
- **Connection:** `config.js` holds the Supabase project URL and the publishable key. That key is public on purpose; access is enforced by row-level security and the database functions.
- **Supabase settings:** Authentication → Sign In / Providers → **Allow anonymous sign-ins** must be on.
