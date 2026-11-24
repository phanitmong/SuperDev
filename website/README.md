# Apsara Panel website

Plain files, no build step. Open `index.html` to look at it.

- `config.js` is the only file to change for a release: the version, and the address the installers are downloaded from. Until `releases` is filled in, the download buttons say the first release is not published yet. An installer listed in `soon` (Windows for now) shows "Coming soon" instead of a link; take it out of `soon` once that file is uploaded to the release.
- `assets/` holds the screenshots (taken from the app), the icon and the font.

To publish: upload this folder to a web host, or enable GitHub Pages for it.

## Privacy and Terms

`privacy.html` and `terms.html` describe what the app really does (checked against the code on 21 November 2026). Before the site goes public, fill in `publisher`, `contactEmail` and `governingLaw` in `config.js`, and have someone who knows the law of your country read both pages: they were written from the software's behaviour, not by a lawyer.
