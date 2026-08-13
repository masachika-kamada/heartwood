# Heartwood

Draws a git repository's history as the growth rings of a cross-cut trunk.

Not a contribution graph. A contribution graph is about a person and resets
every January; this is about a project, and it does not reset. A typo fix and a
three-day rewrite are the same square on a contribution graph — here one is a
hairline and the other is a scar.

## Three ways in

- **A folder on this computer** — reads `.git` in the browser. Nothing leaves the
  machine.
- **`owner/repository`** — one public repository, through the GitHub API.
- **A username** — everything that person has committed in public, across every
  repository, as one continuous trunk. This is the contribution-graph view,
  except it does not reset every January.

## How to read it

| In the drawing | In the history |
| --- | --- |
| Ring width | How much code changed that month |
| Dark wood | Commits made between 22:00 and 05:00, in the author's own timezone |
| A thin pale ring | A period when nothing was committed |
| A scar | One commit far larger than everything around it |
| Hue | Whoever committed most in that period — or, for a person's tree, whichever repository took most of it |

Long histories switch from monthly to yearly rings automatically, so a
fifteen-year project stays legible. Scars are picked across the whole history
rather than per month: marking the biggest commit of every month would speckle
the drawing and say nothing.

## Privacy

The local option reads `.git` **in the browser** using the File System Access
API. No file, name, or commit message leaves the machine — there is no server to
send it to. That is the point: work that lives on an internal host, or on a
laptop only, still counts.

The GitHub options call the public API from the browser. They are anonymous, so
they are rate limited, and neither endpoint reports change sizes — those trees
weigh every commit equally.

A person with more than 1000 public commits is fetched a year at a time, because
GitHub's search will not page past 1000 results for any one query. Anonymous
search allows ten requests a minute, so a busy account takes a minute or two and
the page waits out the limit rather than giving up. Around 1,600 commits takes
roughly 70 seconds.

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
src/core/      types, the ring model, deterministic randomness
src/sources/   where history comes from: local .git, a GitHub repository,
               a GitHub person, and a demo
src/render/    canvas drawing and PNG export
src/ui/        the hover inspector
```

Sources produce a `RepoHistory`; renderers consume a `TreeModel`. Nothing else
crosses that line, so a new source is a new file and nothing more.
