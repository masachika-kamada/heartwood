import "./style.css";
import { buildTree } from "./core/tree";
import type { ActivityHistory, LoadProgress, TreeModel } from "./core/types";
import { activityNoun } from "./core/activity";
import { createDemoHistory } from "./sources/demo";
import { loadGitHubHistory, parseGitHubInput, type GitHubInput } from "./sources/github";
import { loadGitHubUserHistory } from "./sources/github-user";
import { loadLocalHistory } from "./sources/git/local";
import { createTreePainter, type TreePainter } from "./render/rings";
import { exportTreePng, treePngDataUrl } from "./render/export";
import { createInspector } from "./ui/inspector";
import { INPUT_EXAMPLES } from "./ui/examples";
import { readingFor } from "./ui/reading";
import { clearToken, hasToken, maskToken, readToken, saveToken } from "./sources/github-auth";
import { resetBudgets } from "./sources/github-http";
import {
  clearCachedHistories,
  readCachedHistory,
  writeCachedHistory,
} from "./sources/cache";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing mount point.");
}

app.innerHTML = `
  <div class="page">
    <header class="masthead">
      <h1 class="wordmark">Heartwood</h1>
      <p class="tagline">Every history has a cross-section. Cut one open.</p>
    </header>

    <form class="grow" id="github-form">
      <div class="grow__field">
        <input
          id="repo-input"
          class="grow__input"
          type="text"
          placeholder="owner/repository, or a GitHub username"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="A GitHub repository or username"
        />
        <button class="button button--primary" type="submit">Grow</button>
      </div>
      <p class="grow__aside">
        <span class="grow__label">Try</span>
        ${INPUT_EXAMPLES.map(
          (example) =>
            `<button class="chip" type="button" data-example="${example.value}">${example.value}</button>`,
        ).join("")}
        <span class="grow__label grow__label--or">or</span>
        <button id="pick-folder" class="chip chip--solid" type="button">
          open a folder on this computer
        </button>
      </p>
      <p class="grow__note" id="local-note">
        A repository draws one project; a username draws a person's work across all of
        theirs. A folder is read in your browser and never uploaded.
      </p>
    </form>

    <section class="stage">
      <div class="stage__frame">
        <canvas id="tree" aria-label="Growth rings drawn from a history of commits" role="img"></canvas>
        <canvas id="overlay" class="stage__overlay" aria-hidden="true"></canvas>
        <aside class="inspector" id="inspector" hidden></aside>
      </div>
      <p class="stage__status" role="status" aria-live="polite">
        <span id="status"></span>
        <button id="refresh" class="link" type="button" hidden>Read it again from GitHub</button>
      </p>
      <div class="stage__actions" id="actions" hidden>
        <button id="save-png" class="button" type="button">Save as PNG</button>
        <button id="copy-link" class="button" type="button" hidden>Copy link</button>
      </div>
    </section>

    <section class="reading" id="reading" hidden>
      <h2>Reading the rings</h2>
      <ul class="reading__list" id="reading-list"></ul>
    </section>

    <details class="token" id="token-drawer">
      <summary class="token__summary">
        <span id="token-summary-text">Add a GitHub token for a person's full history</span>
      </summary>
      <div class="token__body">
        <p class="token__note">
          Nothing here needs an account. Without a token a repository is still drawn whole,
          and a person is drawn from a sample of their public commits. With one, a person's
          trunk comes from GitHub's own contribution calendar instead, every year of it, and
          the hourly budget rises from sixty requests to five thousand.
        </p>
        <div class="token__row">
          <input
            id="token-input"
            class="grow__input"
            type="password"
            placeholder="ghp_… or github_pat_…"
            autocomplete="off"
            spellcheck="false"
            aria-label="GitHub personal access token"
          />
          <button id="token-save" class="button" type="button">Save</button>
          <button id="token-clear" class="button" type="button" hidden>Forget</button>
        </div>
        <p class="token__note token__note--fine">
          Kept in this browser's local storage and sent only to api.github.com; there is no
          server here to send it anywhere else. Public-only access is enough for public
          history. Grant repository read access only if you want private work counted.
          <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer noopener">Make one</a>.
        </p>
        <p class="token__state" id="token-state" role="status"></p>
      </div>
    </details>

    <footer class="colophon">
      <p>No server, no account, no upload. Drawn in your browser from <code>.git</code> or the GitHub API.</p>
    </footer>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#tree")!;
const overlay = document.querySelector<HTMLCanvasElement>("#overlay")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const actions = document.querySelector<HTMLDivElement>("#actions")!;
const reading = document.querySelector<HTMLElement>("#reading")!;
const readingList = document.querySelector<HTMLUListElement>("#reading-list")!;
const pickButton = document.querySelector<HTMLButtonElement>("#pick-folder")!;
const localNote = document.querySelector<HTMLParagraphElement>("#local-note")!;
const githubForm = document.querySelector<HTMLFormElement>("#github-form")!;
const repoInput = document.querySelector<HTMLInputElement>("#repo-input")!;
const savePngButton = document.querySelector<HTMLButtonElement>("#save-png")!;
const copyLinkButton = document.querySelector<HTMLButtonElement>("#copy-link")!;

const inspector = createInspector(
  document.querySelector<HTMLElement>("#inspector")!,
  canvas,
  overlay,
);

let currentTree: TreeModel | null = null;
let painter: TreePainter | null = null;
let inFlight: AbortController | null = null;
let animationHandle = 0;
let resizeHandle = 0;

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

function setStatus(message: string, tone: "idle" | "busy" | "error" = "idle"): void {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  if (tone !== "idle") {
    refreshButton.hidden = true;
  }
}

/** Repaints the trunk bitmap for the canvas's current size. */
function prepare(): void {
  if (!currentTree) {
    return;
  }
  painter = createTreePainter(canvas, currentTree);
  inspector.attach(currentTree, painter.layout);
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Grows the trunk outward once, so the picture arrives rather than appears. */
function animateGrowth(): void {
  cancelAnimationFrame(animationHandle);
  if (!painter) {
    return;
  }
  if (reducedMotion.matches) {
    painter.paint(1);
    return;
  }

  const startedAt = performance.now();
  const durationMs = 1500;
  const step = (now: number): void => {
    const t = Math.min(1, (now - startedAt) / durationMs);
    // Ease out: fast at the pith, settling as it reaches the bark.
    painter?.paint(1 - Math.pow(1 - t, 2.6));
    if (t < 1) {
      animationHandle = requestAnimationFrame(step);
    }
  };
  animationHandle = requestAnimationFrame(step);
}

function show(history: ActivityHistory): void {
  currentTree = buildTree(history);
  prepare();
  paintReading(currentTree);
  actions.hidden = currentTree.rings.length === 0;

  if (currentTree.rings.length === 0) {
    setStatus(`There are no ${activityNoun(currentTree.metric)} to draw.`, "error");
    painter?.paint(1);
    return;
  }

  const notes: string[] = [];
  if (currentTree.estimated) {
    notes.push("Sampled from public commits; stretches between samples are averaged.");
  } else if (currentTree.truncated) {
    notes.push("This is a partial history.");
  }
  setStatus(notes.join(" "));
  animateGrowth();
}

function paintReading(tree: TreeModel): void {
  const items = readingFor(tree);
  reading.hidden = items.length === 0;
  readingList.innerHTML = items
    .map(
      (item) => `
        <li class="reading__item">
          <span class="swatch swatch--${item.kind}" aria-hidden="true"></span>
          <div>
            <h3>${item.title}</h3>
            <p>${item.text}</p>
          </div>
        </li>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function beginLoad(): AbortSignal {
  inFlight?.abort();
  inFlight = new AbortController();
  return inFlight.signal;
}

