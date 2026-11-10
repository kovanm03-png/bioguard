# Bio Guard website

Bilingual (English and Kurdish Sorani, RTL) website for Bio Guard, a supplement and gym store in Sulaymaniyah.

## How it is published
Cloudflare builds this repository on every push (`wrangler.jsonc`). It serves the `Bio Guard Demo/` folder as the website and runs `worker/index.js` for the admin panel.

- Website: `/`
- Admin panel: `/admin` (the Admin link is also in the footer). Manager can edit every text (English and Kurdish), replace or remove photos, and add gallery photos.
- Saved edits and uploaded photos live in a Workers KV namespace named `BG_KV` (created automatically on the first deploy). They are not in Git.

## Admin password
The password hash is in `wrangler.jsonc` (`ADMIN_PASSWORD_HASH`). To change it without touching code, add a **secret** called `ADMIN_PASSWORD` to the Worker in the Cloudflare dashboard (Settings > Variables and Secrets); it takes priority. Anyone can read this repository's files, so use a long password and set it as a secret.

## Other folders
- `Bio Guard Demo/` also runs locally with Node.js: `node serve.js`, then open http://localhost:5180 and http://localhost:5180/admin (password in `admin-password.txt`, never commit that file).
- `index.html` (root) is the whole site as a single file for quick previews. It has no admin.
- `src/` has the editable source (`template.html`, `admin.html`, `atlas.js`) and `build.ps1`, which builds the files above.
## Checks

- `node worker/test.mjs` runs 64 checks on the admin server code and the opening-hours logic (no Cloudflare account needed).
- `npx wrangler dev --local` runs the real Worker and the site on this computer.

## Optional Cloudflare settings

- Secret `ADMIN_PASSWORD`: a stronger admin password (wins over the one in `wrangler.jsonc`).
- Variable `CANONICAL_ORIGIN` (for example `https://bioguard.example`): the one web address search engines and link previews should use, once the site has its own domain.
