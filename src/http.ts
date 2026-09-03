/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID, timingSafeEqual} from 'node:crypto';
import http from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {text} from 'node:stream/consumers';

import type {McpServer} from './index.js';
import {
  StreamableHTTPServerTransport,
  isInitializeRequest,
} from './third_party/index.js';
import {logger} from './utils/logger.js';
import {isLocalhost} from './utils/url.js';

export const MCP_PATH = '/mcp';
export const DEFAULT_MAX_SESSIONS = 64;

export interface HttpServerOptions {
  host: string;
  port: number;
  token?: string;
  maxSessions?: number;
  createMcpServer: () => Promise<McpServer>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class HttpServer {
  #options: HttpServerOptions;
  #port: number;
  #loopback: boolean;
  #closed = false;
  #pendingSessions = 0;
  #sessions = new Map<string, Session>();
  #httpServer: http.Server;

  private constructor(options: HttpServerOptions) {
    this.#options = options;
    this.#port = options.port;
    this.#loopback = isLoopback(options.host);
    if (!options.token && !this.#loopback) {
      throw new Error(
        `Refusing to listen on ${options.host} without a token. Bind to a loopback address or configure a bearer token.`,
      );
    }
    this.#httpServer = http.createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        logger?.('HTTP request failed', error);
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });
  }

  static async listen(options: HttpServerOptions): Promise<HttpServer> {
    const server = new HttpServer(options);
    await new Promise<void>((resolve, reject) => {
      server.#httpServer.once('error', reject);
      server.#httpServer.listen(options.port, options.host, resolve);
    });
    const address = server.#httpServer.address();
    if (typeof address === 'object' && address !== null) {
      server.#port = address.port;
    }
    return server;
  }

  get url(): string {
    return `http://${formatHost(this.#options.host)}:${this.#port}${MCP_PATH}`;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#sessions.keys()].map(sessionId =>
        this.#closeSession(sessionId),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        logger?.('Failed to close HTTP session', result.reason);
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.#httpServer.close(error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      this.#httpServer.closeAllConnections();
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#closed) {
      writeJsonRpcError(res, 503, -32000, 'Server is shutting down');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (this.#loopback && !isLocalhost(`http://${req.headers.host ?? ''}`)) {
      writeJsonRpcError(
        res,
        403,
        -32000,
        `Invalid Host header: ${req.headers.host ?? ''}`,
      );
      return;
    }
    if (!this.#authorized(req)) {
      res.writeHead(401, {'WWW-Authenticate': 'Bearer'}).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      writeJsonRpcError(
        res,
        400,
        -32000,
        'Bad Request: Mcp-Session-Id header is required',
      );
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await text(req));
    } catch {
      writeJsonRpcError(res, 400, -32700, 'Parse error');
      return;
    }
    if (!isInitializeRequest(body)) {
      writeJsonRpcError(
        res,
        400,
        -32000,
        'Bad Request: only an initialize request may start a session',
      );
      return;
    }
    const maxSessions = this.#options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (this.#sessions.size + this.#pendingSessions >= maxSessions) {
      writeJsonRpcError(
        res,
        503,
        -32000,
        `Too many sessions: at most ${maxSessions} may be open at once`,
      );
      return;
    }
    this.#pendingSessions++;
    try {
      await this.#startSession(req, res, body);
    } finally {
      this.#pendingSessions--;
    }
  }

  async #startSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    if (this.#closed) {
      writeJsonRpcError(res, 503, -32000, 'Server is shutting down');
      return;
    }
    const server = await this.#options.createMcpServer();
    if (this.#closed) {
      await server.close();
      writeJsonRpcError(res, 503, -32000, 'Server is shutting down');
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        this.#sessions.set(sessionId, {transport, server});
        logger?.(
          `HTTP session opened: ${sessionId} (${this.#sessions.size} active)`,
        );
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) {
        this.#closeSession(sessionId).catch((error: unknown) => {
          logger?.(`Failed to close HTTP session ${sessionId}`, error);
        });
      }
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      if (transport.sessionId === undefined) {
        await server.close();
      }
    }
  }

  async #closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.#sessions.delete(sessionId);
    logger?.(
      `HTTP session closed: ${sessionId} (${this.#sessions.size} active)`,
    );
    await session.server.close();
  }

  #authorized(req: IncomingMessage): boolean {
    const token = this.#options.token;
    if (!token) {
      return true;
    }
    const expected = Buffer.from(`Bearer ${token}`);
    const provided = Buffer.from(req.headers.authorization ?? '');
    return (
      expected.length === provided.length && timingSafeEqual(expected, provided)
    );
  }
}

function isLoopback(host: string): boolean {
  return isLocalhost(`http://${formatHost(host)}`);
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({jsonrpc: '2.0', error: {code, message}, id: null}));
}
