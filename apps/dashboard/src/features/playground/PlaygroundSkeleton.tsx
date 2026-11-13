"use client";

import { ModelSelectSkeleton } from "./ModelSelect";
import { Composer } from "./Composer";

const idle = () => undefined;

/**
 * The playground while its catalog loads: the page with the data taken out.
 *
 * Every wrapper below is the one the empty chat renders (`Playground` → `TextWorkspace` →
 * `ChatSession`), class for class, and the composer is the real one with its controls ghosted where
 * they stand — so when the page arrives, nothing moves: not the title, not the pill, not the row.
 */
export function PlaygroundSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading playground"
			className="flex h-full min-h-0 flex-col"
			data-fill-viewport=""
			role="status"
		>
			{/* TextWorkspace */}
			<div className="mx-auto flex min-h-0 w-full flex-1 flex-col">
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{/* ChatSession, empty */}
					<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
						<div className="min-h-0 flex-1 pt-6">
							<div className="flex h-full items-center justify-center px-4 pb-8 sm:hidden">
								<h2 className="text-center text-2xl font-medium tracking-tight sm:text-3xl">
									Playground
								</h2>
							</div>
						</div>
						<div className="relative mx-auto w-full shrink-0 px-2 pt-3 pb-3 sm:absolute sm:top-1/2 sm:left-1/2 sm:max-w-[calc(var(--container-2xl)+3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:px-6 xl:max-w-[calc(var(--container-3xl)+3rem)]">
							<h2 className="mb-6 hidden text-center text-3xl font-medium tracking-tight sm:block">
								Playground
							</h2>
							<div aria-hidden inert>
								<Composer
									accepted={[]}
									busy={false}
									files={[]}
									loading
									modelPicker={<ModelSelectSkeleton />}
									onFiles={idle}
									onPrompt={idle}
									onRemove={idle}
									onReset={idle}
									onSend={idle}
									onSettings={idle}
									onStop={idle}
									prompt=""
									reading={false}
									readOnly
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
