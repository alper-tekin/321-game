# 3-2-1 Football

A fast two-player football trivia game played from separate devices. After a 3-2-1 countdown, each player
reveals a club. The first player to name a footballer who has played for **both clubs** wins the point.

**Live:** https://three21-futbol-j61h.onrender.com

## How to play

1. One player creates a room and shares the 4-digit code (or the invite link).
2. The other player joins with the code.
3. Each round, both players secretly pick a club. Picks are revealed at the same time after the countdown.
   Each club can be picked only once per match — once either player has picked a club, neither can pick it again.
4. Type a player who has played for both clubs. Small typos and surname-only answers are accepted
   (`snejder` → Wesley Sneijder).
5. If a correct answer is rejected because the data is missing a transfer, the opponent can press
   **Doğru say** ("count it") to award the point anyway.
6. First to the target score (3, 5, 7 or 10) wins the match.

If a player doesn't pick within 20 seconds, a random popular club is chosen for them. If the two clubs have
no player in common, the round is void. If neither player names a common player within 15 seconds, the round
is passed.

## Running locally

Requires Node.js 20 or later.

```bash
npm install
npm start
```

The game runs at `http://localhost:3210`. Devices on the same Wi-Fi network can join using your computer's
local IP address (e.g. `http://192.168.0.13:3210`).

## Data

Club and player data is built from three open sources and saved to `data/football.json`:

1. **[Wikidata](https://www.wikidata.org)** (CC0): clubs, players, club history, and names and
   aliases in Turkish and English.
2. **[Transfermarkt transfer history](https://github.com/dcaribou/transfermarkt-datasets)** (CC0):
   historical transfers that Wikidata is missing (dataset up to July 6, 2026).
3. **Wikipedia current squads** (CC BY-SA): squad templates from English Wikipedia club pages,
   which pick up new transfers quickly.

Club logos are also fetched at build time as small (144 px) thumbnail URLs from the clubs' English
Wikipedia page images; clubs without an image simply have no logo in the game.

To rebuild the data (takes a few minutes; intermediate results are cached in `scripts/.cache`):

```bash
npm run build-data
```

### Manual corrections

Wikidata is sometimes slow to record recent transfers. Missing club memberships can be added by hand in
`data/overrides.json` (keys are player Wikidata IDs, values are lists of club Wikidata IDs), then applied
with `npm run build-data`. Remove an override once Wikidata has caught up.

## Project structure

| Path | Description |
|---|---|
| `server.js` | HTTP server, static files, `/api/clubs`, `/api/players` and the WebSocket endpoint |
| `game.js` | Rooms, rounds, timers and scoring (the server is the source of truth) |
| `data.js` | Loads the dataset, finds common players and checks answers |
| `public/` | Mobile-first browser client |
| `scripts/build-data.mjs` | Data build script |
| `test/` | Answer-matching tests against the real dataset |

## Themes

Four selectable themes are available via the 🎨 button in the top-right corner: **Night Match**
(default), **Retro Poster**, **Light** and **Neon**. The choice is stored in the browser.

## Tests

```bash
npm test
```

## Deployment

The repository includes a `render.yaml` blueprint for [Render](https://render.com)'s free plan. Every push to
`main` is deployed automatically. Free instances sleep after 15 minutes of inactivity, so the first request
after a break can take about 50 seconds.