function reportFailure(error: unknown): void {
  if (error instanceof DOMException && error.name === "AbortError") {
    return;
  }
  const message = error instanceof Error ? error.message : "Something went wrong.";
  setStatus(message, "error");
}

function progressText(phase: string, done: number, total: number | null): string {
  if (total === null && done === 0) {
    return `${phase}…`;
  }
  const count =
    total === null
      ? done.toLocaleString("en")
      : `${done.toLocaleString("en")} / ${total.toLocaleString("en")}`;
  return `${phase}… ${count}`;
}

const supportsDirectoryPicker = typeof window.showDirectoryPicker === "function";

if (!supportsDirectoryPicker) {
  pickButton.disabled = true;
  pickButton.title = "Opening a folder needs Chrome, Edge or another Chromium browser.";
  localNote.textContent =
    "A repository draws one project; a username draws a person's work across all of theirs. " +
    "This browser cannot open folders directly — Chrome and Edge can.";
}

pickButton.addEventListener("click", async () => {
  const picker = window.showDirectoryPicker;
  if (!picker) {
    return;
  }

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker.call(window, { mode: "read" });
  } catch (error) {
    // The picker throws AbortError when the visitor changes their mind.
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      reportFailure(error);
    }
    return;
  }

  const signal = beginLoad();
  setStatus("Reading commits…", "busy");
  pickButton.disabled = true;

  try {
    const history = await loadLocalHistory(
      handle,
      (phase, done, total) => setStatus(progressText(phase, done, total), "busy"),
      signal,
    );
    setLink(null);
    show(history);
  } catch (error) {
    reportFailure(error);
  } finally {
    pickButton.disabled = false;
  }
});

