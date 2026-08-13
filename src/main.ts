import "./style.css";
import { buildTree } from "./core/tree";
import type { LoadProgress, RepoHistory, TreeModel } from "./core/types";
import { createDemoHistory } from "./sources/demo";
import { loadGitHubHistory, parseGitHubInput } from "./sources/github";
import { loadGitHubUserHistory } from "./sources/github-user";
import { loadLocalHistory } from "./sources/git/local";
import { renderTree } from "./render/rings";
import { exportTreePng } from "./render/export";
import { createInspector } from "./ui/inspector";
import { INPUT_EXAMPLES } from "./ui/examples";

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
        <label class="control__label" for="repo-input">…or a public repository, or a person</label>
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
          project. <strong>A username on its own</strong> draws everything that person has
          committed in public, across every repository, as one continuous trunk — a
          contribution graph that never resets.
        </p>
        <p class="control__examples">
          <span class="control__examples-label">Try</span>
          ${INPUT_EXAMPLES.map(
            (example) =>
              `<button class="chip" type="button" data-example="${example.value}">${example.value}</button>`,
          ).join("")}
        </p>
        <p class="control__note control__note--fine">
          Anonymous requests are rate limited, and GitHub does not report change sizes, so
          these trees weigh every commit equally. A busy account takes a minute or two.
        </p>
      </form>
    </section>

    <section class="legend" id="legend" hidden>
      <h2>How to read it</h2>
      <ul>
        <li><span class="swatch swatch--thick"></span> A wide ring is a period when a lot of code changed.</li>
        <li><span class="swatch swatch--dark"></span> Darker wood is work done between 22:00 and 05:00, in the author's own timezone.</li>
        <li><span class="swatch swatch--pinched"></span> A thin pale ring is a period when nothing was committed.</li>
        <li><span class="swatch swatch--scar"></span> A scar is a single commit far larger than everything around it.</li>
        <li><span class="swatch swatch--hue"></span> <span id="hue-note">Hue follows whoever committed most in that period.</span></li>
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

/**
 * A person's tree is grouped by repository rather than by author, so the
 * legend has to say what the colour actually means in that case.
 */
let hueMeansRepository = false;

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
  renderTree(canvas, currentTree, { reveal, groupLabel: groupLabel() });
}

function groupLabel(): "hands" | "repositories" {
  return hueMeansRepository ? "repositories" : "hands";
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

function show(history: RepoHistory): void {
  currentTree = buildTree(history);
  inspector.attach(currentTree, hueMeansRepository);
  legend.hidden = false;
  hueNote.textContent = hueMeansRepository
    ? "Hue follows whichever repository took most of that period."
    : "Hue follows whoever committed most in that period.";

  if (currentTree.rings.length === 0) {
    setStatus("That repository has no commits yet.", "error");
    draw();
    return;
  }

  const truncatedNote = currentTree.truncated ? " Showing the most recent stretch only." : "";
  setStatus(
    `${currentTree.name} · ${currentTree.totalCommits.toLocaleString("en")} commits.${truncatedNote}`,
  );
  animateGrowth();
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
      (phase, done) => setStatus(`${phase}… ${done.toLocaleString("en")}`, "busy"),
      signal,
    );
    hueMeansRepository = false;
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
    const report: LoadProgress = (phase, done) =>
      setStatus(`${phase}… ${done.toLocaleString("en")}`, "busy");

    const history =
      parsed.kind === "user"
        ? await loadGitHubUserHistory(parsed.login, report, signal)
        : await loadGitHubHistory(parsed.target, report, signal);

    hueMeansRepository = parsed.kind === "user";
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

savePngButton.addEventListener("click", async () => {
  if (!currentTree) {
    return;
  }
  try {
    await exportTreePng(currentTree, { groupLabel: groupLabel() });
  } catch (error) {
    reportFailure(error);
  }
});

window.addEventListener("resize", () => draw());

show(createDemoHistory());
setStatus("A made-up project, so the page is not empty. Open one of your own.");
