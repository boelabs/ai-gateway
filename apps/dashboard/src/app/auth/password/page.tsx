import { ChangePasswordForm } from "#/features/auth/ChangePasswordForm.tsx";
import { Card, CardHeader, CardContent } from "#/components/ui/card";
import { currentSessionIfReachable } from "#/features/auth/api.ts";
import { AiGatewayLogo } from "#/shared/components/AiGatewayLogo";
import { ThemeSelect } from "#/shared/theme/ThemeSelect.tsx";
import { redirect } from "next/navigation";

/**
 * Where an operator whose password was set by someone else lands: the gateway refuses their session
 * everything but this change. Like the login screen it blocks rather than streaming.
 */
export const instant = false;

export default async function ChangePasswordPage() {
	const identity = await currentSessionIfReachable();
	if (!identity) {
		redirect("/auth");
	}
	if (!identity.user.mustChangePassword) {
		redirect("/");
	}

	return (
		<main className="relative grid min-h-dvh place-items-center bg-muted/30 p-6">
			<div className="absolute top-4 right-4 w-28">
				<ThemeSelect />
			</div>
			<div className="flex w-full max-w-sm flex-col gap-6">
				<div className="flex justify-center">
					<AiGatewayLogo size={28} />
				</div>
				<Card>
					<CardHeader>
						<h1 className="text-xl font-semibold">Change your password</h1>
						<p className="text-sm text-muted-foreground">
							Your password was set by an administrator. Choose a new one to
							continue.
						</p>
					</CardHeader>
					<CardContent>
						<ChangePasswordForm />
					</CardContent>
				</Card>
			</div>
		</main>
	);
}
