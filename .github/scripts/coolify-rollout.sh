#!/usr/bin/env bash
# Asks Coolify to deploy the gateway and the dashboard, and waits until each deployment
# ends. Exits non-zero unless both finish. Used by deploy-production.yml, for a release and for
# the return to what was serving.
#
# Reads COOLIFY_URL, COOLIFY_TOKEN (permissions `deploy` and `read`) and RESOURCES, the JSON map of
# app to Coolify resource UUID. Prints deployment ids and statuses, never the token. The ids it
# queues are kept in deployments.txt in the working directory.
#
# With --settle it deploys nothing: it cancels the deployments in deployments.txt that are still
# queued or running and waits until none is, so the return to what was serving is not refused as
# "already queued".
set -euo pipefail

api="${COOLIFY_URL%/}/api/v1"
timeout_seconds="${ROLLOUT_TIMEOUT_SECONDS:-1200}"

call() {
	local method=$1 path=$2 status
	status=$(curl -sS -o response.json -w '%{http_code}' -X "$method" \
		--max-time 30 \
		-H "Authorization: Bearer $COOLIFY_TOKEN" \
		-H "Accept: application/json" \
		"$api$path")
	if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
		if [ -z "${QUIET:-}" ]; then
			echo "::error::Coolify answered HTTP $status to $method ${path%%\?*}"
			cat response.json >&2 || true
		fi
		return 1
	fi
}

# A read that fails for a transient reason (network, 5xx, rate limit) is tried again: one flaky poll
# must not abort a rollout that is going fine and leave production half-deployed. A 4xx other than
# 429 is an answer, not a hiccup, and is returned at once.
poll() {
	local path=$1 attempt status
	for attempt in 1 2 3 4 5; do
		status=$(curl -sS -o response.json -w '%{http_code}' -X GET 			--max-time 30 			-H "Authorization: Bearer $COOLIFY_TOKEN" 			-H "Accept: application/json" 			"$api$path" || echo 000)
		if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
			return 0
		fi
		if [ "$status" -ge 400 ] && [ "$status" -lt 500 ] && [ "$status" -ne 429 ]; then
			break
		fi
		[ "$attempt" -lt 5 ] && sleep $((attempt * 5))
	done
	if [ -z "${QUIET:-}" ]; then
		echo "::error::Coolify answered HTTP $status to GET ${path%%\?*}"
		cat response.json >&2 || true
	fi
	return 1
}

# An id Coolify never ran (see "already queued" below) is not found, which counts as not running.
running() {
	QUIET=1 poll "/deployments/$1" || return 1
	case "$(jq -r '.status // "unknown"' response.json)" in
		queued | in_progress) return 0 ;;
		*) return 1 ;;
	esac
}

settle() {
	[ -s deployments.txt ] || return 0
	local deadline=$((SECONDS + 300)) deployment pending
	while read -r deployment; do
		if running "$deployment"; then
			call POST "/deployments/${deployment}/cancel" && echo "Cancelled deployment $deployment." || true
		fi
	done < deployments.txt
	while :; do
		pending=0
		while read -r deployment; do
			if running "$deployment"; then pending=1; fi
		done < deployments.txt
		[ "$pending" -eq 0 ] && return 0
		if [ "$SECONDS" -ge "$deadline" ]; then
			echo "::error::Earlier deployments are still running after 300s."
			return 1
		fi
		sleep 10
	done
}

if [ "${1:-}" = "--settle" ]; then
	settle
	exit
fi

uuids=$(printf '%s' "$RESOURCES" | jq -r '[.gateway, .dashboard] | unique | join(",")')
expected=$(printf '%s' "$RESOURCES" | jq '[.gateway, .dashboard] | unique | length')

# One request for all three. `force=false`: the images are already built, Coolify only pulls.
call POST "/deploy?uuid=${uuids}&force=false"
cat response.json
echo
jq -r '.deployments[]?.deployment_uuid // empty' response.json > deployments.txt

# Coolify answers a resource that is already deploying with a fresh id it never runs; only the
# message tells the two apart, so that counts as a failure rather than a deployment to wait for.
if jq -e '[.deployments[]? | select((.message // "") | test("already queued"; "i"))] | length > 0' response.json >/dev/null; then
	echo "::error::Coolify already has a deployment queued or running for one of the resources."
	exit 1
fi
mapfile -t deployments < deployments.txt
if [ "${#deployments[@]}" -ne "$expected" ]; then
	echo "::error::Coolify queued ${#deployments[@]} deployments for $expected resources."
	exit 1
fi

deadline=$((SECONDS + timeout_seconds))
failed=0
for deployment in "${deployments[@]}"; do
	while :; do
		if ! poll "/deployments/${deployment}"; then
			echo "::error::Coolify stopped answering about deployment $deployment."
			failed=1
			break
		fi
		status=$(jq -r '.status // "unknown"' response.json)
		case "$status" in
			finished)
				echo "Deployment $deployment finished."
				break
				;;
			queued | in_progress)
				if [ "$SECONDS" -ge "$deadline" ]; then
					echo "::error::Deployment $deployment is still $status after ${timeout_seconds}s; cancelling it."
					call POST "/deployments/${deployment}/cancel" || true
					failed=1
					break
				fi
				sleep 10
				;;
			*)
				echo "::error::Deployment $deployment ended as '$status'. Its log is in Coolify."
				failed=1
				break
				;;
		esac
	done
done

exit "$failed"
