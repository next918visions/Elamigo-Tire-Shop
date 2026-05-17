# What's New — May 2026 Patch

This release patches the three pain points from the prior build:
**(1)** photos that didn't load in every location, **(2)** edits that didn't persist,
**(3)** admin + locations + index not tied together.

## Real content baked in (no backend required)
The site now ships with the real photos and managers embedded directly.
A fresh visitor sees the correct site immediately — no Supabase, no localStorage warm-up.

| Location | Manager | Storefront | Photo | Phone |
|---|---|---|---|---|
| Claremore West (627½ W Ramm Rd, 74017) | Alex | `assets/photos/cw-storefront.jpg` | `assets/photos/cw-manager.jpg` | (918) 269-0917 |
| Claremore East (420 E 2nd St, 74017) | Gustavo | `assets/photos/ce-storefront.jpg` | `assets/photos/ce-manager.jpg` | (918) 282-6914 |
| Owasso (11625 N 113 E Ave, Collinsville 74021) | Alex | `assets/photos/ow-storefront.jpg` | `assets/photos/ow-manager.jpg` | (918) 269-0917 |

Owner: **Alex Udifuentez**

## Single admin login
- URL: `admin.html`
- Username (informational): `elamigotireshop1@gmail.com`
- Password: **`ElamigoVision1`** (auto-seeded on first visit; change it via Settings)

## New admin features
- **📹 Home Page Videos** card on Brand & Hours — paste YouTube URLs, they render on the home page.
- **🔗 Extra Links** card on Brand & Hours — add Instagram, Google Reviews, promo pages.
  They show in the footer's "Menu" column.
- **Per-location videos** already worked; baked YouTube links are already wired in.

## Publish flow
Admin → 🚀 Publish & Download ZIP

This bakes your current admin state (text + photo URLs + tweaks) into a fresh
`index.html` you can drop into your GitHub repo. Everyone who visits sees that exact state.

## Deploy to GitHub Pages
1. Create a repo (e.g. `el-amigo-site`) on github.com.
2. Drag every file in this folder onto the repo's web upload page.
3. Settings → Pages → Source = `main` branch, folder `/` (root). Save.
4. ~30 seconds later: live at `https://YOUR-USERNAME.github.io/el-amigo-site/`.

## First-time setup note
If you previously edited the admin in your browser, you have stale localStorage data
that will override the new baked defaults. To see fresh defaults:
**Admin → Settings → 🗑 Reset to Defaults**
(or just open the site in an incognito window once to confirm).
