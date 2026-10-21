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
 */
export function daemonTransport(port) {
  return new DaemonTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Connection: "close" } },
  });
}
