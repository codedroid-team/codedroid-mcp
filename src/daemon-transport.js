import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

class DaemonTransport extends StreamableHTTPClientTransport {
  async close() {
    // The SDK's close() only aborts HTTP streams. DELETE is what releases the daemon's
    // session, including its proxy server, when a CLI call or stdio client is finished.
    let timer;
    try {
      await Promise.race([
        this.terminateSession(),
        new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
      ]);
    } catch {
      // The daemon may already be gone; close the local transport either way.
    } finally {
      clearTimeout(timer);
      await super.close();
    }
  }
}

/** A request owns its localhost connection: a long get_task must not hold cancel_task or
 * another session behind it in the HTTP connection pool (reproduced with Node 26's fetch).
 * MCP sessions still live across requests; only the underlying TCP connection is released.
 *
 * [token] is the running daemon's bearer token (host.js readDaemonToken); the SDK applies these
 * headers to every request on the transport — POST, the GET event stream, and the DELETE teardown.
 */
export function daemonTransport(port, token) {
  if (!token) {
    throw new Error(
      `The daemon token is missing from ~/.codedroid/daemon-token. ` +
        `End the CodeDroid daemon process on port ${port}, then reconnect to create a new token.`,
    );
  }
  const headers = { Connection: "close", Authorization: `Bearer ${token}` };
  return new DaemonTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers },
  });
}
