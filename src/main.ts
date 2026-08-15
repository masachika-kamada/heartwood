import "./style.css";
import { buildTree } from "./core/tree";
import type { ActivityHistory, LoadProgress, TreeModel } from "./core/types";
import { activityNoun } from "./core/activity";
import { createDemoHistory } from "./sources/demo";
import { loadGitHubHistory, parseGitHubInput } from "./sources/github";
import { loadGitHubUserHistory } from "./sources/github-user";
import { loadLocalHistory } from "./sources/git/local";
import { renderTree } from "./render/rings";
import { exportTreePng } from "./render/export";
import { createInspector } from "./ui/inspector";
import { INPUT_EXAMPLES } from "./ui/examples";
import { clearToken, maskToken, readToken, saveToken } from "./sources/github-auth";
import { resetBudgets } from "./sources/github-http";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing mount point.");
}

app.innerHTML = `
  <div class="page">
    <header class="masthead">
      <h1>Heartwood</h1>
      <p class="tagline">Every repository has a cross-section. This one is yours.</p>
    </header>

    <section class="stage">
      <canvas id="tree" aria-label="Growth rings drawn from a repository's history" role="img"></canvas>
      <div class="stage__status" id="status" role="status" aria-live="polite"></div>
      <aside class="inspector" id="inspector" hidden></aside>
    </section>

    <section class="controls">
      <div class="control control--primary">
        <button id="pick-folder" class="button button--primary" type="button">
          Open a folder on this computer
        </button>
        <p class="control__note" id="local-note">
          Read directly in your browser. Nothing is uploaded, not even the repository name.
        </p>
      </div>

      <form class="control" id="github-form">
        <label class="control__label" for="repo-input">…or a GitHub repository, or a person</label>
        <div class="control__row">
          <input
            id="repo-input"
            class="input"
            type="text"
            placeholder="owner/repository, or a username"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="button" type="submit">Grow</button>
        </div>
        <p class="control__note">
          Two things fit in that one field. <strong>owner/repository</strong> draws a single
          project. <strong>A username on its own</strong> draws that person's GitHub commit
          activity across repositories as one continuous trunk.
        </p>
        <p class="control__examples">
          <span class="control__examples-label">Try</span>
          ${INPUT_EXAMPLES.map(
            (example) =>
              `<button class="chip" type="button" data-example="${example.value}">${example.value}</button>`,
          ).join("")}
        </p>
        <p class="control__note control__note--fine">
          Without a token, a username samples up to 500 public commits across the account's
          lifetime. With a token, GitHub's yearly contribution data supplies
          the longer history in a handful of requests.
        </p>
      </form>
    </section>

    <details class="token" id="token-drawer">
      <summary class="token__summary">
        <span id="token-summary-text">Want the full person history? Add a GitHub token</span>
      </summary>
      <div class="token__body">
        <p class="token__note">
          Anonymous searching gets ten requests a minute, shared by everyone on your
          address; a token gets thirty, and lifts ordinary requests from sixty an hour to
          five thousand. For a person, it also switches from a short search preview to
          GitHub's compact yearly commit-contribution data.
        </p>
        <div class="control__row">
          <input
            id="token-input"
            class="input"
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
          Kept in this browser's local storage and sent only to api.github.com. There is no
          server here to send it anywhere else. Public-only access is enough for public
          history; grant repository read access only if you want private work counted.
          <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer noopener">Make one</a>.
        </p>
        <p class="token__state" id="token-state" role="status"></p>
      </div>
    </details>

    <section class="legend" id="legend" hidden>
      <h2>How to read it</h2>
      <ul>
        <li id="legend-volume"><span class="swatch swatch--thick"></span> <span id="legend-volume-text"></span></li>
        <li><span class="swatch swatch--hue"></span> Uneven growth shows when activity clustered within each period, from its start at the top clockwise.</li>
        <li id="legend-night"><span class="swatch swatch--dark"></span> Darker wood is work done between 22:00 and 05:00, in the author's own timezone.</li>
        <li><span class="swatch swatch--pinched"></span> <span id="legend-dormant-text"></span></li>
        <li id="legend-scar"><span class="swatch swatch--scar"></span> A scar is a single change far larger than everything around it.</li>
        <li id="legend-group"><span class="swatch swatch--hue"></span> <span id="hue-note"></span></li>
      </ul>
      <div class="legend__actions">
        <button id="save-png" class="button" type="button">Save as PNG</button>
      </div>
    </section>

    <footer class="colophon">
      <p>Reads <code>.git</code> in the browser. No server, no account, no upload.</p>
    </footer>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#tree")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const legend = document.querySelector<HTMLElement>("#legend")!;
const pickButton = document.querySelector<HTMLButtonElement>("#pick-folder")!;
const localNote = document.querySelector<HTMLParagraphElement>("#local-note")!;
const githubForm = document.querySelector<HTMLFormElement>("#github-form")!;
const repoInput = document.querySelector<HTMLInputElement>("#repo-input")!;
const savePngButton = document.querySelector<HTMLButtonElement>("#save-png")!;
const hueNote = document.querySelector<HTMLSpanElement>("#hue-note")!;
const legendVolumeText = document.querySelector<HTMLSpanElement>("#legend-volume-text")!;
const legendDormantText = document.querySelector<HTMLSpanElement>("#legend-dormant-text")!;
const legendNight = document.querySelector<HTMLLIElement>("#legend-night")!;
const legendScar = document.querySelector<HTMLLIElement>("#legend-scar")!;
const legendGroup = document.querySelector<HTMLLIElement>("#legend-group")!;

const inspector = createInspector(
  document.querySelector<HTMLElement>("#inspector")!,
  canvas,
);

let currentTree: TreeModel | null = null;
let inFlight: AbortController | null = null;
let animationHandle = 0;

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

function setStatus(message: string, tone: "idle" | "busy" | "error" = "idle"): void {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.hidden = message === "";
}

function draw(reveal = 1): void {
  if (!currentTree) {
    return;
  }
  renderTree(canvas, currentTree, { reveal });
}

/** Grows the trunk outward once, so the picture arrives rather than appears. */
function animateGrowth(): void {
  cancelAnimationFrame(animationHandle);
  const startedAt = performance.now();
  const durationMs = 900;

  const step = (now: number): void => {
    const t = Math.min(1, (now - startedAt) / durationMs);
    // Ease out: fast at the pith, settling as it reaches the bark.
    draw(1 - Math.pow(1 - t, 3));
    if (t < 1) {
      animationHandle = requestAnimationFrame(step);
    }
  };

  animationHandle = requestAnimationFrame(step);
}

function show(history: ActivityHistory): void {
  currentTree = buildTree(history);
  inspector.attach(currentTree);
  legend.hidden = false;
  paintLegend(currentTree);

  if (currentTree.rings.length === 0) {
    setStatus(`There are no ${activityNoun(currentTree.metric)} to draw.`, "error");
    draw();
    return;
  }

  const truncatedNote = currentTree.truncated ? " This is a partial history." : "";
  setStatus(
    `${currentTree.name} · ${currentTree.totalActivities.toLocaleString("en")} ${activityNoun(currentTree.metric, currentTree.totalActivities)}.${truncatedNote}`,
  );
  animateGrowth();
}

function paintLegend(tree: TreeModel): void {
  legendVolumeText.textContent =
    tree.metric === "lines"
      ? "A wide ring is a period when a lot of code changed."
      : `A wide ring is a period with many ${activityNoun(tree.metric)}.`;
  legendDormantText.textContent =
    `A thin pale ring is a period with no ${activityNoun(tree.metric)}.`;
  legendNight.hidden = !tree.hasNightData;
  legendScar.hidden = !tree.hasOutlierData;
  legendGroup.hidden = tree.groupKind === "none";
  hueNote.textContent =
    tree.groupKind === "repositories"
      ? "Hue follows whichever repository took most of that period."
      : tree.groupKind === "authors"
        ? "Hue follows whoever committed most in that period."
        : "";
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

const supportsDirectoryPicker = typeof window.showDirectoryPicker === "function";

if (!supportsDirectoryPicker) {
  pickButton.disabled = true;
  localNote.textContent =
    "Your browser cannot open folders directly. Chrome or Edge can; meanwhile, try a public repository below.";
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
    show(history);
  } catch (error) {
    reportFailure(error);
  } finally {
    pickButton.disabled = false;
  }
});

githubForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const parsed = parseGitHubInput(repoInput.value);
  if (!parsed) {
    setStatus("Try owner/repository, or a GitHub username.", "error");
    repoInput.focus();
    return;
  }

  const signal = beginLoad();
  setStatus(parsed.kind === "user" ? "Looking for commits…" : "Fetching commits…", "busy");

  try {
    const report: LoadProgress = (phase, done, total) =>
      setStatus(progressText(phase, done, total), "busy");

    const history =
      parsed.kind === "user"
        ? await loadGitHubUserHistory(parsed.login, report, signal)
        : await loadGitHubHistory(parsed.target, report, signal);

    show(history);
  } catch (error) {
    reportFailure(error);
  }
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
    : "Want the full person history? Add a GitHub token";
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

window.addEventListener("resize", () => draw());

show(createDemoHistory());
setStatus("A made-up project, so the page is not empty. Open one of your own.");

function progressText(phase: string, done: number, total: number | null): string {
  const count =
    total === null
      ? done.toLocaleString("en")
      : `${done.toLocaleString("en")} / ${total.toLocaleString("en")}`;
  return `${phase}… ${count}`;
}
