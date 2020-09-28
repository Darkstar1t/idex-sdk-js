import WebSocket, { CONNECTING, OPEN } from 'isomorphic-ws';

import * as types from '../../types';
import * as constants from '../../constants';
import { isNode } from '../../utils';
import { isWebSocketAuthenticatedSubscription } from '../../types';

import { transformMessage } from './transform';
import { removeWalletFromSdkSubscription } from './utils';

export type WebSocketListenerConnect = () => unknown;

export type WebSocketListenerDisconnect = (
  code: number,
  reason: string,
) => unknown;

export type WebSocketListenerError = (error: Error) => unknown;
export type WebSocketListenerResponse = (
  response: types.WebSocketResponse,
) => unknown;

const NODE_USER_AGENT = 'idex-sdk-js';

// custom ping timeout in ms - how often do we ping the server
// to check for liveness?
const PING_TIMEOUT = 30000;

/**
 * WebSocket API client options
 *
 * @typedef {Object} WebSocketClientOptions
 * @property {boolean} [sandbox] - <br />
 *  Should the WebSocket connect to the {@link https://docs.idex.io/#sandbox|Sandbox Environment}?
 *  **Note**: This must be set to `true` during the Sandbox preview.
 * @property {function} [websocketAuthTokenFetch] - <br />
 *  Authenticated Rest API client fetch token call (`/wsToken`)
 *  SDK Websocket client will then automatically handle Websocket token generation and refresh.
 *  You can omit this when using only public websocket subscription.
 *  Example `wallet => authenticatedClient.getWsToken(uuidv1(), wallet)`
 *  See [API specification](https://docs.idex.io/#websocket-authentication-endpoints)
 * @property {boolean} [shouldReconnectAutomatically] -
 *  If true, automatically reconnects when connection is closed by the server or network errors
 * @property {string} [pathSubscription] -
 *  Path subscriptions are a quick and easy way to start receiving push updates. Eg. {market}@{subscription}_{option}
 * @property {number} [connectTimeout] -
 *  A timeout (in milliseconds) before failing while trying to connect to the WebSocket. Defaults to 5000.
 */
export interface WebSocketClientOptions {
  sandbox?: boolean;
  baseURL?: string;
  pathSubscription?: string;
  websocketAuthTokenFetch?: (wallet: string) => Promise<string>;
  shouldReconnectAutomatically?: boolean;
  connectTimeout?: number;
}

/**
 * WebSocket API client
 *
 * @example
 * import * as idex from '@idexio/idex-sdk';
 *
 * const webSocketClient = new idex.WebSocketClient({
 *  sandbox: true,
 *  shouldReconnectAutomatically: true,
 *  websocketAuthTokenFetch: authenticatedClient.getWsToken(uuidv1(), wallet),
 * });
 *
 * await webSocketClient.connect();
 *
 * @param {WebSocketClientOptions} options
 */
export class WebSocketClient {
  private baseURL: string;

  private shouldReconnectAutomatically = false;

  private reconnectAttempt = 0;

  private connectListeners = new Set<WebSocketListenerConnect>();

  private disconnectListeners = new Set<WebSocketListenerDisconnect>();

  private errorListeners = new Set<WebSocketListenerError>();

  private responseListeners = new Set<WebSocketListenerResponse>();

  private webSocket: null | WebSocket = null;

  private websocketAuthTokenFetch?: WebSocketClientOptions['websocketAuthTokenFetch'];

  private pathSubscription: string | null = null;

  // typescript cant type this nicely between both node and browser
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pingTimeoutId: any;

  private connectTimeout = 5000;

  /**
   * Set to true when the reconnect logic should not be run.
   * @private
   */
  private doNotReconnect = false;

  constructor(options: WebSocketClientOptions) {
    const baseURL =
      options.baseURL ??
      (options.sandbox
        ? constants.SANDBOX_WEBSOCKET_API_BASE_URL
        : constants.LIVE_WEBSOCKET_API_BASE_URL);

    if (!baseURL) {
      throw new Error('Must set sandbox to true');
    }

    this.baseURL = baseURL;

    if (options.shouldReconnectAutomatically) {
      this.shouldReconnectAutomatically = true;
    }

    if (options.pathSubscription) {
      this.pathSubscription = options.pathSubscription;
    }

    if (typeof options.connectTimeout === 'number') {
      this.connectTimeout = options.connectTimeout;
    }

    this.websocketAuthTokenFetch = options.websocketAuthTokenFetch;
  }

