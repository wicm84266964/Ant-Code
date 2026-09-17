import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import test from "node:test";
import { collectRawHttpResponse } from "../../src/tools/web-tools.ts";

test("HTTPS proxy handshake disconnect rejects without an unhandled TLS error", async () => {
  const server = net.createServer((socket) => {
    socket.resume();
    socket.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  const socket = tls.connect({ host: "127.0.0.1", port: address.port, servername: "localhost" });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  try {
    await assert.rejects(collectRawHttpResponse("https://localhost/", socket),
      /headers were complete|TLS connection|socket closed/);
    await closed;
    assert.equal(socket.listenerCount("error"), 0);
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