function canonical(input: GitHubInput): string {
  return input.kind === "user" ? input.login : `${input.target.owner}/${input.target.repo}`;
}

/** Signed and anonymous reads see different things, so they are cached apart. */
function cacheKey(input: GitHubInput): string {
  return `${input.kind}:${canonical(input).toLowerCase()}:${hasToken() ? "signed" : "anonymous"}`;
}

async function growFromGitHub(raw: string, fresh = false): Promise<void> {
  const parsed = parseGitHubInput(raw);
  if (!parsed) {
    setStatus("Try owner/repository, or a GitHub username.", "error");
    repoInput.focus();
    return;
  }

  const signal = beginLoad();
  const key = cacheKey(parsed);
  const cached = fresh ? null : readCachedHistory(key);
  if (cached) {
    setLink(canonical(parsed));
    show(cached.history);
    const minutes = Math.round((Date.now() - cached.savedAtMs) / 60_000);
    const age = minutes < 1 ? "a moment ago" : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
    setStatus(`${statusEl.textContent} Read ${age}.`.trim());
    refreshButton.hidden = false;
    return;
  }

  setStatus(parsed.kind === "user" ? "Looking for commits…" : "Reading the repository…", "busy");

  try {
    const report: LoadProgress = (phase, done, total) =>
      setStatus(progressText(phase, done, total), "busy");

    const history =
      parsed.kind === "user"
        ? await loadGitHubUserHistory(parsed.login, report, signal)
        : await loadGitHubHistory(parsed.target, report, signal);

    writeCachedHistory(key, history);
    setLink(canonical(parsed));
    show(history);
  } catch (error) {
    reportFailure(error);
  }
}

githubForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void growFromGitHub(repoInput.value);
});

refreshButton.addEventListener("click", () => {
  void growFromGitHub(repoInput.value, true);
});

/**
 * The one field accepts two different things, and a sentence explaining that is
 * easy to skip. A worked example is not: clicking one draws a tree, and the
 * field is left holding the text that did it.
 */
for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-example]")) {
  chip.addEventListener("click", () => {
    repoInput.value = chip.dataset.example ?? "";
    githubForm.requestSubmit();
  });
}

/* ------------------------------------------------------------------ *
 * A tree has an address
 * ------------------------------------------------------------------ */

/** The address bar names the tree on screen, so a link draws the same one. */
function setLink(name: string | null): void {
  const next = name ? `#${name}` : "";
  if (window.location.hash !== next) {
    window.history.replaceState(null, "", next || window.location.pathname + window.location.search);
  }
  copyLinkButton.hidden = name === null;
  if (name !== null) {
    repoInput.value = name;
  }
}

