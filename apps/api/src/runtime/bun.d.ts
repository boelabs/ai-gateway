/**
 * Narrow ambient declaration for the Bun globals the source uses: `Bun.password` (Argon2id hashing
 * in auth/password.ts), `Bun.S3Client` (object storage in storage/s3ObjectStore.ts) and `Bun.serve`
 * (the HTTP and WebSocket server in http/bunServer.ts).
 *
 * Pulling in `@types/bun` would be the obvious alternative, but it redeclares globals that overlap
 * with `@types/node` and would change typechecking for the whole repository. The runtime is Bun
 * (see AGENTS.md §4); this just tells TypeScript about the APIs we rely on.
 */
// biome-ignore lint/style/noNamespace: an ambient global like `Bun.password` can only be declared as a namespace.
declare namespace Bun {
	interface PasswordHashOptions {
		algorithm: "argon2id" | "argon2i" | "argon2d" | "bcrypt";
		memoryCost?: number;
		timeCost?: number;
	}

	const password: {
		hash: (
			password: string | Uint8Array,
			options?: PasswordHashOptions,
		) => Promise<string>;
		verify: (
			password: string | Uint8Array,
			hash: string,
			algorithm?: PasswordHashOptions["algorithm"],
		) => Promise<boolean>;
	};

	interface S3Options {
		bucket?: string;
		region?: string;
		endpoint?: string;
		accessKeyId?: string;
		secretAccessKey?: string;
		virtualHostedStyle?: boolean;
	}

	interface S3Stats {
		size: number;
		etag: string;
		type: string;
		lastModified: Date;
	}

	interface S3File {
		/** Streams a body of unknown length as a multipart upload. Resolves to the bytes written. */
		write: (
			data: Response | Blob | string | Uint8Array,
			options?: { type?: string },
		) => Promise<number>;
		stat: () => Promise<S3Stats>;
		stream: () => ReadableStream<Uint8Array>;
		/** `end` is exclusive, like Blob.slice. */
		slice: (start: number, end?: number) => S3File;
		delete: () => Promise<void>;
	}

	class S3Client {
		constructor(options?: S3Options);
		file(path: string): S3File;
	}

	interface SocketAddress {
		address: string;
		port: number;
		family: "IPv4" | "IPv6";
	}

	interface ServerWebSocket<T = undefined> {
		data: T;
		readonly readyState: number;
		readonly remoteAddress: string;
		send: (
			data: string | ArrayBufferLike | Uint8Array,
			compress?: boolean,
		) => number;
		close: (code?: number, reason?: string) => void;
		/** Closes without the closing handshake. */
		terminate: () => void;
		ping: (data?: string | Uint8Array) => number;
		getBufferedAmount: () => number;
	}

	interface WebSocketHandler<T = undefined> {
		open?: (ws: ServerWebSocket<T>) => void | Promise<void>;
		message: (
			ws: ServerWebSocket<T>,
			message: string | Uint8Array,
		) => void | Promise<void>;
		close?: (
			ws: ServerWebSocket<T>,
			code: number,
			reason: string,
		) => void | Promise<void>;
		pong?: (ws: ServerWebSocket<T>, data: Uint8Array) => void | Promise<void>;
		maxPayloadLength?: number;
		perMessageDeflate?: boolean;
		/** Seconds; 0 disables. */
		idleTimeout?: number;
		sendPings?: boolean;
	}

	interface Server {
		readonly port: number;
		readonly hostname: string;
		readonly pendingRequests: number;
		readonly pendingWebSockets: number;
		requestIP: (request: Request) => SocketAddress | null;
		upgrade: <T>(
			request: Request,
			options?: { headers?: HeadersInit; data?: T },
		) => boolean;
		/**
		 * Stops accepting connections. Without `closeActiveConnections` it resolves once in-flight
		 * requests finish; with it, every connection is closed at once.
		 */
		stop: (closeActiveConnections?: boolean) => Promise<void>;
	}

	interface ServeOptions<T> {
		port?: number;
		hostname?: string;
		/** Seconds a connection may sit without traffic; 0 disables. */
		idleTimeout?: number;
		maxRequestBodySize?: number;
		fetch: (request: Request, server: Server) => Response | Promise<Response>;
		websocket?: WebSocketHandler<T>;
	}

	function serve<T = undefined>(options: ServeOptions<T>): Server;
}
