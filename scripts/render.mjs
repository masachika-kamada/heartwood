#!/usr/bin/env node
/**
 * Draws one history to image files, for a place that cannot run the page:
 * a profile README, a project README, a slide.
 *
 * There is no second renderer. This opens the built page in a headless
 * browser, lets it read the history from GitHub exactly as it would for a
 * visitor, and asks it for the picture — once in ink for a dark page and once
 * for a light one, both on a transparent ground.
 *
 *   npm run build
 *   node scripts/render.mjs <owner/repository | username> [output directory]
 *
 * Environment:
 *   HEARTWOOD_TOKEN   optional GitHub token; a person's full history needs one
 *   HEARTWOOD_NAME    file name stem, default "heartwood"
 *   HEARTWOOD_CHROME  path to a Chrome/Chromium binary, default: installed Chrome
 */

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const target = process.argv[2] ?? process.env.HEARTWOOD_TARGET;
const outDir = resolve(process.argv[3] ?? process.env.HEARTWOOD_OUT ?? "heartwood");
const stem = process.env.HEARTWOOD_NAME || "heartwood";
const token = process.env.HEARTWOOD_TOKEN || "";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));

if (!target) {
  console.error("Usage: node scripts/render.mjs <owner/repository | username> [output directory]");
  process.exit(2);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** The built page, served from this machine only for as long as this runs. */
const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
  const file = join(dist, path === "/" || path === "\\" ? "index.html" : path);
  try {
    if (!file.startsWith(dist)) {
      throw new Error("outside dist");
    }
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const origin = `http://127.0.0.1:${server.address().port}`;

let browser;
let failure = null;
try {
  await readFile(join(dist, "index.html")).catch(() => {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  });

  const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
  browser = await chromium.launch({
    ...(process.env.HEARTWOOD_CHROME
      ? { executablePath: process.env.HEARTWOOD_CHROME }
      : { channel: "chrome" }),
    ...(proxy
      ? {
          proxy: {
            server: `${proxy.protocol}//${proxy.host}`,
            username: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password),
            bypass: "127.0.0.1",
          },
        }
      : {}),
  });

  const page = await browser.newPage({ reducedMotion: "reduce" });
  if (token) {
    // The page keeps its token in local storage; put it there before it looks.
    await page.addInitScript((value) => {
      window.localStorage.setItem("heartwood.github-token", value);
    }, token);
  }

  await page.goto(`${origin}/#${target}`);
  await page.waitForFunction(() => window.heartwood && window.heartwood.state() !== "busy", null, {
    timeout: 180_000,
  });

  const state = await page.evaluate(() => window.heartwood.state());
  const message = await page.evaluate(() => window.heartwood.message());
  if (state === "error") {
    throw new Error(message || "The history could not be read.");
  }

  await mkdir(outDir, { recursive: true });
  for (const theme of ["dark", "light"]) {
    const dataUrl = await page.evaluate(
      (ink) => window.heartwood.image({ theme: ink, transparent: true, width: 1000 }),
      theme,
    );
    if (!dataUrl) {
      throw new Error("The page drew nothing.");
    }
    const file = join(outDir, `${stem}-${theme}.webp`);
    await writeFile(file, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`wrote ${file}`);
  }
  if (message) {
    console.log(`note: ${message}`);
  }
} catch (error) {
  failure = error;
} finally {
  await browser?.close();
  server.close();
}

if (failure) {
  console.error(`heartwood: ${failure.message}`);
  process.exit(1);
}
