import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { issueSession, resolveSession } from "#auth/session.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createDashboardUser,
	deleteDashboardUser,
	updateDashboardUser,
} from "#db/repos/dashboardUsers.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

async function user() {
	return createDashboardUser({
		username: `epoch-${randomUUID().slice(0, 8)}`,
		passwordHash: "x",
		role: "admin",
		createdBy: "root",
	});
}

test("a session issued before a role, password or enabled change stops resolving", {
	skip,
}, async () => {
	for (const patch of [
		{ role: "viewer" as const },
		{ passwordHash: "y" },
		{ enabled: true },
	]) {
		const row = await user();
		try {
			// Issued with the epoch read at login, as a login racing the change would be.
			const issued = await issueSession({
				userId: row.id,
				userEpoch: row.sessionEpoch,
				role: row.role,
				ip: null,
				userAgent: null,
			});
			await updateDashboardUser(row.id, patch);
			assert.equal(
				await resolveSession(issued.token),
				null,
				JSON.stringify(patch),
			);
		} finally {
			await deleteDashboardUser(row.id);
		}
	}
});

test("the role comes from the user row, not the session snapshot", {
	skip,
}, async () => {
	const row = await user();
	try {
		const issued = await issueSession({
			userId: row.id,
			userEpoch: row.sessionEpoch,
			role: "owner",
			ip: null,
			userAgent: null,
		});
		assert.equal((await resolveSession(issued.token))?.role, "admin");
		// Unrelated changes keep the session.
		await updateDashboardUser(row.id, { mustChangePassword: true });
	} finally {
		await deleteDashboardUser(row.id);
	}
});
