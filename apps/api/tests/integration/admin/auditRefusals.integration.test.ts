import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { issueSession } from "#auth/session.ts";
import { adminAudit } from "#db/schema.ts";
import { adminApp } from "#admin/index.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

import {
	createDashboardUser,
	deleteDashboardUser,
} from "#db/repos/dashboardUsers.ts";

const skip =
	(await Promise.all([pgAvailable(), redisAvailable()])).every(Boolean) &&
	env.DASH_ENABLED
		? false
		: "Postgres/Redis or the dashboard unavailable";

test("a refused admin change is audited", { skip }, async () => {
	const app = makeGatewayTestApp((a) => {
		a.route("/admin", adminApp);
	});
	const user = await createDashboardUser({
		username: `audit-${randomUUID().slice(0, 8)}`,
		passwordHash: "x",
		role: "viewer",
		createdBy: "root",
	});
	try {
		const issued = await issueSession({
			userId: user.id,
			userEpoch: user.sessionEpoch,
			role: "viewer",
			ip: null,
			userAgent: null,
		});
		const response = await app.request("/admin/keys", {
			method: "POST",
			headers: {
				cookie: `ai_gateway_session=${issued.token}; ai_gateway_csrf=${issued.csrfToken}`,
				"x-csrf-token": issued.csrfToken,
				"content-type": "application/json",
			},
			body: JSON.stringify({ name: "nope" }),
		});
		assert.equal(response.status, 403);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const rows = await db
			.select()
			.from(adminAudit)
			.where(eq(adminAudit.actor, `user:${user.id}`));
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.status, 403);
	} finally {
		await deleteDashboardUser(user.id);
	}
});
