# Bio Guard website demo

Bilingual (English and Kurdish Sorani, RTL) website for Bio Guard, a supplement and gym store in Sulaymaniyah.

- `index.html` is the whole site as one file. Open it in a browser, or host it on GitHub Pages.
- `Bio Guard Demo/` is the version with the admin panel (needs Node.js): run `node serve.js`, then open http://localhost:5180 and http://localhost:5180/admin. Set the admin password with the `ADMIN_PASSWORD` environment variable or an `admin-password.txt` file (never commit that file).
- `src/` has the editable source (`template.html`, `admin.html`, `atlas.js`) and `build.ps1`, which builds the files above.
