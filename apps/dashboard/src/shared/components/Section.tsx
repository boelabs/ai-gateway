import type { ReactNode } from "react";

/** A titled block of a page, above its own panels or table. */
export function Section({
	title,
	description,
	action,
	children,
}: {
	title: ReactNode;
	/** One line under the title, about the whole section. */
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 flex-col">
					<h2 className="text-base font-semibold">{title}</h2>
					{description ? (
						<p className="text-sm text-muted-foreground">{description}</p>
					) : null}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}
