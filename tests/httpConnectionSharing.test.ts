/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import type {ChildProcessByStdio} from 'node:child_process';
import {spawn} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import {after, before, describe, it} from 'node:test';

import type {Browser} from 'puppeteer';
import puppeteer, {executablePath} from 'puppeteer';

import {
  callToolText,
  connectMcpOverHttp,
  countListedPages,
  disconnectMcpSession,
} from './utils.js';

const TOKEN = 'connection-sharing-test-token';
const STARTUP_TIMEOUT_MS = 30_000;
const LOG_SETTLE_MS = 250;
const PAGE_SYNC_TIMEOUT_MS = 5_000;

type Server = ChildProcessByStdio<Writable, Readable, Readable>;

async function waitForPageCount(
  browser: Browser,
  expected: number,
): Promise<number> {
  const deadline = Date.now() + PAGE_SYNC_TIMEOUT_MS;
  let count = (await browser.pages()).length;
  while (count !== expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    count = (await browser.pages()).length;
  }
  return count;
}

describe('one browser connection for many MCP sessions', () => {
  let usersChrome: Browser | undefined;
  let hub: Server | undefined;
  let url: URL;
  let hubStderr = '';

  function connectionsMade(): number {
    return (hubStderr.match(/Connected Puppeteer/g) ?? []).length;
  }

  function browser(): Browser {
    assert.ok(usersChrome, 'the browser was not launched');
    return usersChrome;
  }

  before(async () => {
    usersChrome = await puppeteer.launch({
      headless: true,
      executablePath: await executablePath(),
    });
    const child = spawn(
      'node',
      [
        'build/src/bin/chrome-devtools-mcp.js',
        '--ws-endpoint',
        usersChrome.wsEndpoint(),
        '--http-port',
        '0',
      ],
      {
        env: {
          ...process.env,
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
          CHROME_DEVTOOLS_MCP_HTTP_TOKEN: TOKEN,
          NODE_DEBUG: 'mcp:log',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as Server;
    hub = child;
    child.stdout.resume();
    url = await new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`hub did not start: ${hubStderr}`));
      }, STARTUP_TIMEOUT_MS);
      child.stderr.on('data', (chunk: Buffer) => {
        hubStderr += chunk.toString();
        const match = hubStderr.match(/listening on (http:\/\/\S+)\n/);
        if (match) {
          clearTimeout(timer);
          resolve(new URL(match[1]));
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`hub exited before listening: ${hubStderr}`));
      });
    });
  });

  after(async () => {
    if (hub && hub.exitCode === null) {
      hub.kill('SIGKILL');
    }
    await usersChrome?.close();
  });

  it('attaches to the browser once for two sessions driving it together', async () => {
    const first = await connectMcpOverHttp(url, TOKEN);
    const second = await connectMcpOverHttp(url, TOKEN);
    try {
      await Promise.all([
        callToolText(first.client, 'list_pages'),
        callToolText(second.client, 'list_pages'),
      ]);
      const before = countListedPages(
        await callToolText(second.client, 'list_pages'),
      );
      await callToolText(first.client, 'new_page', {url: 'about:blank'});
      const after = countListedPages(
        await callToolText(second.client, 'list_pages'),
      );
      assert.strictEqual(after, before + 1);
      assert.strictEqual(await waitForPageCount(browser(), after), after);
      await new Promise(resolve => setTimeout(resolve, LOG_SETTLE_MS));
      assert.strictEqual(connectionsMade(), 1, hubStderr);
    } finally {
      await Promise.allSettled([
        disconnectMcpSession(first),
        disconnectMcpSession(second),
      ]);
    }
  });

  it('keeps the same connection for a session that starts later', async () => {
    const later = await connectMcpOverHttp(url, TOKEN);
    try {
      await callToolText(later.client, 'list_pages');
      await new Promise(resolve => setTimeout(resolve, LOG_SETTLE_MS));
      assert.strictEqual(connectionsMade(), 1, hubStderr);
    } finally {
      await disconnectMcpSession(later);
    }
  });
});
