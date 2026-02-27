// Node 20+ (GitHub Actions uses this)
// Polls Fluxer status summary and posts changes to a Discord webhook.

const SUMMARY_URL = "https://fluxerstatus.com/summary.json";

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
      updatedAt: x.updatedAt ?? x.started ?? null,
      url: x.url ?? "https://fluxerstatus.com/",
    })),
    ...maints.map((x) => ({
      kind: "Maintenance",
      id: x.id ?? x.url ?? x.name,
      name: x.name ?? "Unnamed maintenance",
      status: x.status ?? "UNKNOWN",
      impact: x.impact ?? null,
      updatedAt: x.updatedAt ?? x.start ?? null,
      url: x.url ?? "https://fluxerstatus.com/",
    })),
  ];

  // Sort newest first
  entries.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
  return entries;
}

function makeFingerprint(entries) {
  // Fingerprint only what matters for “did something change?”
  return JSON.stringify(
    entries.map((e) => ({
      kind: e.kind,
      id: e.id,
      status: e.status,
      impact: e.impact,
      updatedAt: e.updatedAt,
      name: e.name,
      url: e.url,
    }))
  );
}

async function postToDiscord(webhookUrl, entries) {
  // Keep it readable; Discord allows up to 2000 chars in content
  const lines = entries.slice(0, 10).map((e) => {
    const when = e.updatedAt
  ? `<t:${Math.floor(new Date(e.updatedAt).getTime() / 1000)}:F>`
  : "unknown time";
    const extra = e.kind === "Incident" ? ` • impact: ${e.impact}` : "";
    return `**[${e.kind}]** ${e.name}\nStatus: \`${e.status}\`${extra}\nUpdated: ${when}\n${e.url}`;
  });

  const content =
    `🔔 Fluxer status update detected:\n\n` +
    lines.join("\n\n");

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