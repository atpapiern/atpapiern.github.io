# Stadium Finder

A static site for finding college football, basketball and baseball venues, MLB ballparks and
minor league ballparks within driving distance of any US town. Track the ones you've visited.
No server, no API keys, no build step.

## Put it on GitHub Pages
1. Create a repo (e.g. `stadium-finder`) and upload everything in this folder.
2. Settings > Pages > Deploy from a branch > `main` / `(root)`.
3. Visit `https://<you>.github.io/stadium-finder/`.

## Files
- `index.html`, `style.css`, `app.js` - the site (no inline code, no CDNs)
- `icon.svg` - the stadium icon (favicon and header)
- `data.js` - generated venue data (don't edit by hand)
- `map.js` - generated, simplified basemap used behind the Radar view
- `data/*.csv` - editable source data
- `data/extra_coords.json` - hand-entered approximate city coordinates for towns not in your geocode cache
- `build_data.py` - regenerates `data.js` from the CSVs: `python build_data.py`
- `tools/build_map.js` - regenerates `map.js` (only needed if you want to change the map detail)

## Data
| Level | File | Count |
|---|---|---|
| FBS Football | `fbs.csv` | 138 |
| FCS Football | `fcs.csv` | 121 |
| D1 College Baseball | `baseball.csv` | 230 |
| Men's Basketball (power conferences + Big East) | `basketball.csv` | 81 |
| MLB Baseball | `mlb.csv` | 30 |
| Minor League Baseball (Triple-A to Single-A, 2026 affiliations) | `milb.csv` | 120 |

Coordinates are city centers, not the stadiums themselves, so drive times are approximate.
Affiliations, names and conferences change often. Verify anything you plan a trip around.

## Updating data
Edit a CSV, run `python build_data.py` (it needs your local `geocode_cache.json` next to it), commit `data.js`.
To add another level, add a line to `LEVELS` in `build_data.py` plus a CSV, and give it a shape in
`shapePath()` in `app.js`. New towns need coordinates: add them to `data/extra_coords.json`
as `"city, st, usa": [lat, lon]`.

## Security and privacy
- Strict Content-Security-Policy: only this site's own scripts and styles, and network access only to
  Nominatim (place lookup) and OSRM (drive times). The map is embedded data, so no map tiles are loaded.
- All text is inserted with `textContent`; there's no `innerHTML`, so typed text, shared links
  and imported backups can't inject code. Imports, URL values and saved data are validated.
- CSV exports neutralise spreadsheet formulas. External links use `rel="noopener noreferrer"`.
- The visited list and settings live in the visitor's own browser (`localStorage`).
- "Use my location" is rounded to about 1 km and only used for routing.
- Don't publish `geocode_cache.json`. It includes places you searched from. It's in `.gitignore`,
  and `data.js` only contains the school and team towns.
- GitHub Pages can't set HTTP headers, so the CSP is a meta tag. The free OSRM and Nominatim
  servers are shared and rate-limited; for heavy traffic, self-host or use a paid routing API.
