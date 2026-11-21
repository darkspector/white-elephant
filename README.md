# 🐘 White Elephant

A party-host app for white elephant gift exchanges. Run it on one screen (laptop, or cast to the TV) and everyone plays from there.

**Play it:** https://darkspector.github.io/white-elephant/

## Features
- **Gifts with pictures.** Upload a photo (it gets resized automatically) or paste an image URL.
- **Custom wrapping.** Pick the paper color, pattern, ribbon, bow style, topper emoji and gift tag. During the game players only see the wrapping.
- **Classic rules.** Turn order is shuffled. On your turn you pick from the pile or steal; anyone who gets robbed picks again. Each gift has a max steal count before it locks, immediate steal-backs are blocked, and the first player gets an optional final swap.
- **Big reveal.** After the last round, each present shakes, the lid flies off, and the item and photo appear with confetti.
- Undo, a play-by-play log, a host "peek" toggle, and JSON export/import.

All data is stored in your browser's localStorage. Nothing gets uploaded anywhere.

## Deploying
- **Front end:** GitHub Pages serves `main`. Every push redeploys it.
- **Database:** The Supabase GitHub integration applies new files in `supabase/migrations/` on every push to `main`.
  To change the schema, add a new file named `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Never edit a migration that has already been applied.
- **Connection:** `config.js` holds the Supabase project URL and the publishable key. That key is public on purpose; access is enforced by row-level security and the database functions.