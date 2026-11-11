# Trip Route Mapper

Paste a text route like `HCMC - Vung Tau - Phan Thiet - Bao Loc`, see it drawn on a map along real roads, and record an animated video of the trip.

## Features

- Paste a route: splits on `-`, `→`, `->`, `>`, commas or new lines.
- Place lookup in Vietnam (or worldwide), with shortcuts for common names (HCMC, SG, HN, Dalat, …).
- Pick a different match from the dropdown, drag dots on the map, or click the map to add a stop.
- Road routing (OSRM), with a straight-line fallback.
- Animated preview: the line draws itself, the camera follows, stops appear as they are reached.
- Video recording in 16:9, 9:16 or 1:1, at 720p or 1080p (MP4 in Chrome and Safari, WebM in Firefox).
- Share link: the route is stored in the page URL.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

No build step and no API keys.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (files at the repository root).
2. Repository → Settings → Pages → Source: “Deploy from a branch”, branch `main`, folder `/ (root)`.
3. The site is published at `https://<user>.github.io/<repo>/`.

## Services used

| Purpose | Service | Limits |
|---|---|---|
| Map tiles | [OpenFreeMap](https://openfreemap.org) | Free, no key |
| Place lookup | [Nominatim](https://nominatim.org) → [Photon](https://photon.komoot.io) fallback | Nominatim: max 1 request/second; results are cached in the browser |
| Routing | [OSRM demo server](https://project-osrm.org) | Fair use, no uptime guarantee |

These free services suit personal use. For heavy public traffic, switch to keyed providers (MapTiler, OpenRouteService).

## Recording tips

- Keep the tab visible while recording; browsers pause animation in background tabs.
- Run Preview once first so map tiles are cached and the video has no blank areas.
