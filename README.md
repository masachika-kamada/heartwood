# Heartwood

Draws software activity as the growth rings of a cross-cut trunk.

The picture is the product, not a reconstructed commit database. Each source
provides the smallest honest measurements it has — commit counts, dates,
authors or repositories, and changed lines only when they are actually known.
Missing measurements are omitted rather than replaced with invented values.

## Three ways in

- **A folder on this computer** — reads `.git` in the browser. Nothing leaves the
  machine.
- **`owner/repository`** — one public repository, through the GitHub API.
- **A username without a token** — a fast preview of the newest 500 public
  commits. It stops rather than waiting for another anonymous search window.
- **A username with a token** — GitHub's yearly commit-contribution data,
  grouped by date and repository, as one continuous trunk.

## How to read it

| In the drawing | In the history |
| --- | --- |
| Ring width | Activity volume: changed lines when known, otherwise commit count |
| Dark wood | Work between 22:00 and 05:00, only when exact author time is available |
| A thin pale ring | A period when nothing was committed |
| A scar | One measured change far larger than everything around it, when change size is available |
| Hue | Whoever committed most in that period — or, for a person's tree, whichever repository took most of it |

Long histories switch from monthly to yearly rings automatically, so a
fifteen-year history stays legible. The legend changes with the source: GitHub
contribution aggregates have no time-of-day or changed-line data, so they do
not pretend to show darkness or scars.

## Privacy

The local option reads `.git` **in the browser** using the File System Access
API. No file, name, or commit message leaves the machine — there is no server to
send it to. That is the point: work that lives on an internal host, or on a
laptop only, still counts.

The GitHub options call GitHub directly from the browser. Repository reads are
deliberately capped at the newest 1000 commits; use the local-folder option for
the complete history of a larger repository.

An anonymous username lookup uses at most five commit-search requests and
returns a partial newest-500 preview. With a token, Heartwood switches to the
GraphQL contribution model: one node can represent several commits on one date
and repository, and four years are requested together. This drops commit
messages, parents and other response fields that the drawing never uses.

GitHub contribution data follows GitHub's own counting rules. It is not a raw
walk of every branch, and GitHub can omit private or excess repository detail.
Heartwood marks that result partial rather than presenting it as complete.

## The optional token

The page accepts a token, folded away under the GitHub field:

| | Search | Everything else |
| --- | --- | --- |
| Anonymous | 10 / minute, shared by everyone on your address | 60 / hour |
| With a token | 30 / minute | 5,000 / hour |

It is optional and always will be — a tool that argues it needs no account
cannot then demand one. A token enables compact multi-year person histories and
draws repositories *you* can see rather than only the ones the world can. A
public-only token access is enough for public history; grant repository read
access only to count private work. The token is kept in this browser's local
storage and sent to `api.github.com` and nowhere else, because there is no
server here.

## Running it

```sh
npm install
npm run dev
```

```sh
npm test        # unit tests for the ring model and the git object parser
npm run build   # typecheck, then bundle to dist/
```

## Deploying

The output is a static folder with no backend, so anything that serves files
will do.

- **GitHub Pages** — `.github/workflows/deploy.yml` is included. Enable Pages
  with "GitHub Actions" as the source and push to `main`. The workflow sets
  `BASE_PATH` so the project subpath resolves.
- **Cloudflare Pages / Netlify / Vercel** — build command `npm run build`,
  output directory `dist`, no environment variables needed.

Browser support: opening a local folder needs the File System Access API
(Chrome, Edge, and other Chromium browsers). Everywhere else the page falls back
to the GitHub field and says so.

## Layout

```
src/core/      activity contracts, the ring model, deterministic randomness
src/sources/   where history comes from: local .git, a GitHub repository,
               a GitHub person, and a demo; plus the shared GitHub HTTP
               layer that handles rate limiting and the optional token
src/render/    canvas drawing and PNG export
src/ui/        the hover inspector
```

Sources produce an `ActivityHistory`; renderers consume a `TreeModel`. API
response details do not cross that line.
