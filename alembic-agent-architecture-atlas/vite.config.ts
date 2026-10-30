import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
// 本地验证端点只接收派生回执，不接受目标路径，也不修改仓外文件。
// @ts-expect-error The CLI implementation is intentionally JavaScript and lives outside browser TS.
import { loadAtlas } from './scripts/atlas-lib.mjs';
import {
  beginRenderAttempt,
  cancelRenderAttempt,
  finishRenderAttempt,
  renderInputFingerprint,
} from './scripts/render-state.mjs';

const atlasRoot = import.meta.dirname;
export default defineConfig({
  base: './',
  publicDir: 'evidence/live/public',
  server: {
    host: '127.0.0.1',
    fs: { strict: true, allow: [atlasRoot] },
    watch: { ignored: ['**/evidence/render/*.json'] },
  },
  plugins: [
    {
      name: 'local-atlas-render-receipt',
      configureServer(server) {
        server.middlewares.use('/__atlas-render-receipt', (request, response) => {
          const address = server.httpServer?.address();
          const origin =
            address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
          if (request.method !== 'POST' || !origin || request.headers.origin !== origin) {
            response.statusCode = 403;
            response.end('Local verification page only');
            return;
          }
          let body = '';
          request.setEncoding('utf8');
          request.on('data', (chunk: string) => {
            body += chunk;
            if (Buffer.byteLength(body) > 2_000_000) {
              request.destroy();
            }
          });
          request.on('end', () => {
            try {
              const message = JSON.parse(body);
              const current = loadAtlas();
              const diagrams = current.documents.flatMap(
                (d: { diagrams: { id: string; digest: string }[] }) => d.diagrams,
              );
              const fingerprint = renderInputFingerprint(diagrams, current.rendererVersion);
              const dir = path.join(atlasRoot, 'evidence/render');
              fs.mkdirSync(dir, { recursive: true });
              let attempt: import('./src/model').RenderAttempt;
              if (message.action === 'inspect') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ attempt: current.renderAttempt }));
                return;
              }
              if (message.action === 'begin') {
                if (message.inputFingerprint !== fingerprint) {
                  response.statusCode = 409;
                  response.end('Render inputs changed; collect and reload');
                  return;
                }
                if (
                  !Object.hasOwn(message, 'expectedAttemptId') ||
                  (message.expectedAttemptId !== null &&
                    typeof message.expectedAttemptId !== 'string')
                ) {
                  response.statusCode = 400;
                  response.end('Expected attempt identity required');
                  return;
                }
                try {
                  attempt = beginRenderAttempt(
                    fingerprint,
                    current.renderAttempt,
                    message.expectedAttemptId,
                  );
                } catch {
                  response.statusCode = 409;
                  response.end('Render authority changed');
                  return;
                }
              } else if (message.action === 'finish') {
                attempt = finishRenderAttempt(
                  current.renderAttempt,
                  message.id,
                  message.receipt,
                  diagrams,
                  current.rendererVersion,
                );
                if (attempt.status === 'pass') {
                  fs.writeFileSync(
                    path.join(dir, 'current.json'),
                    `${JSON.stringify(message.receipt, null, 2)}\n`,
                  );
                }
              } else if (message.action === 'cancel') {
                attempt = cancelRenderAttempt(current.renderAttempt, message.id);
              } else {
                response.statusCode = 400;
                response.end('Unknown verification action');
                return;
              }
              fs.writeFileSync(
                path.join(dir, 'latest-attempt.json'),
                `${JSON.stringify(attempt, null, 2)}\n`,
              );
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ attempt }));
            } catch (error: unknown) {
              response.statusCode = 400;
              response.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : 'Invalid receipt',
                }),
              );
            }
          });
        });
      },
    },
  ],
  build: { manifest: true, outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
