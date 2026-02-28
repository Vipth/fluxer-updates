// Node 20+ (GitHub Actions uses this)
// Polls Fluxer status summary and posts changes to a Discord webhook.

const SUMMARY_URL = "https://fluxerstatus.com/summary.json";

const KNOWN_UPDATE_STATES = new Set([
  "Investigating",
  "Identified",
  "Monitoring",
  "Resolved",
  "Update",
]);

const MONTH_TS_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s+(AM|PM)$/;

function pickEntries(data) {
  const incidents = Array.isArray(data.activeIncidents) ? data.activeIncidents : [];
  const maints = Array.isArray(data.activeMaintenances) ? data.activeMaintenances : [];

  // Normalize into a single list
  const entries = [
    ...incidents.map((x) => ({
      kind: "Incident",
      id: x.id ?? x.url ?? x.name,
      name: x.name ?? "Unnamed incident",
      status: x.status ?? "UNKNOWN",
      impact: x.impact ?? "UNKNOWN",
      // keep the summary timestamps around for display/debugging,
      // but DO NOT use them for change detection
      summaryUpdatedAt: x.updatedAt ?? x.started ?? null,
      url: x.url ?? "https://fluxerstatus.com/",
      latestUpdateKey: null, // filled in later
    })),
    ...maints.map((x) => ({
      kind: "Maintenance",
      id: x.id ?? x.url ?? x.name,
      name: x.name ?? "Unnamed maintenance",
      status: x.status ?? "UNKNOWN",
      impact: x.impact ?? null,
      summaryUpdatedAt: x.updatedAt ?? x.start ?? null,
      url: x.url ?? "https://fluxerstatus.com/",
      latestUpdateKey: null, // filled in later
    })),
  ];

  // Sort newest first by summaryUpdatedAt (only for ordering)
  entries.sort(
    (a, b) => (Date.parse(b.summaryUpdatedAt ?? "") || 0) - (Date.parse(a.summaryUpdatedAt ?? "") || 0)
  );

  return entries;
}

function htmlToLines(html) {
  // Strip scripts/styles, then tags -> newlines, then normalize whitespace
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const textish = withoutScripts
    .replace(/<\/(p|div|li|h1|h2|h3|h4|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");

  // Decode a few common entities (good enough for this page)
  const decoded = textish
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  return decoded
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function extractLatestUpdateFromLines(lines) {
  const idx = lines.findIndex((l) => l === "Updates");
  if (idx === -1) return null;

  // Walk forward and find the first block that looks like:
  // <State>
  // <Timestamp>
  // <Message... (optional)>
  let state = null;
  let ts = null;
  let message = [];

  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];

    if (!state && KNOWN_UPDATE_STATES.has(l)) {
      state = l;
      continue;
    }

    if (state && !ts && MONTH_TS_RE.test(l)) {
      ts = l;
      continue;
    }

    // once we have state+ts, collect message until we hit the next state or footer
    if (state && ts) {
      if (KNOWN_UPDATE_STATES.has(l)) break;
      if (l === "Show current status" || l.startsWith("Powered by")) break;
      message.push(l);
    }
  }

  if (!state || !ts) return null;

  const msg = message.join(" ").trim();
  return { state, ts, msg };
}

async function fetchLatestUpdateKey(url) {
  // If it’s not a fluxerstatus incident/maintenance details page, skip
  if (!url || !url.startsWith("https://fluxerstatus.com/")) return null;

  const r = await fetch(url, { headers: { "User-Agent": "fluxer-discord-notifier/1.0" } });
  if (!r.ok) return null;

  const html = await r.text();
  const lines = htmlToLines(html);
  const latest = extractLatestUpdateFromLines(lines);

  if (!latest) return null;

  // Keep this stable: state + timestamp + first 160 chars of message
  const msgPart = (latest.msg || "").slice(0, 160);
  return `${latest.state}|${latest.ts}|${msgPart}`;
}

function makeFingerprint(entries) {
  // Fingerprint only what matters for “did something *real* change?”
  // We intentionally do NOT include summaryUpdatedAt.
  return JSON.stringify(
    entries.map((e) => ({
      kind: e.kind,
      id: e.id,
      status: e.status,
      impact: e.impact,
      name: e.name,
      url: e.url,
      latestUpdateKey: e.latestUpdateKey, // <- actual incident-page update signal
    }))
  );
}

async function postToDiscord(webhookUrl, entries) {
  // Keep it readable; Discord allows up to 2000 chars in content
  const lines = entries.slice(0, 10).map((e) => {
    const latestPretty = e.latestUpdateKey
      ? e.latestUpdateKey.split("|").slice(0, 2).join(" • ")
      : "unknown";

    const extra = e.kind === "Incident" ? ` • impact: ${e.impact}` : "";
    const summaryWhen = e.summaryUpdatedAt ? new Date(e.summaryUpdatedAt).toISOString() : "unknown";

    return (
      `**[${e.kind}]** ${e.name}\n` +
      `Status: \`${e.status}\`${extra}\n` +
      `Latest update: ${latestPretty}\n` +
      `Summary updatedAt: ${summaryWhen}\n` +
      `${e.url}`
    );
  });

  const content = `🔔 Fluxer status update detected:\n\n` + lines.join("\n\n");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${txt}`);
  }
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("Missing DISCORD_WEBHOOK_URL env var.");

  const stateFile = process.env.STATE_FILE || "state.json";

  const r = await fetch(SUMMARY_URL, { headers: { "User-Agent": "fluxer-discord-notifier/1.0" } });
  if (!r.ok) throw new Error(`Fetch summary.json failed: ${r.status}`);

  const data = await r.json();
  const entries = pickEntries(data);

  // Enrich with “real update” keys from the incident/maintenance detail pages.
  // Sequential is simplest + gentle on their server; switch to limited concurrency if needed.
  for (const e of entries) {
    try {
      e.latestUpdateKey = await fetchLatestUpdateKey(e.url);
    } catch {
      e.latestUpdateKey = null;
    }
  }

  const fingerprint = makeFingerprint(entries);

  // Load previous fingerprint from a file in the repo workspace
  const fs = await import("node:fs/promises");
  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch {
    // first run
  }

  if (!prev || prev.fingerprint !== fingerprint) {
    if (entries.length > 0) {
      await postToDiscord(webhookUrl, entries);
    } else {
      // All clear
      const content =
        `✅ Fluxer status: **All systems operational**\n` +
        `https://fluxerstatus.com/\n` +
        `Checked: ${new Date().toISOString()}`;

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Discord webhook failed: ${res.status} ${txt}`);
      }
    }

    await fs.writeFile(
      stateFile,
      JSON.stringify({ fingerprint, updatedAt: new Date().toISOString() }, null, 2)
    );

    console.log("Change detected; notified + saved state.");
  } else {
    console.log("No change detected.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});