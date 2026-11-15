/**
 * Narrow ambient declaration for the Bun globals the source uses: `Bun.password` (Argon2id hashing
 * in auth/password.ts) and `Bun.S3Client` (object storage in storage/s3ObjectStore.ts).
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
}