  /* Connection management */

  public async connect(awaitConnected = true): Promise<this> {
    if (this.isConnected()) {
      return this;
    }

    this.doNotReconnect = false;

    // connect and await connection to succeed
    await this.createWebSocketIfNeeded(awaitConnected);

    this.connectListeners.forEach((listener) => listener());

    return this;
  }

  public disconnect(): this {
    this.stopPinging();

    if (!this.webSocket) {
      return this; // Already disconnected
    }

    this.doNotReconnect = true;
    this.webSocket.close();
    this.webSocket = null;

    return this;
  }

  public isConnected(): boolean {
    return this.webSocket?.readyState === OPEN;
  }

  /* Event listeners */

  public onConnect(listener: WebSocketListenerConnect): this {
    this.connectListeners.add(listener);
    return this;
  }

  public onDisconnect(listener: WebSocketListenerDisconnect): this {
    this.disconnectListeners.add(listener);
    return this;
  }

  public onError(listener: WebSocketListenerError): this {
    this.errorListeners.add(listener);
    return this;
  }

  public onResponse(listener: WebSocketListenerResponse): this {
    this.responseListeners.add(listener);
    return this;
  }

  /* Subscription management */

  public listSubscriptions(): this {
    return this.sendMessage({ method: 'subscriptions' });
  }

  /**
   * Subscribe to a given set of subscriptions, optionally providing a list of top level
   * markets or a cid property.
   *
   * @see {@link https://docs.idex.io/#websocket-subscriptions|WebSocket Subscriptions}
   *
   * @param {AuthTokenWebSocketRequestAuthenticatedSubscription[]} subscriptions
   * @param {string[]} [markets] - Optionally provide top level markets
   * @param {string} [cid] - A custom identifier to identify the matching response
   */
  public subscribe(
    subscriptions: Array<
      | types.AuthTokenWebSocketRequestSubscription
      | types.WebSocketRequestUnauthenticatedSubscription['name']
    >,
    markets?: string[],
    cid?: string,
  ): this {
    this.subscribeRequest(subscriptions, markets, cid).catch((error) => {
      this.handleWebSocketError(error);
    });
    return this;
  }

  /**
   * Strictly typed subscribe which only can be used on authenticated subscriptions.
   *
   * For this methods you need to pass `websocketAuthTokenFetch` to the websocket constructor.
   * Library will automatically refresh user's wallet auth tokens for you.
   *
   * See {@link https://docs.idex.io/#get-authentication-token|API specification}
   *
   * @param {AuthTokenWebSocketRequestAuthenticatedSubscription[]} subscriptions
   * @param {string[]} [markets] - Optionally provide top level markets
   * @param {string} [cid] - A custom identifier to identify the matching response
   */
  public subscribeAuthenticated(
    subscriptions: types.AuthTokenWebSocketRequestAuthenticatedSubscription[],
    markets?: string[],
    cid?: string,
  ): this {
    this.subscribe(subscriptions, markets, cid);
    return this;
  }

  /**
   * Subscribe which only can be used on non-authenticated subscriptions
   *
   * @param {WebSocketRequestUnauthenticatedSubscription[]} subscriptions
   * @param {string[]} [markets] - Optionally provide top level markets
   * @param {string} [cid] - A custom identifier to identify the matching response
   */
  public subscribeUnauthenticated(
    subscriptions: types.WebSocketRequestUnauthenticatedSubscription[],
    markets?: string[],
    cid?: string,
  ): this {
    this.subscribe(subscriptions, markets, cid);
    return this;
  }

  public unsubscribe(
    subscriptions?: Array<
      | types.WebSocketRequestUnsubscribeSubscription
      | types.WebSocketRequestUnsubscribeShortNames
    >,
    markets?: string[],
    cid?: string,
  ): this {
    return this.sendMessage({
      cid,
      method: 'unsubscribe',
      markets,
      subscriptions,
    });
  }