function linkedName(): string | null {
  const name = decodeURIComponent(window.location.hash.replace(/^#\/?/, "")).trim();
  return name !== "" && parseGitHubInput(name) ? name : null;
}

window.addEventListener("hashchange", () => {
  const name = linkedName();
  if (name && name.toLowerCase() !== repoInput.value.trim().toLowerCase()) {
    repoInput.value = name;
    void growFromGitHub(name);
  }
});

copyLinkButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyLinkButton.textContent = "Copied";
  } catch {
    copyLinkButton.textContent = "Copy it from the address bar";
  }
  setTimeout(() => {
    copyLinkButton.textContent = "Copy link";
  }, 1800);
});

/* ------------------------------------------------------------------ *
 * The optional token
 * ------------------------------------------------------------------ */

const tokenInput = document.querySelector<HTMLInputElement>("#token-input")!;
const tokenSave = document.querySelector<HTMLButtonElement>("#token-save")!;
const tokenClear = document.querySelector<HTMLButtonElement>("#token-clear")!;
const tokenState = document.querySelector<HTMLParagraphElement>("#token-state")!;
const tokenSummaryText = document.querySelector<HTMLSpanElement>("#token-summary-text")!;

function paintTokenState(message = ""): void {
  const token = readToken();
  tokenClear.hidden = token === null;
  tokenSummaryText.textContent = token
    ? `GitHub token saved · ${maskToken(token)}`
    : "Add a GitHub token for a person's full history";
  tokenState.textContent = message;
  tokenInput.value = "";
  tokenInput.placeholder = token ? "Replace the saved token" : "ghp_… or github_pat_…";
}

tokenSave.addEventListener("click", () => {
  const value = tokenInput.value.trim();
  if (value === "") {
    paintTokenState("Paste a token first.");
    return;
  }

  const outcome = saveToken(value);
  if (outcome === "invalid") {
    paintTokenState("That does not look like a token, so it was not saved.");
    return;
  }
  if (outcome === "unavailable") {
    paintTokenState(
      "This browser will not let the page store anything, so the token cannot be kept.",
    );
    return;
  }

  // The old budget belonged to the anonymous caller; the token has its own.
  resetBudgets();
  paintTokenState("Saved. Requests from this browser now go out signed.");
});

tokenClear.addEventListener("click", () => {
  const outcome = clearToken();
  if (outcome === "unavailable") {
    paintTokenState("This browser would not remove the saved token.");
    return;
  }

  resetBudgets();
  // What the token could see should not outlive the token.
  clearCachedHistories();
  paintTokenState("Forgotten. Back to anonymous requests.");
});

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    // This control sits outside the GitHub form, so make Enter act like Save.
    event.preventDefault();
    tokenSave.click();
  }
});

paintTokenState();

savePngButton.addEventListener("click", async () => {
  if (!currentTree) {
    return;
  }
  try {
    await exportTreePng(currentTree);
  } catch (error) {
    reportFailure(error);
  }
});

window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeHandle);
  resizeHandle = requestAnimationFrame(() => {
    cancelAnimationFrame(animationHandle);
    prepare();
    painter?.paint(1);
  });
});

/**
 * For `scripts/render.mjs`, which opens this page in a headless browser to
 * turn a history into image files. It needs to know when the tree has
 * settled, and to ask for the picture without clicking through a download.
 */
window.heartwood = {
  state: () =>
    statusEl.dataset.tone === "busy"
      ? "busy"
      : statusEl.dataset.tone === "error"
        ? "error"
        : "ready",
  message: () => statusEl.textContent ?? "",
  png: (options) => (currentTree ? treePngDataUrl(currentTree, options) : null),
};

const linked = linkedName();
if (linked) {
  repoInput.value = linked;
  void growFromGitHub(linked);
} else {
  show(createDemoHistory());
  setStatus("A made-up project, so the page is not empty. Grow one of your own.");
}
