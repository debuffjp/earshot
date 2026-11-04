import { createServer } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-generator";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".wav": "audio/wav" };
const handler = (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const base = path.startsWith("/dist/") ? root : join(root, "public");
  const file = join(base, normalize(path === "/" ? "index.html" : path));
  if (!file.startsWith(base) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
};

const lan = Object.values(networkInterfaces()).flat().find((n) => n.family === "IPv4" && !n.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(n.address))?.address;
const host = process.env.EARSHOT_HOST ?? lan;
createServer(handler).listen(4710, "127.0.0.1", () => console.log("This machine: http://localhost:4710"));

if (host) {
  const dir = join(root, ".cert"), keyFile = join(dir, `${host}.key`), certFile = join(dir, `${host}.crt`);
  try {
    if (!existsSync(certFile)) {
      mkdirSync(dir, { recursive: true });
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-keyout", keyFile, "-out", certFile, "-subj", "/CN=earshot-demo", "-addext", `subjectAltName=IP:${host}`], { stdio: "ignore" });
    }
    createHttps({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handler).listen(4711, host, () => {
      const url = `https://${host}:4711`;
      const qr = qrcode(0, "L"); qr.addData(url); qr.make();
      console.log(`Phone: ${url}\nThe certificate is self-signed, so the phone warns once. Choose to continue.\n`);
      console.log(qr.createASCII(1, 2));
    });
  } catch (e) {
    console.log(`No phone URL: couldn't make a certificate with openssl (${e.message}).`);
  }
}
