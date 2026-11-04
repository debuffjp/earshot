// Local signalling for the voice demo: server-sent events down, POST up, two players at most.
const clients = new Map();
const send = (res, message) => res.write(`data: ${JSON.stringify(message)}\n\n`);

export function handleSignal(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/signal") return false;
  if (req.method === "POST") {
    let body = "";
    req.on("data", (d) => { if (body.length < 100_000) body += d; });
    req.on("end", () => {
      const from = url.searchParams.get("id");
      for (const [id, client] of clients) if (id !== from) send(client, { from, ...JSON.parse(body) });
      res.writeHead(204).end();
    });
    return true;
  }
  const id = url.searchParams.get("id");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  if (clients.size >= 2) { send(res, { type: "full" }); res.end(); return true; }
  send(res, { type: "welcome", seat: clients.size });
  for (const client of clients.values()) send(client, { type: "join", from: id });
  clients.set(id, res);
  req.on("close", () => {
    clients.delete(id);
    for (const client of clients.values()) send(client, { type: "leave", from: id });
  });
  return true;
}