  /* Private */

  private async subscribeRequest(
    subscriptions: Array<
      | types.AuthTokenWebSocketRequestSubscription
      | types.WebSocketRequestUnauthenticatedSubscription['name']
    >,
    markets?: string[],
    cid?: string,
  ): Promise<this> {
    const authSubscriptions = subscriptions.filter(
      isWebSocketAuthenticatedSubscription,
    );

    // Public subscriptions can be subscribed all at once
    if (authSubscriptions.length === 0) {
      return this.sendMessage({
        cid,
        method: 'subscribe',
        markets,
        subscriptions,
      });
    }

    const { websocketAuthTokenFetch } = this;

    // For authenticated, we do require token manager
    if (!websocketAuthTokenFetch) {
      throw new Error(
        'WebSocket: `websocketAuthTokenFetch` is required for authenticated subscriptions',
      );
    }

    const uniqueWallets = Array.from(
      authSubscriptions.reduce((wallets, subscription) => {
        if (subscription.wallet) {
          wallets.add(subscription.wallet);
        }
        return wallets;
      }, new Set<string>()),
    );

    if (!uniqueWallets.length) {
      throw new Error(
        'WebSocket: Missing `wallet` for authenticated subscription',
      );
    }

    // For single wallet, send all subscriptions at once (also unauthenticated)
    if (uniqueWallets.length === 1) {
      return this.sendMessage({
        cid,
        method: 'subscribe',
        markets,
        subscriptions: subscriptions.map(removeWalletFromSdkSubscription),
        token: await websocketAuthTokenFetch(uniqueWallets[0]),
      });
    }

    // In specific case when user subscribed with more than 1 wallet...

    // Subscribe public subscriptions all at once
    const publicSubscriptions = subscriptions.filter(isPublicSubscription);

    if (publicSubscriptions.length > 0) {
      this.sendMessage({
        cid,
        method: 'subscribe',
        markets,
        subscriptions: publicSubscriptions,
      });
    }

    // Now prepare all auth tokens, so we can subscribe all authenticated at "once"
    const preparedTokensByWalletIndex = await Promise.all(
      uniqueWallets.map((wallet) => websocketAuthTokenFetch(wallet)),
    );

    // Send multiple wallets subscriptions grouped by wallet
    uniqueWallets.forEach((wallet, walletIndex) => {
      this.sendMessage({
        cid,
        method: 'subscribe',
        markets,
        subscriptions: authSubscriptions
          .filter((item) => item.wallet === wallet)
          .map(removeWalletFromSdkSubscription),
        token: preparedTokensByWalletIndex[walletIndex],
      });
    });

    return this;
  }

  private async createWebSocketIfNeeded(
    awaitConnect = false,
  ): Promise<WebSocket> {
    try {
      this.doNotReconnect = false;

      if (this.webSocket) {
        return this.webSocket;
      }

      this.webSocket = new WebSocket(
        this.pathSubscription
          ? `${this.baseURL}/${this.pathSubscription}`
          : this.baseURL,
        isNode
          ? {
              headers: { 'User-Agent': NODE_USER_AGENT },
            }
          : undefined,
      );

      this.webSocket.addEventListener(
        'message',
        this.handleWebSocketMessage.bind(this),
      );
      this.webSocket.addEventListener(
        'close',
        this.handleWebSocketClose.bind(this),
      );
      this.webSocket.addEventListener(
        'error',
        this.handleWebSocketError.bind(this),
      );
      this.webSocket.addEventListener(
        'open',
        this.handleWebSocketConnect.bind(this),
      );

      if (awaitConnect) {
        await this.resolveWhenConnected();
      }

      return this.webSocket;
    } catch (err) {
      if (this.shouldReconnectAutomatically) {
        this.reconnect();
        throw new Error(
          `Failed to connect: "${err.message}" - a reconnect attempt will be scheduled automatically`,
        );
      }
      throw err;
    }
  }

