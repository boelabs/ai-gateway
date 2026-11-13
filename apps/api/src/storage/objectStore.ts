import { DisabledObjectStore } from "./disabledObjectStore.ts";
import { LocalObjectStore } from "./localObjectStore.ts";
import { S3ObjectStore } from "./s3ObjectStore.ts";
import type { ObjectStore } from "./objects.ts";
import { objectStorage } from "./config.ts";
import { join } from "node:path";

export { contentTypeForKey, type ObjectRange } from "./objects.ts";

let singleton: ObjectStore | undefined;

export function getObjectStore(): ObjectStore {
	if (singleton) {
		return singleton;
	}
	switch (objectStorage.backend) {
		case "local":
			singleton = new LocalObjectStore(objectStorage.root);
			break;
		case "s3":
			singleton = new S3ObjectStore(objectStorage);
			break;
		default:
			singleton = new DisabledObjectStore();
			break;
	}
	return singleton;
}

export function objectKey(namespace: string, parts: string[]): string {
	return join(namespace, ...parts).replaceAll("\\", "/");
}
