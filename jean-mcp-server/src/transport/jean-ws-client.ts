import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import type { JeanMcpConfig } from '../config.js';
import { JeanMcpError, normalizeError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { assertJeanAuth, fetchJeanInit } from './jean-http-auth.js';

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface QueueItem {
  id: string;
  payload: string;
}

interface ResponseFrame {
  type: 'response';
  id?: string;
  data?: unknown;
}

interface ErrorFrame {
  type: 'error';
  id?: string;
  error?: string;
}

interface EventFrame {
  type: 'event';
  event?: string;
  payload?: unknown;
}

type WsFrame = ResponseFrame | ErrorFrame | EventFrame;

export interface JeanEvent {
  event: string;
  payload: unknown;
}

export interface JeanConnectionEvent {
  state: 'connected' | 'disconnected';
  reconnectAttempt: number;
  code?: number;
  reason?: string;
}

export class JeanWsClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: QueueItem[] = [];
  private readonly eventListeners = new Set<(event: JeanEvent) => void>();
  private readonly connectionListeners = new Set<
    (event: JeanConnectionEvent) => void
  >();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connectPromise: Promise<void> | null = null;
  private stopped = false;
  private authBlocked = false;
  private initFetched = false;

  constructor(
    private readonly config: JeanMcpConfig,
    private readonly logger: Logger
  ) {}

  onEvent(listener: (event: JeanEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: (event: JeanConnectionEvent) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.ensureConnected();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.rejectAllPending(
      new JeanMcpError('CLIENT_STOPPED', 'Jean client stopped before completion.')
    );
  }

  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.authBlocked) {
      throw new JeanMcpError(
        'AUTH_INVALID',
        'Jean authentication is blocked. Update JEAN_TOKEN and restart server.'
      );
    }

    const id = randomUUID();
    const payload = JSON.stringify({
      id,
      command,
      args,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new JeanMcpError(
            'COMMAND_TIMEOUT',
            `Jean command '${command}' timed out after ${this.config.requestTimeoutMs}ms.`
          )
        );
      }, this.config.requestTimeoutMs);

      this.pending.set(id, {
        command,
        resolve,
        reject,
        timeout,
      });

      if (this.isSocketOpen()) {
        this.sendNow(id, payload);
        return;
      }

      this.queue.push({ id, payload });
      void this.ensureConnected().catch(error => {
        const normalized = normalizeError(error, 'CONNECT_FAILED');
        if (normalized.code === 'AUTH_INVALID') {
          this.rejectPending(id, normalized);
          return;
        }

        this.logger.warn('Connection attempt failed; keeping request queued.', {
          command,
          code: normalized.code,
          message: normalized.message,
        });
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped) {
      throw new JeanMcpError('CLIENT_STOPPED', 'Jean client is stopped.');
    }

    if (this.authBlocked) {
      throw new JeanMcpError(
        'AUTH_INVALID',
        'Jean authentication is blocked. Update JEAN_TOKEN and restart server.'
      );
    }

    if (this.isSocketOpen()) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    try {
      await assertJeanAuth(this.config);
    } catch (error) {
      const normalized = normalizeError(error, 'AUTH_CHECK_FAILED');
      if (normalized.code === 'AUTH_INVALID') {
        this.authBlocked = true;
        this.clearReconnectTimer();
        this.rejectAllPending(normalized);
      } else {
        this.scheduleReconnect();
      }
      throw normalized;
    }

    if (!this.initFetched) {
      try {
        await fetchJeanInit(this.config);
        this.initFetched = true;
      } catch (error) {
        const normalized = normalizeError(error, 'INIT_FAILED');
        this.logger.warn('Jean init prefetch failed; continuing without bootstrap.', {
          code: normalized.code,
          message: normalized.message,
        });
      }
    }

    const wsUrl = this.buildWsUrl();
    await this.openWebSocket(wsUrl);
  }

  private buildWsUrl(): string {
    const base = new URL(`${this.config.jeanBaseUrl}/`);
    const wsUrl = new URL('/ws', base);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.config.jeanToken.length > 0) {
      wsUrl.searchParams.set('token', this.config.jeanToken);
    }
    return wsUrl.toString();
  }

  private openWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.on('open', () => {
        settled = true;
        const connectedAttempt = this.reconnectAttempt;
        this.reconnectAttempt = 0;
        this.logger.info('Connected to Jean WebSocket.');
        this.emitConnection({
          state: 'connected',
          reconnectAttempt: connectedAttempt,
        });
        this.flushQueue();
        resolve();
      });

      socket.on('message', raw => {
        this.handleRawMessage(raw);
      });

      socket.on('close', (code, reasonBuffer) => {
        const reason = reasonBuffer.toString();
        this.handleSocketClosed(code, reason);
        if (!settled) {
          settled = true;
          reject(
            new JeanMcpError(
              'WS_CONNECT_CLOSED',
              `Jean WebSocket closed before open (code=${code}).`,
              { reason }
            )
          );
        }
      });

      socket.on('error', error => {
        const normalized = normalizeError(error, 'WS_CONNECT_ERROR');
        if (!settled) {
          settled = true;
          reject(normalized);
        } else {
          this.logger.warn('Jean WebSocket error after connect.', {
            code: normalized.code,
            message: normalized.message,
          });
        }
      });
    });
  }

  private handleRawMessage(raw: WebSocket.RawData): void {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof Buffer
          ? raw.toString('utf-8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf-8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(raw)).toString('utf-8')
              : Buffer.from(raw).toString('utf-8');

    let frame: WsFrame;
    try {
      frame = JSON.parse(text) as WsFrame;
    } catch {
      this.logger.warn('Received malformed JSON frame from Jean.');
      return;
    }

    if (frame.type === 'response' && frame.id) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(frame.id);
      pending.resolve(frame.data ?? null);
      return;
    }

    if (frame.type === 'error' && frame.id) {
      this.rejectPending(
        frame.id,
        new JeanMcpError(
          'JEAN_COMMAND_ERROR',
          frame.error ?? 'Jean command failed.'
        )
      );
      return;
    }

    if (frame.type === 'event' && frame.event) {
      const event: JeanEvent = {
        event: frame.event,
        payload: frame.payload ?? null,
      };
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch (error) {
          const normalized = normalizeError(error, 'EVENT_HANDLER_FAILED');
          this.logger.warn('Jean event listener failed.', {
            code: normalized.code,
            message: normalized.message,
            event: frame.event,
          });
        }
      }
    }
  }

  private handleSocketClosed(code: number, reason: string): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    this.emitConnection({
      state: 'disconnected',
      reconnectAttempt: this.reconnectAttempt,
      code,
      reason,
    });

    if (this.pending.size > 0) {
      this.rejectAllPending(
        new JeanMcpError(
          'WS_DISCONNECTED',
          'Jean WebSocket disconnected before command completed.',
          { code, reason }
        )
      );
    }

    if (!this.stopped && !this.authBlocked) {
      this.scheduleReconnect();
    }
  }

  private isSocketOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private sendNow(id: string, payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.rejectPending(
        id,
        new JeanMcpError('WS_DISCONNECTED', 'Jean WebSocket is not open.')
      );
      return;
    }

    this.ws.send(payload, error => {
      if (!error) return;
      this.rejectPending(
        id,
        new JeanMcpError('WS_SEND_FAILED', 'Failed sending command to Jean.', {
          message: error.message,
        })
      );
    });
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && this.isSocketOpen()) {
      const queued = this.queue.shift();
      if (!queued) break;
      this.sendNow(queued.id, queued.payload);
    }
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.queue.length = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || this.authBlocked) {
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.config.reconnectMaxMs
    );

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(error => {
        const normalized = normalizeError(error, 'RECONNECT_FAILED');
        this.logger.warn('Reconnect attempt failed.', {
          code: normalized.code,
          message: normalized.message,
        });
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private emitConnection(event: JeanConnectionEvent): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(event);
      } catch (error) {
        const normalized = normalizeError(error, 'CONNECTION_HANDLER_FAILED');
        this.logger.warn('Jean connection listener failed.', {
          code: normalized.code,
          message: normalized.message,
          state: event.state,
        });
      }
    }
  }
}