  /**
   * Waits until the WebSocket is connected before returning
   */
  private async resolveWhenConnected(
    timeout = this.connectTimeout,
  ): Promise<void> {
    const { webSocket: ws } = this;

    if (!ws) {
      throw new Error(
        'Can not wait for WebSocket to connect, no WebSocket was found',
      );
    }

    if (ws.readyState === OPEN) {
      return;
    }

    if (ws.readyState !== CONNECTING) {
      throw new Error(
        'Can not wait for WebSocket to connect that is not open or connecting',
      );
    }

    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.webSocket === ws) {
          this.disconnect();
        }
        reject(new Error('timed out while waiting for WebSocket to connect'));
      }, timeout);

      const listener = () => {
        clearTimeout(timeoutId);
        ws.removeEventListener('open', listener);
        resolve();
      };

      ws.addEventListener('open', listener);
    });
  }

  private destroyWebSocket(): void {
    this.stopPinging();
    if (this.webSocket) {
      this.doNotReconnect = true;
      this.webSocket.terminate();
      this.webSocket = null;
    }
  }

  private handleWebSocketConnect(): void {
    this.resetReconnectionState();
    this.startPinging();
  }

  // we need to ping from the client side to detect client-side socket closures which would otherwise
  // not generate any close notifications.  This also aids against idle timeouts being hit.
  // we can only send a ping from node-based environments, on browsers we need to instead use
  // a standard message to accomplish this.
  //
  // the server will always only reply to custom ping messages with native pong responses so the
  // client will not recieve any events in the browser when they occur.
  private startPinging() {
    this.stopPinging();

    if (!this.isConnected()) {
      return;
    }

    try {
      const { webSocket: ws } = this;

      if (!ws) {
        return;
      }

      if (typeof ws.ping === 'function') {
        ws.ping(JSON.stringify({ method: 'ping' }));
      } else {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    } finally {
      if (this.isConnected()) {
        this.pingTimeoutId = setTimeout(
          this.startPinging.bind(this),
          PING_TIMEOUT,
        );
      }
    }
  }

  private stopPinging() {
    clearTimeout(this.pingTimeoutId);
    this.pingTimeoutId = undefined;
  }

  private handleWebSocketClose(event: WebSocket.CloseEvent): void {
    this.stopPinging();
    this.webSocket = null;
    this.disconnectListeners.forEach((listener) =>
      listener(event.code, event.reason),
    );

    if (this.shouldReconnectAutomatically && !this.doNotReconnect) {
      this.reconnect();
    }
  }

  private handleWebSocketError(event: WebSocket.ErrorEvent): void {
    this.errorListeners.forEach((listener) => listener(event.error));
  }

  private handleWebSocketMessage(event: WebSocket.MessageEvent): void {
    if (!event || !event.data) {
      throw new Error('Malformed response data'); // Shouldn't happen
    }

    const message = transformMessage(JSON.parse(String(event.data)));
    this.responseListeners.forEach((listener) => listener(message));
  }

  private reconnect(): void {
    this.destroyWebSocket();
    this.doNotReconnect = false;
    // Reconnect with exponential backoff
    const backoffSeconds = 2 ** this.reconnectAttempt;
    this.reconnectAttempt += 1;
    console.log(`Reconnecting after ${backoffSeconds} seconds...`);
    setTimeout(this.connect.bind(this), backoffSeconds * 1000);
  }

  private resetReconnectionState(): void {
    this.reconnectAttempt = 0;
  }

  private sendMessage(payload: types.WebSocketRequest): this {
    const { webSocket } = this;

    this.throwIfDisconnected(webSocket);

    webSocket.send(JSON.stringify(payload));

    return this;
  }

  private throwIfDisconnected(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    webSocket: WebSocketClient['webSocket'],
  ): asserts webSocket is WebSocket {
    if (!this.isConnected()) {
      throw new Error(
        'Websocket not yet connected, await connect() method first',
      );
    }
  }
}

// We use this instead of the other type guards to account for unhandled subscription
// types
function isPublicSubscription(
  subscription:
    | types.WebSocketRequestUnauthenticatedSubscription['name']
    | types.WebSocketRequestSubscription,
): boolean {
  return !isWebSocketAuthenticatedSubscription(subscription);
}
