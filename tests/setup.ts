// Test utilities for MCP Gateway tests

/**
 * Creates a mock child process spawner for testing process management.
 * Returns a mock object with a `spawn` method, stdout/stderr streams, and an `on` event handler.
 */
export function createMockSpawner() {
  const mockProcess = {
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    on: (_event: string, _handler: (...args: any[]) => void) => {},
    kill: () => {},
  };

  return {
    spawn: (_command: string, _args: string[], _options?: any) => mockProcess,
    mockProcess,
  };
}

/**
 * Creates a mock MCP transport for testing client/server communication.
 * Returns a pair of connected transports (client-side and server-side).
 */
export function createMockTransport() {
  const messages: any[] = [];
  let onMessageHandler: ((msg: any) => void) | null = null;

  const clientTransport = {
    send: (msg: any) => {
      messages.push(msg);
      onMessageHandler?.(msg);
    },
    onMessage: (handler: (msg: any) => void) => {
      onMessageHandler = handler;
    },
    close: () => {},
  };

  const serverTransport = {
    send: (msg: any) => {
      messages.push(msg);
      onMessageHandler?.(msg);
    },
    onMessage: (handler: (msg: any) => void) => {
      onMessageHandler = handler;
    },
    close: () => {},
  };

  return { clientTransport, serverTransport, messages };
}
